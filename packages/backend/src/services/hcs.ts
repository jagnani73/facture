/**
 * Refusal receipts on the Hedera Consensus Service.
 *
 * The product's central claim is that an ineligible pairing is an *answer* rather than a
 * failed transaction, and that the funder can check that answer **without trusting the
 * venue**. The first half has been true for a while: a refusal names both sides of the
 * comparison that failed, in words, and the receipt outlives the request. The second half
 * was not. `refusal_receipts` has carried `hcs_topic_id` and `hcs_sequence_number` since the
 * first migration, the proof view renders a link off them, and the seed fills them in — and
 * nothing has ever written to a topic. This is the writer.
 *
 * ## What is published is a commitment, not the receipt
 *
 * The obvious design puts the refusal on the topic and is wrong. A refusal sentence names
 * the debtor and the amounts — *"this mandate caps exposure to Petra Foods Group at $40,000
 * and only $5,035 of that is left"* — and a topic is public. Publishing that would broadcast
 * one buyer's positions and one seller's customers to anyone reading the stream, which is a
 * worse failure than the one being fixed: bids are public in this market, but a buyer's
 * exposure is not, and the book already refuses to leak it (`api-source.ts` says so).
 *
 * So the message carries a **digest** of the receipt and an opaque receipt id, and nothing
 * else. The venue hands the refused party their own receipt; they hash it the same way and
 * check it against the digest the topic recorded at that sequence number. The venue cannot
 * later claim it gave a different reason, and a reader of the topic learns nothing but that
 * *a* refusal happened.
 *
 * The digest is over a canonical JSON form with the fields in a fixed order, because
 * `JSON.stringify` on an object is only stable if the key order is — and a digest that
 * depends on key insertion order is a digest that stops verifying for no visible reason.
 *
 * ## Consensus is attached afterwards, and may never arrive
 *
 * The receipt is written to the database first and the topic message is submitted after,
 * exactly as the maturity payout separates the obligation from the payment. A refused funder
 * can read their reason immediately; the independently checkable copy attaches when
 * consensus lands. If submission fails the receipt keeps its reason and its `hcs_*` columns
 * stay null, and the proof view renders no link rather than a broken one — so the honest
 * claim is that a refusal is always recorded and is checkable wherever consensus was
 * reached, not that every refusal is on chain.
 */

import { createHash } from 'node:crypto';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

/** The fields a receipt is committed to, in the order they are hashed. */
export interface RefusalCommitment {
  receiptId: string;
  invoiceId: string;
  mandateId: string;
  buyerId: string;
  reasonCode: string;
  reasonText: string;
  ratingAtRefusal: string;
  tenorDaysAtRefusal: number;
}

export interface PublishedRefusal {
  topicId: string;
  sequenceNumber: bigint;
  consensusAt: Date;
}

export interface HcsPublisher {
  /** Whether a topic is configured. False means refusals are recorded but not committed. */
  readonly enabled: boolean;
  publish(commitment: RefusalCommitment): Promise<PublishedRefusal>;
}

export interface HcsPublisherConfig {
  readonly topicId: string | undefined;
  readonly operatorId: string;
  readonly operatorKey: string;
  readonly network: string;
  readonly logger?: Logger | undefined;
}

/**
 * The canonical bytes a digest is taken over.
 *
 * Field order is fixed here and must never be reordered: every digest already published was
 * taken over this order, and changing it silently invalidates every receipt anyone has been
 * given. Adding a field at the end is the only safe change, and it still needs a version
 * bump so a verifier can tell which shape it is checking.
 */
export function canonicalise(c: RefusalCommitment): string {
  return JSON.stringify([
    c.receiptId,
    c.invoiceId,
    c.mandateId,
    c.buyerId,
    c.reasonCode,
    c.reasonText,
    c.ratingAtRefusal,
    c.tenorDaysAtRefusal,
  ]);
}

export function refusalDigest(c: RefusalCommitment): string {
  return createHash('sha256').update(canonicalise(c), 'utf8').digest('hex');
}

/** What actually goes on the topic. Deliberately small, and deliberately not the reason. */
export function refusalMessage(c: RefusalCommitment): string {
  return JSON.stringify({
    v: 1,
    kind: 'facture.refusal',
    receiptId: c.receiptId,
    digest: refusalDigest(c),
  });
}

/**
 * No topic configured.
 *
 * Refuses naming the variable, in the same shape as issuance with no ATS factory. The
 * caller treats a failure as "no consensus copy" rather than as a failed refusal, so this
 * never costs a funder their reason.
 */
export function createDisabledHcsPublisher(): HcsPublisher {
  return {
    enabled: false,
    publish: () =>
      Promise.reject(
        badRequest(
          'Publishing a refusal receipt needs a topic. HCS_REFUSAL_TOPIC_ID is not set, so ' +
            'refusals are recorded but not committed to consensus on this deployment.',
        ),
      ),
  };
}

export function createHcsPublisher(config: HcsPublisherConfig): HcsPublisher {
  if (config.topicId === undefined) return createDisabledHcsPublisher();

  const topicId = config.topicId;
  const log = (config.logger ?? rootLogger).child({ svc: 'hcs' });

  return {
    enabled: true,

    async publish(commitment) {
      const { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } =
        await import('@hiero-ledger/sdk');

      const client = Client.forName(config.network).setOperator(
        AccountId.fromString(config.operatorId),
        PrivateKey.fromStringECDSA(config.operatorKey),
      );

      try {
        const response = await new TopicMessageSubmitTransaction()
          .setTopicId(TopicId.fromString(topicId))
          .setMessage(refusalMessage(commitment))
          .execute(client);

        /*
         * The receipt is what carries the sequence number, and the sequence number is the
         * whole point — it is the coordinate a refused party is given so they can find their
         * own commitment without reading the entire topic.
         */
        const receipt = await response.getReceipt(client);
        const record = await response.getRecord(client);
        const sequenceNumber = BigInt(receipt.topicSequenceNumber?.toString() ?? '0');

        // The coordinate a refused party is handed. Worth a line: it is the only way to find
        // one commitment again without reading the whole topic.
        log.info('refusal committed to consensus', {
          receiptId: commitment.receiptId,
          topicId,
          sequenceNumber: sequenceNumber.toString(),
        });

        return { topicId, sequenceNumber, consensusAt: record.consensusTimestamp.toDate() };
      } finally {
        client.close();
      }
    },
  };
}

let publisher: HcsPublisher | undefined;

export function initHcsPublisher(config: HcsPublisherConfig): HcsPublisher {
  publisher = createHcsPublisher(config);
  return publisher;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setHcsPublisher(next: HcsPublisher | undefined): void {
  publisher = next;
}

export function getHcsPublisher(): HcsPublisher {
  if (!publisher) throw new Error('HCS publisher accessed before initHcsPublisher().');
  return publisher;
}

/**
 * Publish a batch of receipts, attaching consensus to each as it lands.
 *
 * Never throws. A topic that will not accept a message is a receipt without a consensus
 * copy, which is a smaller failure than a refused trade — and turning it into one would mean
 * a funder loses the answer they were owed because an unrelated service was down.
 */
export async function publishRefusals(
  receipts: readonly RefusalCommitment[],
  onPublished: (receiptId: string, published: PublishedRefusal) => Promise<void>,
  logger: Logger = rootLogger,
): Promise<number> {
  const hcs = getHcsPublisher();
  if (!hcs.enabled || receipts.length === 0) return 0;

  const log = logger.child({ svc: 'hcs' });
  let published = 0;

  for (const receipt of receipts) {
    try {
      const result = await hcs.publish(receipt);
      await onPublished(receipt.receiptId, result);
      published += 1;
    } catch (err) {
      // Deliberately not rethrown. See the note above.
      log.warn('refusal receipt not committed to consensus', {
        receiptId: receipt.receiptId,
        err,
      });
    }
  }

  return published;
}
