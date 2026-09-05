/**
 * Test harness.
 *
 * There is no database file here, and there is no testnet. Both are handled the same way: the
 * seam that would reach them is replaced with an implementation that behaves the way the
 * real one is documented to, and the code under test is the real code.
 *
 * - the database is `MemoryStore`, which implements the whole `Store` contract including
 *   the clamping, the idempotency and the ordering the SQLite one promises;
 * - Hedera is a fake `AtsAdapter` that records what it was asked to do;
 * - the maturity payout rail is a fake `ScheduleAdapter` that records what it was asked to
 *   schedule, and can answer as an unconfigured or a broken rail;
 * - the x402 facilitator is a stubbed `fetch` answering `/supported`, `/verify`, `/settle`.
 *
 * Nothing here stubs a route, a service or the pricing. Those are exercised as shipped.
 */

import { vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, resetConfig } from '../src/config.js';
import { createMemoryStore, type MemoryStore } from '../src/db/memory-store.js';
import { seedStore } from '../src/db/seed.js';
import { setStore } from '../src/db/store.js';
import { createLogger, setRootLogger } from '../src/logger.js';
import type { AtsAdapter, HoldReceipt } from '../src/services/ats.js';
import { setAtsAdapter } from '../src/services/ats.js';
import type { MaturityPayoutRequest, ScheduleAdapter } from '../src/services/schedule.js';
import { setScheduleAdapter } from '../src/services/schedule.js';
import type { ComplianceDecision, ComplianceGate } from '../src/services/compliance.js';
import { setComplianceGate } from '../src/services/compliance.js';
import { initIssuanceQueue } from '../src/services/issuance.js';
import type { Notifier } from '../src/services/notifier.js';
import { setNotifier } from '../src/services/notifier.js';
import { DEFAULT_NETWORK, DEFAULT_SCHEME, initX402Client } from '../src/services/x402.js';

/** A complete, valid environment. Mirrors the shape `test/env.test.ts` already asserts. */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  PUBLIC_BASE_URL: 'http://localhost:8787',
  CONFIRMATION_TOKEN_SECRET: 'test-secret-that-is-long-enough-32',
  HEDERA_OPERATOR_ID: '0.0.5512',
  HEDERA_OPERATOR_KEY: `3030020100300706052b8104000a04220420${'a'.repeat(64)}`,
  ARC_SETTLEMENT_PRIVATE_KEY: `0x${'b'.repeat(64)}`,
  X402_PAY_TO: '0.0.5512',
  DATABASE_URL: ':memory:',
  ISSUANCE_MIN_INTERVAL_MS: '0',
  ISSUANCE_BACKOFF_BASE_MS: '1',
};

export const FEE_PAYER = '0.0.98';

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: MemoryStore;
  ats: RecordingAtsAdapter;
  /** The maturity payout rail. Records what it was asked to schedule. */
  schedule: RecordingScheduleAdapter;
  seeded: Awaited<ReturnType<typeof seedStore>>;
  /** Everything the facilitator was asked. Lets a test assert verify-before-settle. */
  facilitatorCalls: string[];
  restore(): void;
}

export interface RecordingScheduleAdapter extends ScheduleAdapter {
  scheduled: MaturityPayoutRequest[];
  /** Set to make the rail answer `null`, as an unconfigured collection account does. */
  disabled: boolean;
  /** Set to make scheduling throw, which must not un-mature the receivable. */
  fails: string | undefined;
}

/**
 * A rail that records rather than schedules.
 *
 * `executed` is hardcoded `false` and there is deliberately no way to flip it here: a
 * payout that reports itself executed at the moment of creation is precisely the bug the
 * collection-account design exists to prevent, and a fake that could express it would let a
 * test pass while the real rail lied.
 */
function createRecordingSchedule(): RecordingScheduleAdapter {
  let counter = 0;
  const adapter: RecordingScheduleAdapter = {
    scheduled: [],
    disabled: false,
    fails: undefined,

    schedulePayout(request) {
      if (adapter.fails !== undefined) return Promise.reject(new Error(adapter.fails));
      if (adapter.disabled) return Promise.resolve(null);
      counter += 1;
      adapter.scheduled.push(request);
      return Promise.resolve({
        scheduleId: `0.0.${7_000_000 + counter}`,
        transactionId: `0.0.5512@1756000400.00000000${counter}`,
        consensusAt: new Date('2026-09-01T09:32:40.000Z').toISOString(),
        payerAccountId: '0.0.5599',
        payeeAccountId: /^\d+\.\d+\.\d+$/.test(request.payeeAccount)
          ? request.payeeAccount
          : '0.0.6098431',
        amountMinor: request.amountMinor.toString(10),
        executed: false,
      });
    },
  };
  return adapter;
}

export interface RecordingAtsAdapter extends AtsAdapter {
  holds: { securityId: string; units: bigint }[];
  executed: { holdId: string; units: bigint }[];
  released: { holdId: string; units: bigint }[];
  /** Set to make the next hold execution fail — the half-settled path. */
  failExecute: boolean;
  /**
   * What `balanceOf` answers for a holder with no entry in {@link balances}.
   *
   * Face-value-many units, matching what issuance actually mints: the live bond
   * `0.0.10316440` carries 6,230,000 against a $62,300 face. A fake that answered `1`
   * would agree with the bug rather than with the instrument.
   */
  defaultBalance: bigint;
  /** Per `securityId` overrides, for the seller-holds-nothing case. */
  balances: Map<string, bigint>;
}

function createRecordingAts(): RecordingAtsAdapter {
  let holdCounter = 0;
  const adapter: RecordingAtsAdapter = {
    holds: [],
    executed: [],
    released: [],
    failExecute: false,
    defaultBalance: 6_230_000n,
    balances: new Map(),

    balanceOf(input) {
      return Promise.resolve(adapter.balances.get(input.securityId) ?? adapter.defaultBalance);
    },

    deployBond(job) {
      return Promise.resolve({
        securityId: `0.0.${900_000 + job.invoiceId.length}`,
        evmAddress: `0x${'ab'.repeat(20)}`,
        transactionId: `0.0.5512@1756000000.${job.invoiceId.slice(0, 9)}`,
        gasUsed: 6_978_091,
      });
    },

    createHold(request) {
      holdCounter += 1;
      adapter.holds.push({ securityId: request.securityId, units: request.units });
      const receipt: HoldReceipt = {
        holdId: String(holdCounter),
        transactionId: `0.0.5512@1756000100.00000000${holdCounter}`,
        consensusAt: new Date('2026-09-01T09:32:10.000Z').toISOString(),
      };
      return Promise.resolve(receipt);
    },

    executeHold(input) {
      if (adapter.failExecute) return Promise.reject(new Error('CONTRACT_REVERT_EXECUTED'));
      adapter.executed.push({ holdId: input.holdId, units: input.units });
      return Promise.resolve({
        transactionId: `0.0.5512@1756000200.000000001`,
        consensusAt: new Date('2026-09-01T09:32:20.000Z').toISOString(),
      });
    },

    releaseHold(input) {
      adapter.released.push({ holdId: input.holdId, units: input.units });
      return Promise.resolve({
        transactionId: `0.0.5512@1756000300.000000001`,
        consensusAt: new Date('2026-09-01T09:32:30.000Z').toISOString(),
      });
    },
  };
  return adapter;
}

/** Allows everything, and records that it was consulted before the match, not after. */
export function createAllowingGate(): ComplianceGate {
  return {
    check(): Promise<ComplianceDecision> {
      return Promise.resolve({
        decision: 'allowed',
        checkedAt: '2026-09-01T09:32:00.000Z',
        checks: [
          { name: 'Control list', detail: 'Permitted to hold this security.', passed: true },
          { name: 'KYC status', detail: 'Valid grant on this security.', passed: true },
          { name: 'Transfers enabled', detail: 'Not paused.', passed: true },
        ],
        reason: null,
      });
    },
  };
}

export function createRefusingGate(reason: string): ComplianceGate {
  return {
    check(): Promise<ComplianceDecision> {
      return Promise.resolve({
        decision: 'refused',
        checkedAt: '2026-09-01T09:32:00.000Z',
        checks: [{ name: 'KYC status', detail: reason, passed: false }],
        reason,
      });
    },
  };
}

const silentNotifier: Notifier = { sendConfirmationRequest: () => Promise.resolve() };

/** Stubs the facilitator. `settle` succeeds unless `settleFails` is set. */
export function stubFacilitator(options: { settleFails?: string } = {}): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/supported')) {
      // `extra.feePayer` is read from here at runtime and never hardcoded — hardcoding it
      // works until the facilitator rotates the payer, then fails as a signature mismatch.
      return json({
        kinds: [
          {
            x402Version: 2,
            scheme: DEFAULT_SCHEME,
            network: DEFAULT_NETWORK,
            extra: { feePayer: FEE_PAYER },
          },
        ],
      });
    }
    if (url.endsWith('/verify')) return json({ isValid: true, payer: '0.0.6098467' });
    if (url.endsWith('/settle')) {
      return options.settleFails === undefined
        ? json({
            success: true,
            transaction: '0.0.6098467@1756000150.000000001',
            network: DEFAULT_NETWORK,
            payer: '0.0.6098467',
          })
        : json({ success: false, errorReason: options.settleFails });
    }
    return new Response('not stubbed', { status: 404 });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export interface HarnessOptions {
  /** Skip the demo book — for tests that want an empty market. */
  seed?: boolean;
  gate?: ComplianceGate;
  settleFails?: string;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  resetConfig();
  loadConfig(TEST_ENV);
  setRootLogger(createLogger('error', { svc: 'test' }));

  const store = createMemoryStore();
  setStore(store);

  const ats = createRecordingAts();
  setAtsAdapter(ats);
  const schedule = createRecordingSchedule();
  setScheduleAdapter(schedule);
  setComplianceGate(options.gate ?? createAllowingGate());
  setNotifier(silentNotifier);

  initIssuanceQueue({ minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 1 });

  const facilitator = stubFacilitator(
    options.settleFails === undefined ? {} : { settleFails: options.settleFails },
  );
  initX402Client({
    facilitatorUrl: 'https://facilitator.test',
    supportedTtlSeconds: 300,
    scheme: DEFAULT_SCHEME,
    network: DEFAULT_NETWORK,
    payTo: '0.0.5512',
    assetMode: 'hbar',
    assetDecimals: 8,
    // Full amount in tests: the demo scale exists for testnet balances, and a test that
    // asserts on a scaled number would be asserting on the scale, not the settlement.
    settlementScalePpm: 1_000_000,
    htsAssetId: undefined,
  });

  const seeded =
    options.seed === false ? ({} as Awaited<ReturnType<typeof seedStore>>) : await seedStore(store);

  return {
    app: createApp(),
    store,
    ats,
    schedule,
    seeded,
    facilitatorCalls: facilitator.calls,
    restore: () => {
      facilitator.restore();
      setStore(undefined);
      setAtsAdapter(undefined);
      setScheduleAdapter(undefined);
      setComplianceGate(undefined);
      resetConfig();
    },
  };
}

/**
 * A parsed JSON response body.
 *
 * Deliberately indexable rather than typed per route. A test that restated every response
 * shape would pass by agreeing with itself rather than with the handler, and the handler is
 * the thing under test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonBody = { [key: string]: any };

/** `fetch` against the app under test, with JSON in and out. */
export async function call(
  app: Harness['app'],
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: JsonBody; headers: Headers }> {
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text.length === 0 ? null : JSON.parse(text),
    headers: res.headers,
  };
}
