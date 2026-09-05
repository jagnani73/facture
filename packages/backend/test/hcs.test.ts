/**
 * Refusal receipts, and the two properties that make them worth having.
 *
 * **A tampered receipt must not verify.** The whole claim is that a refused funder can check
 * the venue's answer without trusting the venue, and that reduces to: the digest published at
 * their sequence number matches their receipt and matches no other. A commitment scheme that
 * accepts a changed reason is decoration.
 *
 * **The reason must not be on the topic.** A refusal sentence names the debtor and the
 * amounts, and a topic is public. Publishing one would broadcast a buyer's exposure and a
 * seller's customers to anyone reading the stream — a worse leak than the problem being
 * solved, and one the book already refuses elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO } from '../src/db/seed.js';
import { call, createHarness, type Harness } from './helpers.js';
import {
  canonicalise,
  canonicaliseMatch,
  createDisabledHcsPublisher,
  matchDigest,
  matchMessage,
  publishRefusals,
  refusalDigest,
  refusalMessage,
  setHcsPublisher,
  type HcsPublisher,
  type MatchCommitment,
  type RefusalCommitment,
} from '../src/services/hcs.js';

const RECEIPT: RefusalCommitment = {
  receiptId: '11111111-2222-4333-8444-555555555555',
  invoiceId: '4af57501-ba14-50b8-bc7f-11f07edfea13',
  mandateId: '76b9eb67-90c9-5706-b7dd-dbf1da446693',
  buyerId: '4c94a6a6-e8a2-59af-b244-b7f90c402a25',
  reasonCode: 'RATING_BELOW_MANDATE',
  reasonText: 'The customer is rated B, and this mandate takes A or better.',
  ratingAtRefusal: 'B',
  tenorDaysAtRefusal: 48,
};

/**
 * A settled match, committed to the same topic under its own kind.
 *
 * `trades.hcs_topic_id` and `hcs_sequence_number` existed from the first migration and the
 * proof view rendered a link off them the whole time, while **nothing wrote them** — so on
 * every trade the venue actually settled, that block was null.
 */
const MATCH: MatchCommitment = {
  tradeId: '3d129208-a99e-4667-bc4a-1d7bc5a537eb',
  invoiceId: '11111111-2222-4333-8444-555555555555',
  mandateId: '8b879d02-4593-4d66-82bf-52d4833401b6',
  buyerId: 'f888dd62-6df0-5600-925e-06469ef0aef6',
  sellerId: 'e37a8422-960d-5a77-9825-8964df79ed49',
  faceValue: '6230000',
  proceedsMinor: '6085000',
  rail: 'arc-vault',
  assetTransactionId: '0.0.10311549@1788345825.712636474',
};

describe('committing a match', () => {
  /*
   * Field order is a promise here for the same reason it is for a refusal: a digest anyone
   * has been handed stops verifying the moment the order changes, and a test that recomputed
   * the digest would agree with whatever the new code produced. Appending is the only safe
   * change, and it still needs the version bumped.
   */
  it('pins the field order the digest is taken over', () => {
    expect(canonicaliseMatch(MATCH)).toBe(
      JSON.stringify([
        MATCH.tradeId,
        MATCH.invoiceId,
        MATCH.mandateId,
        MATCH.buyerId,
        MATCH.sellerId,
        MATCH.faceValue,
        MATCH.proceedsMinor,
        MATCH.rail,
        MATCH.assetTransactionId,
      ]),
    );
  });

  it.each([
    ['the rail', { rail: 'x402' }],
    ['the price', { proceedsMinor: '6085001' }],
    ['the face value', { faceValue: '6230001' }],
    ['the buyer', { buyerId: '4c94a6a6-e8a2-59af-b244-b7f90c402a25' }],
    ['the asset transaction', { assetTransactionId: '0.0.1@1.2' }],
  ])('changes the digest when %s changes', (_label, patch) => {
    expect(matchDigest({ ...MATCH, ...patch })).not.toBe(matchDigest(MATCH));
  });

  /*
   * The terms stay off the topic. A topic is public, and a price and a customer are the same
   * two facts the refusal path already refuses to broadcast — the difference being that here
   * the venue is publishing about its own successful trade rather than someone's refusal, and
   * the reasoning does not change with the outcome.
   */
  it('publishes a digest and a trade id, never the terms', () => {
    const message = JSON.parse(matchMessage(MATCH)) as Record<string, unknown>;

    expect(message).toEqual({
      v: 1,
      kind: 'facture.match',
      tradeId: MATCH.tradeId,
      digest: matchDigest(MATCH),
    });
    const raw = matchMessage(MATCH);
    expect(raw).not.toContain(MATCH.proceedsMinor);
    expect(raw).not.toContain(MATCH.invoiceId);
    expect(raw).not.toContain(MATCH.buyerId);
  });

  /* A refusal and a match must never be mistaken for one another on a shared topic. */
  it('is a different kind from a refusal', () => {
    expect(JSON.parse(matchMessage(MATCH)).kind).toBe('facture.match');
    expect(JSON.parse(refusalMessage(RECEIPT)).kind).toBe('facture.refusal');
  });
});

describe('the commitment', () => {
  /*
   * The published digest for this exact receipt, taken from the message actually submitted to
   * topic 0.0.10342152 at sequence 1 on 2026-09-03. Pinned as a literal because the digest is
   * a promise already made to anyone holding that receipt: if this value ever changes, every
   * receipt issued before the change stops verifying, and the test should say so loudly rather
   * than recomputing whatever the new code produces and agreeing with itself.
   */
  it('produces the digest that is already on chain', () => {
    expect(refusalDigest(RECEIPT)).toBe(
      '572e74b3078c4c97fef5d87ba84095f81b44f738935f59bd015ae664524b8a3d',
    );
  });

  it.each([
    ['the reason text', { reasonText: 'The customer is rated B, and this mandate takes C.' }],
    ['the reason code', { reasonCode: 'TENOR_EXCEEDS_MANDATE' }],
    ['the rating', { ratingAtRefusal: 'A' }],
    ['the tenor', { tenorDaysAtRefusal: 47 }],
    ['the mandate', { mandateId: '00000000-0000-4000-8000-000000000000' }],
    ['the buyer', { buyerId: '00000000-0000-4000-8000-000000000000' }],
    ['the invoice', { invoiceId: '00000000-0000-4000-8000-000000000000' }],
    ['the receipt id', { receiptId: '00000000-0000-4000-8000-000000000000' }],
  ])('stops verifying when %s is changed', (_label, patch) => {
    expect(refusalDigest({ ...RECEIPT, ...patch })).not.toBe(refusalDigest(RECEIPT));
  });

  /*
   * The canonical form is an array, not an object, because `JSON.stringify` follows key
   * insertion order — so an object would make the digest depend on the order fields happened
   * to be written in, and a receipt built field-by-field elsewhere would hash differently
   * while being identical.
   */
  it('does not depend on the order fields were assigned in', () => {
    const reordered: RefusalCommitment = {
      tenorDaysAtRefusal: RECEIPT.tenorDaysAtRefusal,
      ratingAtRefusal: RECEIPT.ratingAtRefusal,
      reasonText: RECEIPT.reasonText,
      reasonCode: RECEIPT.reasonCode,
      buyerId: RECEIPT.buyerId,
      mandateId: RECEIPT.mandateId,
      invoiceId: RECEIPT.invoiceId,
      receiptId: RECEIPT.receiptId,
    };
    expect(canonicalise(reordered)).toBe(canonicalise(RECEIPT));
    expect(refusalDigest(reordered)).toBe(refusalDigest(RECEIPT));
  });
});

describe('what goes on the public topic', () => {
  it('carries the digest and the receipt id, and nothing else', () => {
    expect(JSON.parse(refusalMessage(RECEIPT))).toEqual({
      v: 1,
      kind: 'facture.refusal',
      receiptId: RECEIPT.receiptId,
      digest: refusalDigest(RECEIPT),
    });
  });

  /* The leak this design exists to prevent. */
  it('never carries the reason, the rating or the tenor', () => {
    const message = refusalMessage(RECEIPT);
    expect(message).not.toContain(RECEIPT.reasonText);
    expect(message).not.toContain(RECEIPT.reasonCode);
    expect(message).not.toContain('rated');
    expect(message).not.toContain(String(RECEIPT.tenorDaysAtRefusal));
  });

  it('does not name the mandate or the buyer', () => {
    const message = refusalMessage(RECEIPT);
    expect(message).not.toContain(RECEIPT.mandateId);
    expect(message).not.toContain(RECEIPT.buyerId);
  });
});

describe('publishRefusals', () => {
  const published: PublishedCall[] = [];
  interface PublishedCall {
    receiptId: string;
    sequenceNumber: bigint;
  }

  const workingTopic = (): HcsPublisher => ({
    enabled: true,
    publishMatch: () => Promise.reject(new Error('not under test here')),
    publish: (c) =>
      Promise.resolve({
        topicId: '0.0.10342152',
        sequenceNumber: BigInt(c.receiptId.length),
        consensusAt: new Date('2026-09-03T01:54:14.638Z'),
      }),
  });

  beforeEach(() => {
    published.length = 0;
  });

  afterEach(() => {
    setHcsPublisher(undefined);
  });

  const record = async (receiptId: string, p: { sequenceNumber: bigint }): Promise<void> => {
    published.push({ receiptId, sequenceNumber: p.sequenceNumber });
  };

  it('attaches consensus to each receipt', async () => {
    setHcsPublisher(workingTopic());
    const count = await publishRefusals([RECEIPT], record);

    expect(count).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.receiptId).toBe(RECEIPT.receiptId);
  });

  /*
   * The property that keeps a refusal a refusal. A topic that will not accept a message must
   * cost a consensus copy and nothing else — turning it into a thrown error would mean a
   * funder loses the answer they were owed because an unrelated service was down.
   */
  it('never throws when the topic refuses the message', async () => {
    setHcsPublisher({
      enabled: true,
      publishMatch: () => Promise.reject(new Error('not under test here')),
      publish: () => Promise.reject(new Error('INVALID_TOPIC_ID')),
    });

    await expect(publishRefusals([RECEIPT], record)).resolves.toBe(0);
    expect(published).toHaveLength(0);
  });

  it('does nothing at all when no topic is configured', async () => {
    setHcsPublisher(createDisabledHcsPublisher());

    await expect(publishRefusals([RECEIPT], record)).resolves.toBe(0);
    expect(published).toHaveLength(0);
  });

  it('refuses to publish, naming the variable, when unconfigured', async () => {
    await expect(createDisabledHcsPublisher().publish(RECEIPT)).rejects.toMatchObject({
      detail: expect.stringContaining('HCS_REFUSAL_TOPIC_ID'),
    });
  });
});

describe('the receipt a funder reads', () => {
  let h: Harness;

  beforeEach(async () => {
    // The seeded book is priced at its own `asOf`; a quote lives five minutes against the
    // real clock. Frozen so the assertion is about refusals rather than about wall time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(MARKET_NOW_ISO));
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    h.restore();
  });

  /*
   * The wiring in `routes/trades.ts`, with a topic that answers. Without this the publisher
   * is proven and the thing that calls it is not — which is the failure mode this codebase
   * keeps producing: a working mechanism nobody reaches.
   */
  it('attaches consensus coordinates to the receipts an arming produced', async () => {
    setHcsPublisher({
      enabled: true,
      publishMatch: () => Promise.reject(new Error('not under test here')),
      publish: () =>
        Promise.resolve({
          topicId: '0.0.10342152',
          sequenceNumber: 7n,
          consensusAt: new Date(MARKET_NOW_ISO),
        }),
    });

    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(
      h.app,
      'GET',
      `/v1/invoices/${invoiceId}/quote?asOf=${encodeURIComponent(MARKET_NOW_ISO)}`,
    );
    await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId, maxSlippageBps: 25 },
    });

    const receipts = [...h.store.refusals.values()].filter((r) => r.invoiceId === invoiceId);
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(receipt.hcsTopicId).toBe('0.0.10342152');
      expect(receipt.hcsSequenceNumber).toBe(7n);
      expect(receipt.hcsConsensusAt).not.toBeNull();
    }

    setHcsPublisher(undefined);
  });

  /*
   * With no topic configured the reason still has to be recorded and readable. Consensus is
   * the checkable copy, not the receipt itself, and losing one must never lose the other.
   */
  it('is recorded with its reason even when nothing is committed to consensus', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2047'] ?? h.seeded.invoiceIds['INV-2046'] ?? '';
    const res = await call(
      h.app,
      'GET',
      `/v1/invoices/${invoiceId}/quote?includeRefusals=true&asOf=${encodeURIComponent(MARKET_NOW_ISO)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.refusals.length).toBeGreaterThan(0);
    for (const refusal of res.body.refusals) {
      expect(refusal.humanReason).toMatch(/\S/);
      expect(refusal.code).toMatch(/^[A-Z_]+$/);
    }
  });
});
