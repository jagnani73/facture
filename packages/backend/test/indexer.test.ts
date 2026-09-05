/**
 * Chain reachability, and the health verdict built on it.
 *
 * These exist because the thing they pin was wrong for the whole life of the service and
 * nothing noticed: `/health` answered 503 from the first request to the last, on a lag
 * computed against a cursor no code path ever advanced. There was no test on this route at
 * all, which is how a permanently red light survives — nobody re-reads a dashboard that has
 * never once been green.
 *
 * So the assertions here are mostly about the *shape of the claim* rather than the numbers:
 * that a chain nobody has asked about stays distinguishable from a chain that would not
 * answer, that a head does not outlive the read which failed to refresh it, and that a
 * reachable pair of rails over a live database is a 200.
 *
 * Both rails are reached through `fetch` — Hedera's mirror node directly, Arc's RPC through
 * viem's http transport — so one stub covers both, and it delegates anything it does not
 * recognise to the facilitator stub the harness installed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arc, hedera } from '../src/chain.js';
import { createLogger } from '../src/logger.js';
import { Indexer, initIndexer } from '../src/services/indexer.js';
import { call, createHarness, type Harness } from './helpers.js';

const ARC_HEAD = 60_082_624n;
const HEDERA_HEAD = 40_014_950;

interface ChainStub {
  state: { arc: bigint | null; hedera: number | null };
  restore: () => void;
}

/**
 * Both chain heads, answering or refusing. `null` means the rail is down.
 *
 * `state` is mutable so one test can watch a rail fall over mid-run — the good-then-bad
 * transition is the only way to catch a stale head being carried forward.
 */
function stubChainHeads(initial: { arc?: bigint | null; hedera?: number | null } = {}): ChainStub {
  const previous = globalThis.fetch;
  const state = {
    arc: initial.arc === undefined ? ARC_HEAD : initial.arc,
    hedera: initial.hedera === undefined ? HEDERA_HEAD : initial.hedera,
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith(arc.rpcUrl)) {
      // A refusing node still answers 200 over JSON-RPC, with an `error` member instead of
      // a `result` — this is what an unreachable Arc actually looks like to viem.
      return state.arc === null
        ? json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no backend available' } })
        : json({ jsonrpc: '2.0', id: 1, result: `0x${state.arc.toString(16)}` });
    }
    if (url.startsWith(hedera.mirrorNodeUrl)) {
      return state.hedera === null
        ? json({ _status: { messages: [{ message: 'unavailable' }] } }, 503)
        : json({ blocks: [{ number: state.hedera }] });
    }
    return previous(input, init);
  }) as typeof fetch;

  return {
    state,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

const quiet = (): Indexer => new Indexer(createLogger('error', { svc: 'test' }));

describe('chain reachability', () => {
  let chains: ChainStub;

  afterEach(() => {
    chains.restore();
  });

  it('reports a chain nobody has asked about as unread, not as behind', () => {
    chains = stubChainHeads();
    const status = quiet().status();

    // The pole this module kept losing. Before the first poll there is no head, and the row
    // has to say so in its own words: a null head beside a null timestamp renders the same
    // as a chain that answered nothing, and only one of those needs anyone to act.
    expect(status.arc.state).toBe('unread');
    expect(status.hedera.state).toBe('unread');
    expect(status.arc.lastPolledAt).toBeNull();
    expect(status.arc.error).toBeNull();

    // Unknown is not healthy. The old verdict passed an unpolled chain because its lag was
    // null, which is how "we have not looked" read as "all good".
    expect(status.healthy).toBe(false);
  });

  it('reports both heads, and no lag, when the rails answer', async () => {
    chains = stubChainHeads();
    const status = await quiet().refresh();

    expect(status.arc).toMatchObject({
      state: 'reachable',
      head: ARC_HEAD.toString(),
      error: null,
    });
    expect(status.hedera).toMatchObject({ state: 'reachable', head: String(HEDERA_HEAD) });
    expect(status.arc.lastPolledAt).not.toBeNull();
    expect(status.healthy).toBe(true);

    // Nothing in this build tracks a position, so nothing may publish a distance from one.
    // A cursor reappearing here is the original bug returning, whatever it gets called.
    expect(status.arc).not.toHaveProperty('cursor');
    expect(status.arc).not.toHaveProperty('lag');
  });

  it('drops the head it can no longer confirm rather than keeping the last good one', async () => {
    chains = stubChainHeads();
    const indexer = quiet();

    const before = await indexer.refresh();
    expect(before.arc.head).toBe(ARC_HEAD.toString());

    chains.state.arc = null;
    const after = await indexer.refresh();

    // A head that outlived the read which failed to refresh it is indistinguishable from a
    // live one, and it would go on reading as a healthy rail for as long as the outage ran.
    expect(after.arc.state).toBe('unreachable');
    expect(after.arc.head).toBeNull();
    expect(after.arc.error).not.toBeNull();
    expect(after.healthy).toBe(false);

    // The rail that is still up keeps answering. One chain down is not both.
    expect(after.hedera.state).toBe('reachable');
    expect(after.hedera.head).toBe(String(HEDERA_HEAD));
  });

  it('names why the mirror node could not be read', async () => {
    chains = stubChainHeads({ hedera: null });
    const status = await quiet().refresh();

    expect(status.hedera.state).toBe('unreachable');
    expect(status.hedera.error).toContain('503');
    expect(status.hedera.lastPolledAt).not.toBeNull();
    expect(status.healthy).toBe(false);
  });

  it('treats a mirror node answering without a block number as unreachable', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.startsWith(hedera.mirrorNodeUrl)
        ? { blocks: [] }
        : { jsonrpc: '2.0', id: 1, result: `0x${ARC_HEAD.toString(16)}` };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    chains = {
      state: { arc: ARC_HEAD, hedera: HEDERA_HEAD },
      restore: () => {
        globalThis.fetch = previous;
      },
    };

    const status = await quiet().refresh();

    // A 200 carrying nothing usable is not a reachable chain. Calling it reachable with a
    // null head would fold the two unknowns back into one rendering.
    expect(status.hedera.state).toBe('unreachable');
    expect(status.hedera.head).toBeNull();
    expect(status.hedera.error).toContain('no block number');
  });
});

describe('GET /health', () => {
  let h: Harness;
  let chains: ChainStub;

  beforeEach(async () => {
    h = await createHarness();
    // The harness does not start the service, and `initIndexer` is called from
    // `src/index.ts`. Without this line the route throws instead of answering — its own
    // small proof that nothing had ever exercised `/health`.
    initIndexer();
    chains = stubChainHeads();
  });

  afterEach(() => {
    chains.restore();
    h.restore();
  });

  it('is 200 when the database and both rails are reachable', async () => {
    const res = await call(h.app, 'GET', '/health');

    // The regression itself. This was 503, permanently, on a lag against a cursor nothing
    // advanced.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies.database.ok).toBe(true);
    expect(res.body.chains.arc).toMatchObject({ state: 'reachable', head: ARC_HEAD.toString() });
    expect(res.body.chains.hedera).toMatchObject({ state: 'reachable' });
  });

  it('still carries the chain identity beside the reachability', async () => {
    const res = await call(h.app, 'GET', '/health');

    // The reporting was to be corrected, not removed: which chain a head belongs to is the
    // part that makes it actionable at a glance.
    expect(res.body.chains.arc.chainId).toBe(arc.chainId);
    expect(res.body.chains.hedera.network).toBe(hedera.network);
  });

  it('is 503 and still reports the rails when one will not answer', async () => {
    chains.state.hedera = null;
    const res = await call(h.app, 'GET', '/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.chains.hedera.state).toBe('unreachable');
    expect(res.body.chains.hedera.error).toContain('503');
    // The rail that is up is still named as up, so the answer says which one to go and fix.
    expect(res.body.chains.arc.state).toBe('reachable');
  });

  it('does not go degraded merely because the facilitator is down', async () => {
    // The documented asymmetry: the book still prices and lists without a facilitator, so
    // it is reported and not fatal. An unreachable chain is fatal, because neither leg of a
    // DvP can be placed against a rail that will not answer.
    const previous = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('facilitator.test')) return new Response('down', { status: 502 });
      return previous(input, init);
    }) as typeof fetch;

    try {
      const res = await call(h.app, 'GET', '/health');
      expect(res.body.dependencies.facilitator.ok).toBe(false);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('reports the issuance queue depth beside the rails', async () => {
    const res = await call(h.app, 'GET', '/health');

    // The web client reads `issuance.depth` and `uptimeSeconds` off this response; losing
    // either while reshaping `chains` would break a consumer this change does not own.
    expect(typeof res.body.issuance.depth).toBe('number');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });
});
