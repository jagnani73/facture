/**
 * The loop.
 *
 * The claim under test is the one the README makes about market makers: they are *real
 * agents holding funded mandates*, and fake liquidity is the one thing that would undo
 * every argument in the product. So the tests below are mostly about the balance —
 * that it is read from the chain rather than remembered, that it is read again before
 * anything commits, and that two invoices in one pass cannot both be told the same dollar
 * is free.
 *
 * They matter more than they look, because **Circle enforces no spending cap on this
 * path**. The budget these tests exercise is the only thing between a mandate and an
 * overspend.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMarketMaker,
  invoiceMinorToUsdc,
  pickBest,
  usdcToInvoiceMinor,
  type AgentConfig,
} from '../src/agent.js';
import { createLogger, type Logger } from '../src/logger.js';
import type { MandateAcceptance, MandateAllocations, MandateTerms } from '../src/mandate.js';
import type { ArmedTrade, BookRow, LiveQuote, VenueClient, VenueMandate } from '../src/venue.js';
import type {
  ContractCallInput,
  SubmittedTransaction,
  TokenBalance,
  TransferInput,
  WalletClient,
  WalletSetSummary,
  WalletSummary,
} from '../src/wallet.js';

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

const TERMS: MandateTerms = {
  id: 'mandate-a',
  buyerId: 'buyer-1',
  currency: 'USD',
  minRating: 'A',
  maxTenorDays: 90,
  annualisedYieldBps: 1250,
  totalCommitted: 20_000_000n,
  maxPerDebtor: 20_000_000n,
  status: 'active',
};

/** $40,000 face, 60 days at 12.5% → $39,178.08 proceeds. */
const PROCEEDS = 3_917_808n;

const mandate = (
  over: Partial<MandateTerms> = {},
  allocations: MandateAllocations = { total: 0n, byDebtor: {} },
): VenueMandate => {
  const terms = { ...TERMS, ...over };
  return {
    terms,
    allocations,
    exposureLimit: terms.totalCommitted,
    escrowedCapital: terms.totalCommitted,
    // Backed by default: the interesting cases below say otherwise explicitly.
    vault: BACKED,
  };
};

/** A vault the venue read and found sufficient for the mandate's whole committed capital. */
const BACKED = {
  checked: true,
  depositedUsdcMinor: 5_000_000n,
  requiredUsdcMinor: 50_000n,
  backed: true,
} as const;

/** Read, and short. The bid would settle by an x402 challenge this agent cannot sign. */
const UNBACKED = { ...BACKED, depositedUsdcMinor: 1_000n, backed: false } as const;

const row = (over: Partial<BookRow> = {}): BookRow => ({
  invoiceId: 'invoice-1',
  sellerId: 'seller-1',
  debtorId: 'debtor-1',
  debtorName: 'Northwind Trading',
  rating: 'A',
  invoiceNumber: 'INV-1',
  faceValue: 4_000_000n,
  currency: 'USD',
  dueAt: '2026-10-31T00:00:00.000Z',
  tenorDays: 60,
  status: 'listed',
  quotable: true,
  issued: true,
  ...over,
});

/* ── fakes ───────────────────────────────────────────────────────────────────────────── */

interface FakeVenue extends VenueClient {
  readonly armed: ArmedTrade[];
  readonly quoteCalls: string[];
}

function fakeVenue(options: {
  mandates?: readonly VenueMandate[];
  book?: readonly BookRow[];
  quote?: (invoiceId: string) => LiveQuote;
  armThrows?: Error;
}): FakeVenue {
  const armed: ArmedTrade[] = [];
  const quoteCalls: string[] = [];
  return {
    armed,
    quoteCalls,
    async mandates() {
      return options.mandates ?? [mandate()];
    },
    async book() {
      return options.book ?? [row()];
    },
    async quote(invoiceId) {
      quoteCalls.push(invoiceId);
      return (
        options.quote?.(invoiceId) ?? {
          invoiceId,
          quoteId: `quote-${invoiceId}`,
          mandateId: 'mandate-a',
          proceeds: PROCEEDS,
          discount: 82_192n,
          annualisedYieldBps: 1250,
          tenorDays: 60,
          rating: 'A',
          expiresAt: '2026-09-01T00:05:00.000Z',
        }
      );
    },
    async armTrade(input) {
      if (options.armThrows) throw options.armThrows;
      const record: ArmedTrade = {
        invoiceId: input.invoiceId,
        quoteId: input.quoteId,
        status: 402,
        challenge: { x402Version: 2 },
      };
      armed.push(record);
      return record;
    },
  };
}

interface FakeWallet extends WalletClient {
  readonly balanceReads: string[];
  setUsdc(amount: bigint | null): void;
}

function fakeWallet(initialUsdc: bigint | null, decimals = 6): FakeWallet {
  let amount = initialUsdc;
  const balanceReads: string[] = [];
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} must not be called by the loop`);
  };

  return {
    blockchain: 'ARC-TESTNET',
    usdcAddress: '0x3600000000000000000000000000000000000000',
    balanceReads,
    setUsdc(next) {
      amount = next;
    },
    async usdcBalance(walletId): Promise<TokenBalance | null> {
      balanceReads.push(walletId);
      if (amount === null) return null;
      return {
        tokenId: 'token-usdc',
        symbol: 'USDC',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        decimals,
        amount,
        raw: String(amount),
        updatedAt: '2026-09-01T00:00:00.000Z',
      };
    },
    createWalletSet: notUsed('createWalletSet') as unknown as (
      name: string,
    ) => Promise<WalletSetSummary>,
    listWalletSets: notUsed('listWalletSets') as unknown as () => Promise<
      readonly WalletSetSummary[]
    >,
    createWallets: notUsed('createWallets') as unknown as (i: {
      walletSetId: string;
      count: number;
    }) => Promise<readonly WalletSummary[]>,
    listWallets: notUsed('listWallets') as unknown as () => Promise<readonly WalletSummary[]>,
    getWallet: notUsed('getWallet') as unknown as (id: string) => Promise<WalletSummary>,
    tokenBalances: notUsed('tokenBalances') as unknown as (
      id: string,
    ) => Promise<readonly TokenBalance[]>,
    /*
     * Deliberately fatal. The agent arms a trade at the venue; the cash leg is signed
     * against the x402 challenge by the settlement package. If the loop ever moved money
     * itself, this is where the test would find out.
     */
    transferUsdc: notUsed('transferUsdc') as unknown as (
      i: TransferInput,
    ) => Promise<SubmittedTransaction>,
    executeContract: notUsed('executeContract') as unknown as (
      i: ContractCallInput,
    ) => Promise<SubmittedTransaction>,
  };
}

/** $5,000.00 in USDC minor units — enough for one $39.18 invoice, not for a $39,178 one. */
const USDC = (dollars: number): bigint => BigInt(dollars) * 1_000_000n;

let logger: Logger;
beforeEach(() => {
  logger = createLogger({ level: 'error', write: () => {} });
});

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  buyerId: 'buyer-1',
  sellerIds: ['seller-1'],
  walletId: 'wallet-1',
  dryRun: true,
  ...over,
});

/* ── tests ───────────────────────────────────────────────────────────────────────────── */

describe('scale conversion between the invoice and the wallet', () => {
  it('scales cents up to USDC exactly', () => {
    expect(invoiceMinorToUsdc(3_917_808n, 'USD')).toBe(39_178_080_000n);
  });

  it('scales USDC down to cents by truncating, which refuses to spend dust', () => {
    expect(usdcToInvoiceMinor(5_009_999n, 'USD')).toBe(500n);
    expect(usdcToInvoiceMinor(USDC(50_000), 'USD')).toBe(5_000_000n);
  });

  it('round-trips a cent amount without loss', () => {
    expect(usdcToInvoiceMinor(invoiceMinorToUsdc(3_917_808n, 'USD'), 'USD')).toBe(3_917_808n);
  });
});

describe('the balance is read from the chain, not remembered', () => {
  it('reads the wallet before deciding anything', async () => {
    const wallet = fakeWallet(USDC(50_000));
    const venue = fakeVenue({});
    const report = await createMarketMaker(config(), { venue, wallet, logger }).tick();

    expect(wallet.balanceReads).toContain('wallet-1');
    expect(report.walletUsdc).toBe(USDC(50_000));
    expect(report.spendableMinor).toBe(5_000_000n);
    expect(report.taken).toHaveLength(1);
  });

  /*
   * There used to be a second read here, immediately before arming, and it was removed with
   * the pot it guarded. The venue re-decides the rail on every `POST /v1/trades`, so a stale
   * agent-side reading cannot cause a bad settlement — only a wasted arm the venue refuses.
   * Buying that certainty would have cost a mandates fetch per invoice.
   */
  it('reads the wallet once a tick, not once an invoice', async () => {
    const wallet = fakeWallet(USDC(50_000));
    const venue = fakeVenue({
      book: [row({ invoiceId: 'invoice-1' }), row({ invoiceId: 'invoice-2' })],
    });

    await createMarketMaker(config({ dryRun: false }), { venue, wallet, logger }).tick();

    expect(wallet.balanceReads).toHaveLength(1);
  });

  /*
   * THE FIX, stated as the case that used to fail.
   *
   * An empty Circle wallet used to refuse every invoice, because the pre-flight compared it
   * against the invoice price. The wallet pays for neither rail — an escrowed mandate settles
   * out of the Arc vault — so a backed bid with an empty wallet is a bid that trades.
   */
  it('takes a backed bid even when the wallet is empty, because the vault pays', async () => {
    const wallet = fakeWallet(null);
    const venue = fakeVenue({});

    const report = await createMarketMaker(config(), { venue, wallet, logger }).tick();

    expect(report.taken).toHaveLength(1);
    expect(report.refused).toHaveLength(0);
  });

  it('refuses a bid whose capital is not posted on Arc, and says which figures it read', async () => {
    const venue = fakeVenue({ mandates: [{ ...mandate(), vault: UNBACKED }] });

    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.taken).toHaveLength(0);
    expect(report.refused.map((r) => r.refusal.code)).toContain('MANDATE_NOT_ESCROWED');
    // Both sides of the comparison, in the unit they were actually read in.
    expect(report.refused[0]?.humanReason).toMatch(/1000 USDC minor units/);
    expect(report.refused[0]?.humanReason).toMatch(/50000 USDC minor units/);
  });

  /* "We could not read the vault" is not "nobody posted it", and must not read as one. */
  it('does not arm on an unreadable vault, and says it is unknown rather than false', async () => {
    const venue = fakeVenue({
      mandates: [{ ...mandate(), vault: { ...UNBACKED, depositedUsdcMinor: null, backed: false } }],
    });

    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.taken).toHaveLength(0);
    expect(report.refused[0]?.humanReason).toMatch(/could not be read/i);
  });

  /* A venue with no vault at all cannot settle anything this agent can pay for. */
  it('refuses when the venue escrows nothing, naming that rather than a balance', async () => {
    const venue = fakeVenue({ mandates: [{ ...mandate(), vault: null }] });

    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.taken).toHaveLength(0);
    expect(report.refused[0]?.humanReason).toMatch(/does not escrow mandate capital/i);
  });

  it('stops rather than pricing against a scale it does not understand', async () => {
    // USDC reporting 18 decimals would be the native-gas scale leaking into the ERC-20
    // interface — a 10^12 error in every spend, and not something to shrug off.
    const wallet = fakeWallet(USDC(50_000), 18);
    await expect(
      createMarketMaker(config(), { venue: fakeVenue({}), wallet, logger }).tick(),
    ).rejects.toThrow(/18 decimals, expected 6/);
  });
});

describe('the cap is ours, and it binds within a single pass', () => {
  /*
   * The cap that binds is the MANDATE's, and it always was — the wallet cap that used to sit
   * on top of it was measuring a pot that settles neither rail. So this is the same claim
   * the suite always made, tested against the budget that actually decides it: a mandate
   * with room for one invoice does not take two, because the running allocation advances
   * between them.
   */
  it('will not commit the same capital to two invoices', async () => {
    const wallet = fakeWallet(USDC(50_000));
    const venue = fakeVenue({
      // Room for exactly one $39,178 fill.
      mandates: [mandate({ totalCommitted: 4_000_000n, maxPerDebtor: 4_000_000n })],
      book: [row({ invoiceId: 'invoice-1' }), row({ invoiceId: 'invoice-2' })],
      quote: (invoiceId) => ({
        invoiceId,
        quoteId: `quote-${invoiceId}`,
        mandateId: 'mandate-a',
        proceeds: PROCEEDS,
        discount: 82_192n,
        annualisedYieldBps: 1250,
        tenorDays: 60,
        rating: 'A',
        expiresAt: '2026-09-01T00:05:00.000Z',
      }),
    });

    const report = await createMarketMaker(config(), { venue, wallet, logger }).tick();

    expect(report.taken).toHaveLength(1);
    expect(report.committedThisTick).toBe(PROCEEDS);
    const shortfall = report.refused.find((r) => r.refusal.code === 'EXPOSURE_EXHAUSTED');
    expect(shortfall?.invoiceId).toBe('invoice-2');
  });

  it('takes both when the wallet covers both', async () => {
    const wallet = fakeWallet(USDC(100_000));
    const venue = fakeVenue({
      book: [row({ invoiceId: 'invoice-1' }), row({ invoiceId: 'invoice-2' })],
    });

    const report = await createMarketMaker(config(), { venue, wallet, logger }).tick();
    expect(report.taken).toHaveLength(2);
    expect(report.committedThisTick).toBe(PROCEEDS * 2n);
  });

  it('respects the mandate’s own ceiling even when the wallet is deep', async () => {
    // The wallet holds $1,000,000; the mandate is only funded for $50,000.
    const wallet = fakeWallet(USDC(1_000_000));
    const venue = fakeVenue({
      mandates: [mandate({ totalCommitted: 5_000_000n, maxPerDebtor: 5_000_000n })],
      book: [row({ invoiceId: 'invoice-1' }), row({ invoiceId: 'invoice-2' })],
    });

    const report = await createMarketMaker(config(), { venue, wallet, logger }).tick();
    expect(report.taken).toHaveLength(1);
    expect(report.refused.map((r) => r.refusal.code)).toContain('EXPOSURE_EXHAUSTED');
  });

  it('respects the per-customer cap across two invoices from one debtor', async () => {
    const wallet = fakeWallet(USDC(1_000_000));
    const venue = fakeVenue({
      mandates: [mandate({ maxPerDebtor: 5_000_000n })],
      book: [
        row({ invoiceId: 'invoice-1', debtorId: 'debtor-1' }),
        row({ invoiceId: 'invoice-2', debtorId: 'debtor-1' }),
        row({ invoiceId: 'invoice-3', debtorId: 'debtor-2' }),
      ],
    });

    const report = await createMarketMaker(config(), { venue, wallet, logger }).tick();

    expect(report.taken.map((t) => t.acceptance.invoiceId).sort()).toEqual([
      'invoice-1',
      'invoice-3',
    ]);
    const refusal = report.refused.find((r) => r.invoiceId === 'invoice-2');
    expect(refusal?.refusal.code).toBe('DEBTOR_CONCENTRATION');
  });
});

describe('what the agent will not touch', () => {
  it('refuses an invoice the debtor has not confirmed, by name', async () => {
    const venue = fakeVenue({ book: [row({ status: 'draft', quotable: false })] });
    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.taken).toHaveLength(0);
    const refusal = report.refused.find((r) => r.refusal.code === 'INVOICE_NOT_CONFIRMED');
    expect(refusal?.mandateId).toBeNull();
    expect(refusal?.humanReason).toMatch(/cannot be priced/);
  });

  it('skips an invoice whose ATS bond has not been deployed yet', async () => {
    // Issuance is paced and off the critical path, so the book carries it before the
    // instrument exists. Arming would be refused as `issuance_pending`.
    const venue = fakeVenue({ book: [row({ issued: false })] });
    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(venue.armed).toHaveLength(0);
    expect(venue.quoteCalls).toHaveLength(0);
    expect(report.taken[0]?.skippedReason).toBe('issuance_pending');
  });

  it('skips a mandate that is not denominated in the settlement asset', async () => {
    // The wallet settles USDC. A EUR mandate would draw on a EURC balance nobody read.
    const venue = fakeVenue({ mandates: [mandate({ currency: 'EUR' })] });
    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.mandatesQuoting).toBe(0);
    expect(report.taken).toHaveLength(0);
  });

  it('does not quote an unfunded mandate', async () => {
    const venue = fakeVenue({ mandates: [mandate({ status: 'funding' })] });
    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.mandatesConsidered).toBe(1);
    expect(report.mandatesQuoting).toBe(0);
    expect(report.taken).toHaveLength(0);
  });

  it('does not arm when the venue matched a different mandate', async () => {
    const venue = fakeVenue({
      quote: (invoiceId) => ({
        invoiceId,
        quoteId: 'quote-1',
        mandateId: 'someone-elses-mandate',
        proceeds: PROCEEDS,
        discount: 82_192n,
        annualisedYieldBps: 1200,
        tenorDays: 60,
        rating: 'A',
        expiresAt: '2026-09-01T00:05:00.000Z',
      }),
    });

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(venue.armed).toHaveLength(0);
    expect(report.taken[0]?.skippedReason).toBe('matched_elsewhere:someone-elses-mandate');
  });

  it('does not fill outside the slippage tolerance it was given', async () => {
    const dearer = (invoiceId: string): LiveQuote => ({
      invoiceId,
      quoteId: 'quote-1',
      mandateId: 'mandate-a',
      // The venue now wants $100 more for the paper than the mandate priced.
      proceeds: PROCEEDS + 10_000n,
      discount: 72_192n,
      annualisedYieldBps: 1250,
      tenorDays: 60,
      rating: 'A',
      expiresAt: '2026-09-01T00:05:00.000Z',
    });

    const strict = fakeVenue({ quote: dearer });
    const strictReport = await createMarketMaker(config({ dryRun: false, maxSlippageBps: 0 }), {
      venue: strict,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();
    expect(strict.armed).toHaveLength(0);
    expect(strictReport.taken[0]?.skippedReason).toMatch(/^outside_tolerance:/);

    const lenient = fakeVenue({ quote: dearer });
    await createMarketMaker(config({ dryRun: false, maxSlippageBps: 100 }), {
      venue: lenient,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();
    expect(lenient.armed).toHaveLength(1);
  });

  it('restricts itself to the mandates it was configured to operate', async () => {
    const venue = fakeVenue({
      mandates: [mandate(), mandate({ id: 'mandate-b' })],
    });
    const report = await createMarketMaker(config({ mandateIds: ['mandate-b'] }), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.mandatesConsidered).toBe(1);
    expect(report.taken[0]?.acceptance.mandateId).toBe('mandate-b');
  });
});

describe('dry run', () => {
  it('is the default, and arms nothing', async () => {
    const venue = fakeVenue({});
    const report = await createMarketMaker(
      { buyerId: 'buyer-1', sellerIds: ['seller-1'], walletId: 'wallet-1' },
      { venue, wallet: fakeWallet(USDC(50_000)), logger },
    ).tick();

    expect(venue.armed).toHaveLength(0);
    expect(report.taken).toHaveLength(1);
    expect(report.taken[0]?.skippedReason).toBe('dry_run');
    // Still reports what it would have taken, and at what price.
    expect(report.taken[0]?.acceptance.proceeds).toBe(PROCEEDS);
  });
});

describe('failure handling', () => {
  it('records an arming failure without losing the local commitment', async () => {
    // Whether the venue took the allocation is unknown from here, and assuming it did not
    // is the direction that double-spends. The budget stays spent until the next tick
    // re-reads the venue's own figure.
    const venue = fakeVenue({ armThrows: new Error('venue exploded') });
    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(USDC(50_000)),
      logger,
    }).tick();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('venue exploded');
    expect(report.committedThisTick).toBe(PROCEEDS);
  });
});

describe('pickBest', () => {
  const acceptance = (over: Partial<MandateAcceptance>): MandateAcceptance => ({
    mandateId: 'mandate-a',
    invoiceId: 'invoice-1',
    debtorId: 'debtor-1',
    faceValue: 4_000_000n,
    discount: 82_192n,
    proceeds: PROCEEDS,
    annualisedYieldBps: 1250,
    tenorDays: 60,
    currency: 'USD',
    ...over,
  });

  const termsMap = new Map<string, MandateTerms>([
    ['mandate-a', { ...TERMS, id: 'mandate-a', totalCommitted: 10_000_000n }],
    ['mandate-b', { ...TERMS, id: 'mandate-b', totalCommitted: 90_000_000n }],
  ]);
  const allocMap = new Map<string, MandateAllocations>([
    ['mandate-a', { total: 0n, byDebtor: {} }],
    ['mandate-b', { total: 0n, byDebtor: {} }],
  ]);

  it('returns null when nothing was accepted', () => {
    expect(pickBest([], termsMap, allocMap, 'debtor-1')).toBeNull();
  });

  it('prefers the lowest yield — the smallest discount, i.e. most money for the seller', () => {
    const best = pickBest(
      [
        acceptance({ mandateId: 'mandate-a', annualisedYieldBps: 1250 }),
        acceptance({ mandateId: 'mandate-b', annualisedYieldBps: 800 }),
      ],
      termsMap,
      allocMap,
      'debtor-1',
    );
    expect(best?.mandateId).toBe('mandate-b');
  });

  it('breaks a tie on price by depth, spreading the book instead of exhausting one bid', () => {
    const best = pickBest(
      [acceptance({ mandateId: 'mandate-a' }), acceptance({ mandateId: 'mandate-b' })],
      termsMap,
      allocMap,
      'debtor-1',
    );
    expect(best?.mandateId).toBe('mandate-b');
  });

  it('is deterministic when price and depth are identical', () => {
    const evenTerms = new Map<string, MandateTerms>([
      ['mandate-z', { ...TERMS, id: 'mandate-z' }],
      ['mandate-a', { ...TERMS, id: 'mandate-a' }],
    ]);
    const evenAlloc = new Map<string, MandateAllocations>([
      ['mandate-z', { total: 0n, byDebtor: {} }],
      ['mandate-a', { total: 0n, byDebtor: {} }],
    ]);
    const input = [acceptance({ mandateId: 'mandate-z' }), acceptance({ mandateId: 'mandate-a' })];

    expect(pickBest(input, evenTerms, evenAlloc, 'debtor-1')?.mandateId).toBe('mandate-a');
    expect(pickBest([...input].reverse(), evenTerms, evenAlloc, 'debtor-1')?.mandateId).toBe(
      'mandate-a',
    );
  });
});
