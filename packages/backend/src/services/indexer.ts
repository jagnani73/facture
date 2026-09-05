/**
 * Chain reachability, for `GET /health`.
 *
 * **This build does not index.** Nothing here follows an event stream, and nothing in the
 * service records a stream position: the venue *originates* its chain transactions rather
 * than reading them back, so what a trade stores is a transaction id and a consensus
 * timestamp — identifiers, not a position anything could resume from.
 *
 * It used to claim otherwise, and the claim held `/health` at 503 from the first request.
 * A cursor was published beside the head and the difference between them reported as a
 * lag, but the only writer of that cursor was an `advance()` no caller ever reached, so
 * the cursor stayed at the `"0"` the seed persists and the lag printed as the entire chain
 * height. `advance()` is gone rather than left waiting for the loop that would have called
 * it: dead code with a good comment is still dead code, and this dead code was wired to a
 * red light.
 *
 * A verdict derived from a counter nothing moves is worse than no verdict, because a
 * health check that is always red is a health check nobody reads — and what it was
 * drowning out is real. Arc's RPC is the cash leg's rail; Hedera's mirror node is what the
 * compliance gate reads and what a maturity payout's status is asked of. Whether those two
 * answer is a genuine dependency probe, and it is all this can honestly report.
 *
 * The distinction the old cursor comment existed to protect outlives the cursor, because
 * it was never really about cursors: **two different unknowns must not render as the same
 * thing.** "We have not asked yet" and "we asked and the chain did not answer" have
 * different fixes, and a head left at its last good value while the read fails is
 * indistinguishable from a live one. So a failed read builds a fresh row with a null head
 * instead of amending the previous one, and `state` names which case produced the row
 * rather than leaving a reader to infer it from a triple of nulls.
 *
 * The exported `initIndexer` / `getIndexer` names are vestigial. Renaming them reaches
 * `src/index.ts`, which this change deliberately leaves alone.
 */

import { createPublicClient, http } from 'viem';
import { arcChain, hedera } from '../chain.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

/**
 * Which of the three cases produced a row.
 *
 * Explicit rather than inferred from a null head, because "never asked" and "asked and
 * got nothing back" are exactly the pair that collapsing costs you.
 */
export type ChainReachability = 'unread' | 'reachable' | 'unreachable';

export interface ChainHead {
  state: ChainReachability;
  /** Latest position on chain, in the chain's own unit. Non-null only when reachable. */
  head: string | null;
  /** When the head was last asked for — which is not when it was last answered. */
  lastPolledAt: string | null;
  error: string | null;
}

export interface ChainStatus {
  arc: ChainHead;
  hedera: ChainHead;
  /** True only when both rails answered. A chain we cannot ask is not a healthy one. */
  healthy: boolean;
}

const unread = (): ChainHead => ({ state: 'unread', head: null, lastPolledAt: null, error: null });

export class Indexer {
  readonly #log: Logger;
  /**
   * `cacheTime: 0` because viem otherwise serves `getBlockNumber` from a 4-second cache,
   * and a cached head published under a fresh `lastPolledAt` is a stale head wearing a
   * current timestamp — the same collapse this module exists to prevent, just smaller.
   */
  readonly #arcClient = createPublicClient({ chain: arcChain, transport: http(), cacheTime: 0 });
  #arc: ChainHead = unread();
  #hedera: ChainHead = unread();

  constructor(logger: Logger = rootLogger) {
    this.#log = logger.child({ svc: 'indexer' });
  }

  status(): ChainStatus {
    return {
      arc: this.#arc,
      hedera: this.#hedera,
      healthy: this.#arc.state === 'reachable' && this.#hedera.state === 'reachable',
    };
  }

  /** Called by the health route. Never throws: an outage is a value here, not an exception. */
  async refresh(): Promise<ChainStatus> {
    const [arc, hed] = await Promise.all([this.#refreshArc(), this.#refreshHedera()]);
    this.#arc = arc;
    this.#hedera = hed;
    return this.status();
  }

  async #refreshArc(): Promise<ChainHead> {
    const now = new Date().toISOString();
    try {
      const head = await this.#arcClient.getBlockNumber();
      return { state: 'reachable', head: head.toString(), lastPolledAt: now, error: null };
    } catch (err) {
      return this.#unreachable('arc', err, now);
    }
  }

  async #refreshHedera(): Promise<ChainHead> {
    const now = new Date().toISOString();
    const url = `${hedera.mirrorNodeUrl.replace(/\/$/, '')}/api/v1/blocks?limit=1&order=desc`;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`mirror node returned ${res.status}`);

      const body = (await res.json()) as { blocks?: { number?: number }[] };
      const head = body.blocks?.[0]?.number;
      if (typeof head !== 'number') throw new Error('mirror node returned no block number');

      return { state: 'reachable', head: String(head), lastPolledAt: now, error: null };
    } catch (err) {
      return this.#unreachable('hedera', err, now);
    }
  }

  /**
   * Built fresh rather than spread over the last good row: keeping the previous head
   * through a failed read would publish the last known height as the current one.
   */
  #unreachable(chain: string, err: unknown, at: string): ChainHead {
    const message = err instanceof Error ? err.message : String(err);
    this.#log.warn('chain head unreadable', { chain, err: message });
    return { state: 'unreachable', head: null, lastPolledAt: at, error: message };
  }
}

let indexer: Indexer | undefined;

export function initIndexer(logger?: Logger): Indexer {
  indexer = new Indexer(logger);
  return indexer;
}

export function getIndexer(): Indexer {
  if (!indexer) throw new Error('Indexer accessed before initIndexer().');
  return indexer;
}
