/**
 * `GET /health`.
 *
 * More than a liveness ping on purpose. During a demo the useful question is never "is the
 * process up" — it is "can this venue still complete a trade". That wants both rails, the
 * database, the issuance queue depth and the facilitator in one response you can leave open
 * in a tab.
 *
 * It deliberately does NOT claim to answer "is the price on screen current". A quote is
 * computed on read from mandates in the database rather than replayed from chain events, so
 * its freshness is the database's business and nothing here can add to it. This route used
 * to imply otherwise by publishing an indexer lag beside each head; the cursor behind that
 * number was advanced by nothing, so the lag was the whole chain height and the 503 was
 * permanent. The reasoning is recorded in `services/indexer.ts`.
 *
 * Always returns a body. 200 when everything the product needs is up, 503 when it is not —
 * a health check that lies is worse than none, and one that is always red lies too.
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

  const [db, chainStatus, facilitator] = await Promise.all([
    pingDb(),
    getIndexer().refresh(),
    checkFacilitator(),
  ]);

  const issuance = getIssuanceQueue().snapshot();

  // The facilitator being down does not make the service unhealthy — the book still
  // prices and lists. It only blocks the cash leg, so it is reported, not fatal.
  //
  // A chain that will not answer is fatal, and the asymmetry is the point: the asset leg is
  // placed on Hedera and the cash leg on Arc, so an unreachable rail means no trade can
  // complete at all, rather than one route being slower than usual.
  const ok = db.ok && chainStatus.healthy;

  return c.json(
    {
      status: ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      environment: env.NODE_ENV,
      dependencies: {
        database: db,
        facilitator: { ...facilitator, url: env.X402_FACILITATOR_URL },
      },
      /**
       * Per-rail reachability. `state` is the answer and `head` is the evidence for it;
       * `state` is carried explicitly so that "not asked yet" and "asked, no answer" stay
       * two facts rather than one null head. No lag is reported: nothing in this build
       * tracks a position that could be behind one.
       */
      chains: {
        arc: { ...chainStatus.arc, chainId: chain.arc.chainId },
        hedera: { ...chainStatus.hedera, network: chain.hedera.network },
      },
      /** Queue depth answers "why is this invoice still grey" in one glance. */
      issuance,
    },
    ok ? 200 : 503,
  );
});
