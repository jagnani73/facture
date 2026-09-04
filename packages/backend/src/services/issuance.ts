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
import { notImplemented } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

export type IssuanceState = 'queued' | 'issuing' | 'issued' | 'failed';

export interface IssuanceJob {
  invoiceId: string;
  /** Checksum-valid ISIN, generated ahead of time — ATS `onlyValidISIN` rejects strings. */
  isin: string;
  /** ATS `onlyValidRegulation`: Reg D 506(b)/506(c) or Reg S. Never unset. */
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

export interface IssuanceQueueOptions {
  deploy: DeployBond;
  /** Pacing floor between submissions. Network gas throughput, not per-tx gas. */
  minIntervalMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  logger?: Logger;
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
      // TODO: persist securityId + evmAddress onto the invoice row and flip its status,
      // so the book can re-render the invoice as quotable.
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
      await sleep(delay);
      this.#pending.push(entry);
    } finally {
      this.#inFlight = null;
    }
  }
}

/**
 * The real deployment. Kept behind the `DeployBond` seam so the queue mechanics above
 * are testable with a fake that returns BUSY on demand.
 *
 * TODO: build and execute `Factory.deployBond` via `@hiero-ledger/sdk`
 * (`ContractExecuteTransaction`, gas from `ISSUANCE_GAS_LIMIT`, default 10M — the ATS
 * repo ships exactly that for this call on both hedera-testnet and hedera-mainnet).
 * Rate stays at the 0 it initialises to; maturity is the invoice due date; principal is
 * the face value. Leave `identityRegistry` and `compliance` at address(0) and use the
 * security's own `ControlList` and `Kyc` facets instead — a shared ERC-3643 registry is
 * `isVerified(address)` with no token parameter, so every security pointing at one
 * registry would share a single global allowlist.
 */
export const deployBond: DeployBond = (job) => {
  throw notImplemented(`ATS deployBond for invoice ${job.invoiceId}`);
};

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
