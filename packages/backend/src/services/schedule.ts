/**
 * The maturity payout rail, as a Hedera Scheduled Transaction.
 *
 * ## Why there has to be a collection account
 *
 * A debtor in this market has no wallet, and that is not an omission — it is the thing
 * that makes debtor confirmation work at all. The customer is asked to acknowledge their
 * own accounts payable through a link carrying one sentence and two buttons, with no
 * signup wall in front of it. Give them a key to manage and the behavioural argument
 * collapses.
 *
 * So the money that settles a matured receivable cannot be a transfer signed by the
 * debtor. It arrives the way it arrives at a factoring house: into a collection account
 * the venue operates, off-chain, by whatever rail the debtor already uses. What this
 * module does is make the *obligation* an on-chain object the moment the receivable
 * matures, and let the payment execute against it when the money is actually there.
 *
 * ## Why the schedule stays unsigned
 *
 * A `ScheduleCreateTransaction` executes as soon as its required signatures are present.
 * If the venue both created the schedule and funded it from the operator account, the
 * operator's signature on the create would satisfy the transfer immediately and the payout
 * would fire on the spot — putting a settled payment on the proof view that no debtor had
 * made. That is the failure this design exists to avoid.
 *
 * The transfer therefore debits a **collection account that is not the operator**. The
 * schedule is created by the operator, sits on the ledger unsigned, and carries the whole
 * obligation in public: who is owed, how much, against which receivable. It executes only
 * when the collection key signs, which is the venue's on-chain statement that the debtor's
 * payment landed. Until then the cash leg is `pending`, and it is `pending` with a
 * schedule id anyone can look up rather than `pending` with nothing behind it.
 *
 * ## What is deliberately not here
 *
 * - **No expiration time is set.** Long-term scheduled transactions are a network-gated
 *   feature and `setExpirationTime` is rejected where they are not enabled. The default
 *   schedule lifetime applies instead. This is untested against Hedera testnet from here,
 *   and the honest note is that a production collection window is longer than that default
 *   — so this is the first thing to revisit once the path has run for real.
 * - **HBAR only.** An HTS payout is two more lines, but every HTS token requires explicit
 *   association by the receiver before it can be received, so an HTS rail owes the holder
 *   an association step that does not exist yet. Refusing loudly beats scheduling a
 *   transfer that will fail at execution, long after this function returned success.
 * - **Nothing is signed here.** Signing is the act that says the debtor paid, and it is not
 *   this module's to perform as a side effect of maturity.
 */

import { hedera } from '../chain.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';
import { upstreamUnavailable } from '../errors.js';

/** What maturity asks the rail to arrange. */
export interface MaturityPayoutRequest {
  invoiceId: string;
  tradeId: string;
  /**
   * Who is owed. Accepts either Hedera form: a native `0.0.x` id, or an EVM address, which
   * is resolved through the mirror node. Buyers were recorded in both shapes.
   */
  payeeAccount: string;
  /** Face value, already converted to the settlement asset's smallest units. */
  amountMinor: bigint;
}

/** The obligation, once it exists on the ledger. */
export interface MaturityPayoutReceipt {
  /** `0.0.x` of the schedule. This is the thing a holder can look up. */
  scheduleId: string;
  /** The `ScheduleCreate` transaction that put it there. */
  transactionId: string;
  consensusAt: string;
  /** Who pays when it executes. */
  payerAccountId: string;
  /** Who is paid, as a native id. */
  payeeAccountId: string;
  amountMinor: string;
  /**
   * Whether the scheduled transfer has run.
   *
   * False on creation, and it must be: a true here on the maturity path would mean the
   * payout fired without anyone signing for the debtor's money.
   */
  executed: boolean;
}

/** Whether an obligation has become a payment, read off the ledger rather than assumed. */
export interface MaturityPayoutStatus {
  executed: boolean;
  /** Consensus time of the transfer, ISO. */
  executedAt: string | null;
  /** The executed transfer, `0.0.x@seconds.nanos`, for an explorer link. */
  transactionId: string | null;
  /** Which account the money actually left, read off the transfer rather than configured. */
  payerAccountId: string | null;
  /** Which account it arrived in, likewise read off the transfer. */
  payeeAccountId: string | null;
}

export interface ScheduleAdapter {
  /**
   * Arrange the payout for a matured receivable.
   *
   * Returns `null` when no collection account is configured. That is the truthful answer
   * for a deployment with no rail — maturity still names the holder, writes the outcome and
   * frees the mandate's capital, and the cash leg stays `pending` with nothing attached.
   * Returning a fabricated schedule id would be worse than returning nothing.
   */
  schedulePayout(request: MaturityPayoutRequest): Promise<MaturityPayoutReceipt | null>;

  /**
   * Has the obligation been signed and executed?
   *
   * Asked rather than remembered. The signature happens outside this service — it is the
   * venue's statement that the debtor's money arrived — so the only honest source for
   * whether the holder has been paid is the ledger. The alternative is a flag this service
   * sets when it *thinks* the payment happened, which is the kind of claim the proof view
   * exists to avoid.
   *
   * Free: both reads are mirror-node queries, not paid SDK queries.
   */
  payoutStatus(scheduleId: string): Promise<MaturityPayoutStatus>;
}

/** Not executed, and not claiming to know otherwise. */
const UNKNOWN_STATUS: MaturityPayoutStatus = {
  executed: false,
  executedAt: null,
  transactionId: null,
  payerAccountId: null,
  payeeAccountId: null,
};

export interface ScheduleAdapterConfig {
  operatorId: string;
  operatorKey: string;
  network: string;
  /** Unset disables the rail. Must not be the operator — see the note at the top. */
  collectionAccountId: string | undefined;
  /** `hbar` or `hts`; only `hbar` is carried today. */
  assetMode: 'hbar' | 'hts';
  logger?: Logger;
}

/**
 * Reads whether a schedule has executed, and what transfer it produced.
 *
 * Shared by the live and the disabled adapters on purpose: a schedule id recorded by an
 * earlier run is still a real obligation on the ledger even if this deployment no longer
 * has a collection account configured, and refusing to look it up would hide a payment that
 * actually happened.
 */
async function readPayoutStatus(scheduleId: string): Promise<MaturityPayoutStatus> {
  try {
    const response = await fetch(`${hedera.mirrorNodeUrl}/api/v1/schedules/${scheduleId}`);
    if (!response.ok) return UNKNOWN_STATUS;
    const body: unknown = await response.json();
    const executedAt = (body as { executed_timestamp?: unknown }).executed_timestamp;
    if (typeof executedAt !== 'string' || executedAt === '') return UNKNOWN_STATUS;

    /*
     * The executed transfer carries the ScheduleCreate's own transaction id with
     * `scheduled: true`, which the schedule record does not repeat — so it is looked up by
     * the consensus timestamp the schedule reports. The id comes back dash-separated and
     * every explorer here wants `0.0.x@seconds.nanos`.
     */
    const at = await fetch(`${hedera.mirrorNodeUrl}/api/v1/transactions?timestamp=${executedAt}`);
    let transactionId: string | null = null;
    let payerAccountId: string | null = null;
    let payeeAccountId: string | null = null;
    if (at.ok) {
      const page: unknown = await at.json();
      const first = (
        page as {
          transactions?: {
            transaction_id?: unknown;
            transfers?: { account?: unknown; amount?: unknown }[];
          }[];
        }
      ).transactions?.[0];

      const raw = first?.transaction_id;
      if (typeof raw === 'string') {
        const match = raw.match(/^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/);
        transactionId = match ? `${match[1]}@${match[2]}.${match[3]}` : raw;
      }

      /*
       * Both sides of the payout, taken as the largest debit and the largest credit on the
       * transfer. The scheduled transfer carries exactly those two — its fees are charged on
       * the separate ScheduleSign — so this is not a heuristic over a busy transaction.
       *
       * Read off the ledger rather than taken from configuration or from the buyer row: a
       * schedule created under an earlier collection account would otherwise be reported
       * against the current one, and the payee is the account that was actually credited
       * rather than whichever of its two Hedera forms happens to be on file.
       */
      let lowest = 0;
      let highest = 0;
      for (const entry of first?.transfers ?? []) {
        const amount = typeof entry.amount === 'number' ? entry.amount : 0;
        if (typeof entry.account !== 'string') continue;
        if (amount < lowest) {
          lowest = amount;
          payerAccountId = entry.account;
        }
        if (amount > highest) {
          highest = amount;
          payeeAccountId = entry.account;
        }
      }
    }

    const [seconds, nanos] = executedAt.split('.');
    const millis = Number(seconds) * 1000 + Math.floor(Number(nanos ?? 0) / 1_000_000);
    return {
      executed: true,
      executedAt: new Date(millis).toISOString(),
      transactionId,
      payerAccountId,
      payeeAccountId,
    };
  } catch {
    // A mirror node that cannot be reached is not evidence a payout did not happen.
    return UNKNOWN_STATUS;
  }
}

/** No collection account, so no rail, and maturity says so rather than inventing one. */
export function createDisabledScheduleAdapter(): ScheduleAdapter {
  return {
    schedulePayout: () => Promise.resolve(null),
    payoutStatus: readPayoutStatus,
  };
}

export function createScheduleAdapter(config: ScheduleAdapterConfig): ScheduleAdapter {
  const collectionAccountId = config.collectionAccountId;
  if (collectionAccountId === undefined) return createDisabledScheduleAdapter();

  const log = (config.logger ?? rootLogger).child({ svc: 'schedule' });

  /*
   * The one configuration that is worse than having no rail: a collection account that is
   * the operator. The operator signs the `ScheduleCreate`, so the transfer's required
   * signature would already be present and the payout would execute on creation. That
   * turns "the obligation exists" into "the debtor paid" silently, which is the exact claim
   * this rail is built not to make.
   */
  if (collectionAccountId === config.operatorId) {
    log.error('collection account is the operator; the rail is disabled', {
      collectionAccountId,
    });
    return createDisabledScheduleAdapter();
  }

  if (config.assetMode !== 'hbar') {
    log.error('only an HBAR payout is carried; the rail is disabled', {
      assetMode: config.assetMode,
    });
    return createDisabledScheduleAdapter();
  }

  return {
    async schedulePayout(request) {
      const {
        AccountId,
        Client,
        Hbar,
        PrivateKey,
        ScheduleCreateTransaction,
        TransferTransaction,
      } = await import('@hiero-ledger/sdk');

      const payeeAccountId = await resolveAccountId(request.payeeAccount);
      if (payeeAccountId === null) {
        throw upstreamUnavailable(
          'Hedera',
          `The current holder's account ${request.payeeAccount} could not be resolved to a ` +
            '0.0.x id, so there is nobody to address the payout to.',
        );
      }

      const client = Client.forName(config.network).setOperator(
        AccountId.fromString(config.operatorId),
        PrivateKey.fromStringECDSA(config.operatorKey),
      );

      try {
        /*
         * The memo is what a holder reads on the mirror node without access to this
         * service, so it names the receivable rather than a trade uuid. Hedera caps a memo
         * at 100 bytes and rejects a longer one outright, so it is truncated here rather
         * than at the ledger.
         */
        const memo = `Facture maturity ${request.invoiceId}`.slice(0, 100);

        /*
         * Tinybars cross into the SDK as decimal **strings**, never as numbers. `Hbar`
         * takes `string | number | Long | BigNumber` and not `bigint`, and a `number` is an
         * IEEE-754 double — exact only below 2^53, which an HBAR-denominated amount at 8
         * decimals passes without anything looking wrong. This is the same rule `wire.ts`
         * enforces at the HTTP boundary, applied at the ledger boundary.
         */
        const debit = (-request.amountMinor).toString(10);
        const credit = request.amountMinor.toString(10);

        const transfer = new TransferTransaction()
          .addHbarTransfer(AccountId.fromString(collectionAccountId), Hbar.fromTinybars(debit))
          .addHbarTransfer(AccountId.fromString(payeeAccountId), Hbar.fromTinybars(credit))
          .setTransactionMemo(memo);

        const response = await new ScheduleCreateTransaction()
          .setScheduledTransaction(transfer)
          .setScheduleMemo(memo)
          .execute(client);

        const record = await response.getRecord(client);
        const scheduleId = record.receipt.scheduleId;
        if (scheduleId === null) {
          throw upstreamUnavailable('Hedera', 'ScheduleCreate returned no schedule id.');
        }

        const receipt: MaturityPayoutReceipt = {
          scheduleId: scheduleId.toString(),
          transactionId: record.transactionId.toString(),
          consensusAt: record.consensusTimestamp.toDate().toISOString(),
          payerAccountId: collectionAccountId,
          payeeAccountId,
          amountMinor: request.amountMinor.toString(10),
          executed: false,
        };

        log.info('maturity payout scheduled', {
          invoiceId: request.invoiceId,
          tradeId: request.tradeId,
          scheduleId: receipt.scheduleId,
          payeeAccountId,
          amountMinor: receipt.amountMinor,
        });

        return receipt;
      } finally {
        client.close();
      }
    },

    payoutStatus: readPayoutStatus,
  };
}

/**
 * `0.0.x` for either Hedera form.
 *
 * Buyers were recorded inconsistently — three carry a native id and one carries its EVM
 * address in the same column — and a `TransferTransaction` only speaks the native form. The
 * mirror node is the only thing that can map an ECDSA alias back to an account number, and
 * the read is free, so it is asked rather than guessed. `null` when it cannot be resolved:
 * paying an invented account is worse than refusing to schedule.
 */
async function resolveAccountId(account: string): Promise<string | null> {
  if (/^\d+\.\d+\.\d+$/.test(account)) return account;
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return null;

  try {
    const response = await fetch(`${hedera.mirrorNodeUrl}/api/v1/accounts/${account}`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const id = (body as { account?: unknown }).account;
    return typeof id === 'string' && /^\d+\.\d+\.\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

let adapter: ScheduleAdapter | undefined;

export function initScheduleAdapter(config: ScheduleAdapterConfig): ScheduleAdapter {
  adapter = createScheduleAdapter(config);
  return adapter;
}

/** Test seam, matching `setAtsAdapter`. */
export function setScheduleAdapter(next: ScheduleAdapter | undefined): void {
  adapter = next;
}

/**
 * Resolved per call rather than captured, so a test that swaps the adapter after the
 * service module was imported is still seen.
 */
export function getScheduleAdapter(): ScheduleAdapter {
  return adapter ?? createDisabledScheduleAdapter();
}
