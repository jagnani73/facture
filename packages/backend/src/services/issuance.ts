/**
 * Issuance: one ATS `deployBond` per invoice.
 *
 * Why this is a queue and not a function call. A single `deployBond` fans ~94 facet
 * initialisations into one transaction at ~7M gas — measured 6,978,091 in the default
 * configuration, 47% of Hedera's 15M per-transaction ceiling. Hedera throttles on
 * network gas throughput as well as per-transaction gas, so a seller adding twenty
 * invoices at once starts getting BUSY back long before any single deployment is
 * refused. Issuance therefore runs strictly serially with a pacing floor between
 * submissions and exponential backoff on throttling.
 *
 * This costs nothing, because issuance is already off the critical path: tokenisation
 * happens at onboarding, not at sale. The book shows an invoice as *being added* until
 * its instrument exists, and `state` here is exactly what the API reports.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { getStore } from '../db/store.js';
import type { Logger } from '../logger.js';
import { isinForInvoice } from '@facture/shared';
import { rootLogger } from '../logger.js';
import { getAtsAdapter } from './ats.js';

export type IssuanceState = 'queued' | 'issuing' | 'issued' | 'failed';

export interface IssuanceJob {
  invoiceId: string;
  /** Checksum-valid ISIN, generated ahead of time — ATS `onlyValidISIN` rejects strings. */
  isin: string;
  /**
   * ATS `onlyValidRegulation`: Reg D 506(b)/506(c) or Reg S. Never unset.
   *
   * Read from the invoice row and deployed as-is, so the row is a record of the paper
   * rather than a second opinion about it. It used to be carried this far and then
   * dropped — the adapter took a venue-wide value from config instead — and the two only
   * agreed because both happened to come from the same variable. Seeded rows did not:
   * MF-2052's row said Reg D 506(c) while its bond went out `1/0`, Reg S.
   */
  regulationType: 'reg-d-506b' | 'reg-d-506c' | 'reg-s';
  /** Invoice due date. Becomes the bond maturity; `initializeMaturity` is one-shot. */
  maturityAt: Date;
  /** Face value in minor units. Principal and face are the same number here. */
  faceValue: bigint;
  currency: string;
  name: string;
  symbol: string;
}

export interface DeployedSecurity {
  /** Native id of the deployed diamond, `0.0.x`. */
  securityId: string;
  evmAddress: `0x${string}`;
  /**
   * The ISIN the instrument was deployed with.
   *
   * Returned rather than assumed by the caller: the invoice row is what a proof view prints,
   * and leaving it null while an instrument exists puts a security on screen with no
   * identifier beside it. It is the job's own ISIN, carried back so the sink can write it.
   */
  isin: string;
  transactionId: string;
  gasUsed: number;
}

export interface IssuanceStatus {
  invoiceId: string;
  state: IssuanceState;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
  security: DeployedSecurity | null;
  lastError: string | null;
}

export interface IssuanceSnapshot {
  depth: number;
  inFlight: string | null;
  counts: Record<IssuanceState, number>;
  /** Wall clock of the last submission, for spotting a wedged worker mid-demo. */
  lastSubmissionAt: string | null;
}

export type DeployBond = (job: IssuanceJob) => Promise<DeployedSecurity>;

/**
 * Where queue state goes so it survives a restart.
 *
 * A seam rather than a direct store call because the queue's own mechanics — pacing,
 * backoff, the give-up rule — are what the tests are about, and none of them should need a
 * database. `createStoreIssuanceSink` is the real one.
 */
export interface IssuanceSink {
  persist(status: IssuanceStatus, job: IssuanceJob): Promise<void>;
}

export interface IssuanceQueueOptions {
  deploy: DeployBond;
  /** Pacing floor between submissions. Network gas throughput, not per-tx gas. */
  minIntervalMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  logger?: Logger;
  sink?: IssuanceSink;
}

/**
 * Hedera statuses that mean "come back later" rather than "this will never work".
 * Anything not listed here fails the job immediately — retrying an INVALID_ISIN twenty
 * times just delays telling the seller their invoice is unlistable.
 */
const RETRYABLE = [
  'BUSY',
  'THROTTLED_AT_CONSENSUS',
  'PLATFORM_NOT_ACTIVE',
  'PLATFORM_TRANSACTION_NOT_CREATED',
  'TRANSACTION_EXPIRED',
  'CONSENSUS_GAS_EXHAUSTED',
  'ETIMEDOUT',
  'ECONNRESET',
] as const;

export function isRetryable(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return RETRYABLE.some((status) => text.includes(status));
}

interface QueueEntry {
  job: IssuanceJob;
  status: IssuanceStatus;
}

export class IssuanceQueue {
  readonly #opts: IssuanceQueueOptions;
  readonly #log: Logger;
  readonly #pending: QueueEntry[] = [];
  readonly #byInvoice = new Map<string, QueueEntry>();
  #running = false;
  #stopped = false;
  #inFlight: string | null = null;
  #lastSubmissionAt: number | null = null;

  constructor(opts: IssuanceQueueOptions) {
    this.#opts = opts;
    this.#log = (opts.logger ?? rootLogger).child({ svc: 'issuance' });
  }

  /** Idempotent per invoice: re-enqueueing something already in flight is a no-op. */
  enqueue(job: IssuanceJob): IssuanceStatus {
    const existing = this.#byInvoice.get(job.invoiceId);
    if (existing && existing.status.state !== 'failed') return existing.status;

    const entry: QueueEntry = {
      job,
      status: {
        invoiceId: job.invoiceId,
        state: 'queued',
        attempts: existing?.status.attempts ?? 0,
        queuedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        nextAttemptAt: null,
        security: null,
        lastError: null,
      },
    };

    this.#byInvoice.set(job.invoiceId, entry);
    this.#pending.push(entry);
    this.#log.info('issuance queued', { invoiceId: job.invoiceId, depth: this.#pending.length });
    void this.#persist(entry);
    void this.#drain();
    return entry.status;
  }

  status(invoiceId: string): IssuanceStatus | null {
    return this.#byInvoice.get(invoiceId)?.status ?? null;
  }

  snapshot(): IssuanceSnapshot {
    const counts: Record<IssuanceState, number> = { queued: 0, issuing: 0, issued: 0, failed: 0 };
    for (const entry of this.#byInvoice.values()) counts[entry.status.state] += 1;
    return {
      depth: this.#pending.length,
      inFlight: this.#inFlight,
      counts,
      lastSubmissionAt:
        this.#lastSubmissionAt === null ? null : new Date(this.#lastSubmissionAt).toISOString(),
    };
  }

  /** Lets the process exit cleanly; in-flight work is allowed to finish. */
  stop(): void {
    this.#stopped = true;
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (!this.#stopped) {
        const entry = this.#pending.shift();
        if (!entry) break;
        await this.#pace();
        await this.#attempt(entry);
      }
    } finally {
      this.#running = false;
      this.#inFlight = null;
    }
  }

  async #pace(): Promise<void> {
    if (this.#lastSubmissionAt === null) return;
    const wait = this.#opts.minIntervalMs - (Date.now() - this.#lastSubmissionAt);
    if (wait > 0) await sleep(wait);
  }

  /**
   * Mirror the entry's state into storage.
   *
   * Deliberately swallows its own failure. Losing a row is a degraded book — an invoice
   * reads as "being added" for longer than it should — while letting the rejection escape
   * would kill the drain loop and stop every remaining invoice from being issued at all.
   */
  async #persist(entry: QueueEntry): Promise<void> {
    const sink = this.#opts.sink;
    if (!sink) return;
    try {
      await sink.persist(entry.status, entry.job);
    } catch (err) {
      this.#log.error('could not persist issuance state', { invoiceId: entry.job.invoiceId, err });
    }
  }

  async #attempt(entry: QueueEntry): Promise<void> {
    const { job, status } = entry;
    status.state = 'issuing';
    status.attempts += 1;
    status.startedAt = new Date().toISOString();
    status.nextAttemptAt = null;
    this.#inFlight = job.invoiceId;
    this.#lastSubmissionAt = Date.now();

    try {
      const security = await this.#opts.deploy(job);
      status.state = 'issued';
      status.security = security;
      status.completedAt = new Date().toISOString();
      status.lastError = null;
      this.#log.info('issuance settled', {
        invoiceId: job.invoiceId,
        securityId: security.securityId,
        gasUsed: security.gasUsed,
        attempts: status.attempts,
      });
      await this.#persist(entry);
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      const retryable = isRetryable(err) && status.attempts < this.#opts.maxAttempts;

      if (!retryable) {
        status.state = 'failed';
        status.completedAt = new Date().toISOString();
        this.#log.error('issuance failed', {
          invoiceId: job.invoiceId,
          attempts: status.attempts,
          err,
        });
        await this.#persist(entry);
        return;
      }

      // Exponential backoff with jitter. Without jitter, twenty invoices queued in one
      // onboarding retry in lockstep and re-throttle each other.
      const base = this.#opts.backoffBaseMs * 2 ** (status.attempts - 1);
      const delay = Math.round(base * (0.5 + Math.random()));
      status.state = 'queued';
      status.nextAttemptAt = new Date(Date.now() + delay).toISOString();
      this.#log.warn('issuance throttled, backing off', {
        invoiceId: job.invoiceId,
        attempts: status.attempts,
        delayMs: delay,
        err: status.lastError,
      });
      await this.#persist(entry);
      await sleep(delay);
      this.#pending.push(entry);
    } finally {
      this.#inFlight = null;
    }
  }
}

/**
 * The real deployment: `Factory.deployBond` through the ATS adapter.
 *
 * Kept behind the `DeployBond` seam so the queue mechanics above stay testable with a fake
 * that returns BUSY on demand — the pacing, the backoff and the give-up rule are the parts
 * that have to be right, and none of them should need a testnet to exercise.
 *
 * The adapter is resolved per call rather than captured, so `initAtsAdapter` at boot and
 * `setAtsAdapter` in a test both take effect without rebuilding the queue. Everything the
 * call itself decides — gas, regulation, zero coupon, `address(0)` for the registry —
 * lives in `services/ats.ts`.
 */
export const deployBond: DeployBond = (job) => getAtsAdapter().deployBond(job);

/**
 * The real sink: the durable job row, plus the projection the book reads.
 *
 * Both are written because they answer different questions. `issuance_jobs` carries the
 * timing the worker needs to resume after a restart; `invoices.issuance_state` is what a
 * page of the book renders, and making that screen join to learn whether a row is still
 * "being added" would be a join per row.
 *
 * The invoice is only moved out of `draft` on success. Issuance and confirmation are
 * independent — an invoice can be confirmed before its instrument exists, and a failed
 * deployment must not silently unwind a debtor's acknowledgement.
 */
export function createStoreIssuanceSink(): IssuanceSink {
  return {
    async persist(status) {
      const store = getStore();

      await store.saveIssuanceJob({
        invoiceId: status.invoiceId,
        state: status.state,
        attempts: status.attempts,
        startedAt: status.startedAt === null ? null : new Date(status.startedAt),
        completedAt: status.completedAt === null ? null : new Date(status.completedAt),
        nextAttemptAt: status.nextAttemptAt === null ? null : new Date(status.nextAttemptAt),
        lastError: status.lastError,
      });

      await store.updateInvoice(status.invoiceId, {
        issuanceState: status.state,
        issuanceAttempts: status.attempts,
        issuanceError: status.lastError,
        ...(status.security === null
          ? {}
          : {
              securityId: status.security.securityId,
              securityEvmAddress: status.security.evmAddress,
              // Written here too: an instrument with no ISIN on its invoice is a security the
              // proof view cannot identify.
              isin: status.security.isin,
              issuanceTxId: status.security.transactionId,
            }),
      });
    },
  };
}

/**
 * The ticker an instrument carries. `FAC` plus the tail of the invoice number.
 *
 * Here rather than in the route because a resumed job has to produce the SAME symbol as the
 * original enqueue did. Two copies of this rule would differ the first time one of them was
 * tweaked, and the instrument would be named one thing before a restart and another after.
 */
export function symbolFor(invoiceNumber: string): string {
  const cleaned = invoiceNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `FAC${cleaned.slice(-5)}`.slice(0, 8);
}

/**
 * Everything `deployBond` needs, derived from the receivable it describes.
 *
 * Built in one place for the same reason the symbol lives here: the route builds this when an
 * invoice is created and {@link resumeIssuance} builds it again after a restart, and a job
 * that came back from the database differing in any field would deploy a different instrument
 * from the one the seller was told about.
 *
 * The ISIN is taken from the invoice when it has one and derived from its uniqueness hash
 * otherwise, which is the same value — `isinForInvoice` is deterministic, and that is what
 * stops one receivable acquiring two instruments across a retry.
 */
export function issuanceJobFor(input: {
  invoiceId: string;
  invoiceNumber: string;
  isin: string | null;
  uniquenessHash: string;
  regulationType: 'reg-d-506b' | 'reg-d-506c' | 'reg-s';
  dueAt: Date;
  faceValue: bigint;
  currency: string;
  sellerName: string;
}): IssuanceJob {
  return {
    invoiceId: input.invoiceId,
    isin: input.isin ?? isinForInvoice(input.uniquenessHash),
    regulationType: input.regulationType,
    maturityAt: input.dueAt,
    faceValue: input.faceValue,
    currency: input.currency,
    name: `${input.sellerName} receivable ${input.invoiceNumber}`,
    symbol: symbolFor(input.invoiceNumber),
  };
}

/**
 * Re-enqueue work that was queued before the process last stopped.
 *
 * Without this the durable `issuance_jobs` row is a record of something nobody will ever do
 * again: `enqueue` was only ever called when an invoice was created, so an invoice queued
 * before a restart stayed queued forever. The book reports it as "being added", which is
 * indistinguishable to a seller from an issuance that is genuinely in progress — the work had
 * simply been dropped on the floor.
 *
 * Deliberately not a retry of everything. A `failed` issuance has already exhausted its
 * attempts and its reason is usually deterministic (`onlyValidISIN` does not become valid on
 * the seventh try), so only `queued` and `issuing` work resumes. An invoice whose seller has
 * since gone is skipped loudly rather than deploying an instrument for a receivable nobody
 * owns.
 *
 * `enqueue` is idempotent per invoice, so calling this while something is already in flight
 * is a no-op rather than a second deployment of the same receivable.
 */
export async function resumeIssuance(log = rootLogger): Promise<number> {
  const store = getStore();

  /*
   * Read off the invoice projection, not the job table.
   *
   * `invoices.issuance_state` is what a page of the book renders, so it is what a seller is
   * actually being told is in progress — and the two can disagree. A seeded row carries the
   * projection with no job behind it, and resuming only from `issuance_jobs` would leave it
   * saying "being added" forever, which is the exact bug this function exists to fix. In that
   * disagreement the projection wins, because it is the one with a person looking at it.
   */
  const pending = await store.listInvoicesAwaitingIssuance();
  if (pending.length === 0) return 0;

  let resumed = 0;
  for (const invoice of pending) {
    const seller = await store.getSeller(invoice.sellerId);
    if (!seller) {
      log.warn('queued issuance has no seller, skipping', { invoiceId: invoice.id });
      continue;
    }

    getIssuanceQueue().enqueue(
      issuanceJobFor({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        isin: invoice.isin,
        uniquenessHash: invoice.uniquenessHash,
        regulationType: invoice.regulationType,
        dueAt: invoice.dueAt,
        faceValue: invoice.faceValue,
        currency: invoice.currency,
        sellerName: seller.name,
      }),
    );
    resumed += 1;
  }

  log.info('resumed issuance queued before restart', { resumed, found: pending.length });
  return resumed;
}

let queue: IssuanceQueue | undefined;

export function initIssuanceQueue(
  opts: Omit<IssuanceQueueOptions, 'deploy'> & { deploy?: DeployBond },
): IssuanceQueue {
  const { deploy, ...rest } = opts;
  queue = new IssuanceQueue({ ...rest, deploy: deploy ?? deployBond });
  return queue;
}

export function getIssuanceQueue(): IssuanceQueue {
  if (!queue) throw new Error('Issuance queue accessed before initIssuanceQueue().');
  return queue;
}
