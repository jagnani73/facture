/**
 * Chain head and indexer cursor.
 *
 * Exists for `GET /health`. Knowing, mid-demo, whether the backend is behind the chain or
 * the chain itself has stalled is the difference between a ten-second recovery and a
 * confused two minutes on stage — a stale price is indistinguishable from a wrong price
 * unless something reports the lag.
 *
 * Heads are read for real. Cursors are still in-memory; see the TODO.
 */

import { createPublicClient, http } from 'viem';
import { arcChain, hedera } from '../chain.js';
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
      // TODO: read the persisted cursor (last Arc block whose settlement events were
      // ingested) instead of assuming we are caught up.
      const cursor = this.#arc.cursor;
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

      // TODO: cursor should be the last mirror-node block whose ATS / HCS events were
      // ingested, read from the DB rather than held in memory across restarts.
      const cursor = this.#hedera.cursor;
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

  /** Advanced by the ingest loop once events up to `position` are durably applied. */
  advance(chain: 'arc' | 'hedera', position: string): void {
    if (chain === 'arc') this.#arc = { ...this.#arc, cursor: position };
    else this.#hedera = { ...this.#hedera, cursor: position };
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
