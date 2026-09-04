/**
 * `GET /health`.
 *
 * More than a liveness ping on purpose. During a demo the useful question is never "is
 * the process up" — it is "is the price on screen current". That needs the indexer cursor
 * next to the chain head, the issuance queue depth, and whether the facilitator is
 * answering, all in one response you can leave open in a tab.
 *
 * Always returns a body. 200 when everything is up, 503 when a dependency the product
 * needs is not — a health check that lies is worse than none.
 */

import { Hono } from 'hono';
import { getConfig } from '../config.js';
import { pingDb } from '../db/index.js';
import type { AppEnv } from '../middleware/context.js';
import { getIndexer } from '../services/indexer.js';
import { getIssuanceQueue } from '../services/issuance.js';
import { getX402Client } from '../services/x402.js';

const startedAt = Date.now();

interface DependencyStatus {
  ok: boolean;
  detail: string | null;
}

async function checkFacilitator(): Promise<DependencyStatus> {
  try {
    const kinds = await getX402Client().supported();
    return { ok: kinds.kinds.length > 0, detail: `${kinds.kinds.length} kinds` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', async (c) => {
  const { env, chain } = getConfig();

  const [db, indexer, facilitator] = await Promise.all([
    pingDb(),
    getIndexer().refresh(),
    checkFacilitator(),
  ]);

  const issuance = getIssuanceQueue().snapshot();

  // The facilitator being down does not make the service unhealthy — the book still
  // prices and lists. It only blocks the cash leg, so it is reported, not fatal.
  const ok = db.ok && indexer.healthy;

  return c.json(
    {
      status: ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      environment: env.NODE_ENV,
      dependencies: {
        database: db,
        facilitator: { ...facilitator, url: env.X402_FACILITATOR_URL },
      },
      /** Cursor vs head, per chain. A stale price is invisible without this. */
      chains: {
        arc: { ...indexer.arc, chainId: chain.arc.chainId },
        hedera: { ...indexer.hedera, network: chain.hedera.network },
      },
      /** Queue depth answers "why is this invoice still grey" in one glance. */
      issuance,
    },
    ok ? 200 : 503,
  );
});
