/**
 * Chain head and indexer cursor.
 *
 * Exists for `GET /health`. Knowing, mid-demo, whether the backend is behind the chain or
 * the chain itself has stalled is the difference between a ten-second recovery and a
 * confused two minutes on stage — a stale price is indistinguishable from a wrong price
 * unless something reports the lag.
 *
 * Heads are read for real, and cursors are read from and written to storage — an
 * in-memory cursor resets to null on every restart, which reads on the health page as
 * "never polled" rather than "four thousand blocks behind", and only one of those is fine.
 */

import { createPublicClient, http } from 'viem';
import { arcChain, assetChainKey, cashChainKey, hedera } from '../chain.js';
import { getStore } from '../db/store.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

export interface ChainCursor {
  /** Last position this service has processed. null before the first poll. */
  cursor: string | null;
  /** Latest position on chain. null when the head could not be read. */
  head: string | null;
  /** head - cursor, in the chain's own unit. null when either side is unknown. */
  lag: number | null;
  lastPolledAt: string | null;
  error: string | null;
}

export interface IndexerStatus {
  arc: ChainCursor;
  hedera: ChainCursor;
  /** False when either chain head is unreadable or the lag is beyond tolerance. */
  healthy: boolean;
}

/** Blocks / consensus-seconds behind before health flips to degraded. */
const ARC_LAG_TOLERANCE_BLOCKS = 25;
const HEDERA_LAG_TOLERANCE_BLOCKS = 25;

function emptyCursor(): ChainCursor {
  return { cursor: null, head: null, lag: null, lastPolledAt: null, error: null };
}

export class Indexer {
  readonly #log: Logger;
  readonly #arcClient = createPublicClient({ chain: arcChain, transport: http() });
  #arc: ChainCursor = emptyCursor();
  #hedera: ChainCursor = emptyCursor();

  constructor(logger: Logger = rootLogger) {
    this.#log = logger.child({ svc: 'indexer' });
  }

  status(): IndexerStatus {
    const withinTolerance = (c: ChainCursor, tolerance: number): boolean =>
      c.error === null && c.head !== null && (c.lag === null || c.lag <= tolerance);

    return {
      arc: this.#arc,
      hedera: this.#hedera,
      healthy:
        withinTolerance(this.#arc, ARC_LAG_TOLERANCE_BLOCKS) &&
        withinTolerance(this.#hedera, HEDERA_LAG_TOLERANCE_BLOCKS),
    };
  }

  /** Called by the health route and by the poll loop. Never throws. */
  async refresh(): Promise<IndexerStatus> {
    const [arc, hed] = await Promise.all([this.#refreshArc(), this.#refreshHedera()]);
    this.#arc = arc;
    this.#hedera = hed;
    return this.status();
  }

  async #refreshArc(): Promise<ChainCursor> {
    const now = new Date().toISOString();
    try {
      const head = await this.#arcClient.getBlockNumber();
      // Read from storage, not from memory. An in-memory cursor resets to null on every
      // restart, which reports as "never polled" rather than "four thousand blocks
      // behind" - the two look identical on the health page and only one of them is fine.
      const cursor = await this.#readCursor(cashChainKey, this.#arc.cursor);
      return {
        cursor,
        head: head.toString(),
        lag: cursor === null ? null : Number(head - BigInt(cursor)),
        lastPolledAt: now,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('arc head unreadable', { err: message });
      return { ...this.#arc, head: null, lag: null, lastPolledAt: now, error: message };
    }
  }

  async #refreshHedera(): Promise<ChainCursor> {
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

      const cursor = await this.#readCursor(assetChainKey, this.#hedera.cursor);
      return {
        cursor,
        head: String(head),
        lag: cursor === null ? null : head - Number(cursor),
        lastPolledAt: now,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('hedera head unreadable', { err: message });
      return { ...this.#hedera, head: null, lag: null, lastPolledAt: now, error: message };
    }
  }

  /**
   * Read a persisted cursor, falling back to whatever is in memory.
   *
   * Never throws. A cursor that cannot be read is a degraded health page; letting it
   * escape would make an unreachable database look like an unreachable chain.
   */
  async #readCursor(chain: string, fallback: string | null): Promise<string | null> {
    try {
      return (await getStore().getCursor(chain)) ?? fallback;
    } catch (err) {
      this.#log.debug('cursor unreadable, using in-memory position', { chain, err });
      return fallback;
    }
  }

  /**
   * Advanced by the ingest loop once events up to `position` are durably applied.
   *
   * Memory moves first and the write follows, because the caller has already applied the
   * events: a failed write means the cursor is re-read from an older position on the next
   * restart and some events are re-applied, which every consumer here is idempotent
   * against. Advancing storage first and failing would skip them instead.
   */
  advance(chain: 'arc' | 'hedera', position: string): void {
    const key = chain === 'arc' ? cashChainKey : assetChainKey;
    if (chain === 'arc') this.#arc = { ...this.#arc, cursor: position };
    else this.#hedera = { ...this.#hedera, cursor: position };

    void getStore()
      .setCursor(key, position)
      .catch((err: unknown) => {
        this.#log.warn('could not persist indexer cursor', { chain, position, err });
      });
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
