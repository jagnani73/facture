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
import {
  CashLegError,
  type CashLegSigner,
  type PaymentChallenge,
  type PaymentPayload,
} from '../src/cash.js';
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

/**
 * A challenge shaped like the venue's own, down to the facilitator's fee payer.
 *
 * The amounts are the settlement asset's smallest unit — tinybars, at the venue's ppm
 * scale — deliberately *not* equal to the invoice's proceeds in cents. A fixture where the
 * two matched would let a bug that compared the wrong one pass.
 */
const CHALLENGE: PaymentChallenge = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'hedera:testnet',
      asset: '0.0.0',
      amount: '3918',
      payTo: '0.0.10311549',
      maxTimeoutSeconds: 120,
      extra: { feePayer: '0.0.7162784' },
    },
  ],
};

/* ── fakes ───────────────────────────────────────────────────────────────────────────── */

interface FakeVenue extends VenueClient {
  readonly armed: ArmedTrade[];
  /** Every payload the agent actually presented. Empty means nothing was ever paid. */
  readonly settles: { invoiceId: string; payment: PaymentPayload }[];
  readonly quoteCalls: string[];
}

function fakeVenue(options: {
  mandates?: readonly VenueMandate[];
  book?: readonly BookRow[];
  quote?: (invoiceId: string) => LiveQuote;
  armThrows?: Error;
  /**
   * The venue's answer to arming. Defaults to `402` — the x402 rail — because that is the
   * branch with something to sign. Pass `200` for a mandate it settles out of Arc escrow.
   */
  armStatus?: number;
  /** `null` reproduces a 402 whose `payment-required` header could not be read. */
  challenge?: PaymentChallenge | null;
  settleThrows?: Error;
}): FakeVenue {
  const armed: ArmedTrade[] = [];
  const settles: { invoiceId: string; payment: PaymentPayload }[] = [];
  const quoteCalls: string[] = [];
  return {
    armed,
    settles,
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
      const status = options.armStatus ?? 402;
      const challenge =
        status === 402 ? (options.challenge === undefined ? CHALLENGE : options.challenge) : null;
      const record: ArmedTrade = {
        invoiceId: input.invoiceId,
        quoteId: input.quoteId,
        status,
        rail:
          status === 402
            ? { chosen: 'x402', reason: 'This bid holds no capital on Arc.' }
            : { chosen: 'arc-vault', reason: 'The buyer escrowed this capital on Arc.' },
        challenge,
        challengeError: status === 402 && challenge === null ? 'no payment-required header' : null,
        // Both legs only on the 200, where arming *was* the settlement. See `ArmedTrade`.
        cashLeg:
          status === 402
            ? null
            : {
                chain: 'arc',
                rail: 'arc-vault',
                state: 'settled',
                transaction: '0x96c5c8625dde0c10b5469aa05cab572ac33c01504f391bae551b285091094318',
                settledAmountMinor: '3918',
                explorerUrl: null,
              },
        assetLeg:
          status === 402
            ? null
            : {
                state: 'executed',
                transactionId: '0.0.10311549@1788439835.810844400',
                unitsMinor: '4000000',
                explorerUrl: null,
              },
        settledAt: status === 402 ? null : '2026-09-03T00:00:00.000Z',
      };
      armed.push(record);
      return record;
    },
    async settleTrade(input) {
      if (options.settleThrows) throw options.settleThrows;
      settles.push({ invoiceId: input.invoiceId, payment: input.payment });
      return {
        invoiceId: input.invoiceId,
        tradeId: 'trade-1',
        settledAt: '2026-09-03T00:00:00.000Z',
        cashLeg: {
          chain: 'hedera',
          rail: 'x402',
          state: 'settled',
          transaction: '0.0.7162784@1788268815.161410978',
          settledAmountMinor: '3918',
          explorerUrl: null,
        },
        assetLeg: {
          state: 'executed',
          transactionId: '0.0.10311549@1788268822.126538150',
          unitsMinor: '4000000',
          explorerUrl: null,
        },
      };
    },
  };
}

interface FakeCash extends CashLegSigner {
  /** Every challenge this key was asked to sign. */
  readonly signCalls: PaymentChallenge[];
  readonly balanceReads: number[];
}

/** The buyer's Hedera key, without a ledger behind it. Holds ~48 HBAR by default. */
function fakeCash(options: { balanceTinybars?: bigint | null; signThrows?: Error } = {}): FakeCash {
  const signCalls: PaymentChallenge[] = [];
  const balanceReads: number[] = [];
  return {
    payerAccountId: '0.0.10314099',
    network: 'hedera:testnet',
    signCalls,
    balanceReads,
    async balanceTinybars() {
      balanceReads.push(balanceReads.length + 1);
      return options.balanceTinybars === undefined ? 4_827_974_750n : options.balanceTinybars;
    },
    async sign(challenge) {
      if (options.signThrows) throw options.signThrows;
      signCalls.push(challenge);
      const accepted = challenge.accepts[0];
      if (accepted === undefined) throw new Error('fixture has no requirements');
      return {
        payload: { x402Version: challenge.x402Version, accepted, payload: { transaction: 'CgUI' } },
        amount: BigInt(accepted.amount),
        asset: accepted.asset,
        network: accepted.network,
        payTo: accepted.payTo,
        feePayer: '0.0.7162784',
      };
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
    expect(report.refused.map((r) => r.refusal.code)).toContain('CASH_LEG_UNPAYABLE');
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
    expect(report.refused[0]?.humanReason).toMatch(/escrows no mandate capital/i);
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

/**
 * Which rail carried the cash, and whether the agent actually paid.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS BLOCK EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * The agent could not reach the x402 rail. Not because it stopped at the challenge — the
 * challenge never arrived. Its pre-flight refused any mandate that was not escrowed on Arc,
 * and the venue settles an escrowed mandate out of the vault, so every trade it was willing
 * to arm came back 200 and no signature was ever needed. A whole branch, complete with a log
 * line describing the signature it was waiting for, that nothing could execute.
 *
 * Nothing errored. No test failed. That is what makes it worth a block of its own: the tests
 * below fail if either half of that is reinstated — the gate closing over unescrowed bids, or
 * the settle step being dropped once a challenge is in hand.
 */
describe('the two cash rails', () => {
  /** A bid with capital in the vault, and one without. The second is the interesting case. */
  const BACKED_BID = [mandate()];
  const UNBACKED_BID = [{ ...mandate(), vault: UNBACKED }];

  it('signs and settles an unescrowed bid over x402, which it could not previously reach', async () => {
    const venue = fakeVenue({ mandates: UNBACKED_BID, armStatus: 402 });
    const cash = fakeCash();

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(report.refused).toHaveLength(0);
    expect(report.taken).toHaveLength(1);

    // Armed, then paid. Both halves, against one venue route.
    expect(venue.armed).toHaveLength(1);
    expect(venue.settles).toHaveLength(1);
    expect(cash.signCalls).toHaveLength(1);

    const taken = report.taken[0];
    expect(taken?.armedStatus).toBe(402);
    expect(taken?.settlement?.rail).toBe('x402');
    expect(taken?.settlement?.chain).toBe('hedera');
    expect(taken?.settlement?.cashTransaction).toBe('0.0.7162784@1788268815.161410978');
    expect(taken?.settlement?.assetTransaction).toBe('0.0.10311549@1788268822.126538150');
  });

  /*
   * The payload is the canonical v2 `PaymentPayload` — `{ x402Version, accepted, payload }`.
   * `accepted` is not redundancy: the facilitator checks the signed transfer against the
   * requirements the resource server hands it, and a payload that did not say which option it
   * took could not be matched to the right one.
   */
  it('presents the requirements it signed, not just the signature', async () => {
    const venue = fakeVenue({ mandates: UNBACKED_BID });
    const cash = fakeCash();

    await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    const payment = venue.settles[0]?.payment;
    expect(payment?.x402Version).toBe(2);
    expect(payment?.accepted.network).toBe('hedera:testnet');
    expect(payment?.accepted.extra['feePayer']).toBe('0.0.7162784');
    expect(payment?.payload).toHaveProperty('transaction');
  });

  /*
   * The other rail, and the reason there is no second consent on it: the buyer escrowed the
   * capital and wrote the terms, so an invoice meeting those terms is a trade they already
   * agreed to. Asking them to sign again would make a standing bid not standing.
   */
  it('settles a backed bid out of escrow, signing nothing at all', async () => {
    const venue = fakeVenue({ mandates: BACKED_BID, armStatus: 200 });
    const cash = fakeCash();

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(report.taken).toHaveLength(1);
    expect(venue.settles).toHaveLength(0);
    expect(cash.signCalls).toHaveLength(0);

    const taken = report.taken[0];
    expect(taken?.armedStatus).toBe(200);
    expect(taken?.settlement?.rail).toBe('arc-vault');
    expect(taken?.settlement?.chain).toBe('arc');
  });

  /*
   * The rail is read from the venue's own answer rather than inferred from which branch ran.
   * `chooseRail` re-reads the vault on every arm and is the authority, so a bid this process
   * predicted would take Arc can legitimately come back as a challenge — and the receipt has
   * to say what happened, not what was expected.
   */
  it('reports the rail the venue chose, not the one the pre-flight predicted', async () => {
    // Backed, so the pre-flight expects Arc — and the venue answers 402 anyway.
    const venue = fakeVenue({ mandates: BACKED_BID, armStatus: 402 });
    const cash = fakeCash();

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(report.taken[0]?.settlement?.rail).toBe('x402');
    expect(venue.settles).toHaveLength(1);
  });

  it('does not sign when the venue offers a challenge it cannot read', async () => {
    const venue = fakeVenue({ mandates: UNBACKED_BID, challenge: null });
    const cash = fakeCash();

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(report.taken[0]?.skippedReason).toBe('unreadable_challenge');
    expect(report.taken[0]?.settlement).toBeNull();
    expect(cash.signCalls).toHaveLength(0);
    expect(venue.settles).toHaveLength(0);
  });

  /*
   * A challenge for a chain or asset this key cannot pay is reported, never guessed at. The
   * agent has already armed by this point, so the honest outcome is a named skip and a held
   * position the venue reclaims — not a payload built on an assumption.
   */
  it('reports an unsupported challenge rather than signing something else', async () => {
    const venue = fakeVenue({ mandates: UNBACKED_BID });
    const cash = fakeCash({
      signThrows: new CashLegError('this payer settles native HBAR', 'unsupported'),
    });

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(report.taken[0]?.skippedReason).toBe('unsigned:unsupported');
    expect(venue.settles).toHaveLength(0);
    // Not an error: an unpayable challenge is an outcome of this configuration, not a fault.
    expect(report.errors).toHaveLength(0);
  });

  it('refuses an unescrowed bid outright when it holds no key, rather than arming it', async () => {
    const venue = fakeVenue({ mandates: UNBACKED_BID });

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      // No `cash`. The rail is not fitted.
    }).tick();

    expect(report.taken).toHaveLength(0);
    expect(venue.armed).toHaveLength(0);
    expect(report.refused.map((r) => r.refusal.code)).toContain('CASH_LEG_UNPAYABLE');
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════
   * THE ONE AMOUNT COMPARISON THIS AGENT MAKES
   * ═══════════════════════════════════════════════════════════════════════════════════
   *
   * Tinybars against tinybars, both named by the challenge and the mirror node in the same
   * unit. Nothing is converted, so there is no scale to get wrong — which is the whole
   * reason the check lives here and not in the pre-flight, where a price would have to be
   * converted and the venue's ppm scale copied into this package.
   *
   * The balance is read once per tick and the mirror node lags a signature by seconds, so
   * what earlier signatures in the same pass promised has to be tracked locally.
   */
  it('will not promise the same tinybar to two invoices in one pass', async () => {
    const venue = fakeVenue({
      mandates: UNBACKED_BID,
      book: [
        row({ invoiceId: 'invoice-1', debtorId: 'debtor-1' }),
        row({ invoiceId: 'invoice-2', debtorId: 'debtor-2' }),
      ],
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
    // The challenge asks 3,918 tinybars; this covers one payment and not two.
    const cash = fakeCash({ balanceTinybars: 5_000n });

    const report = await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    // Both were armed — the mandate has headroom for both — and only one was paid for.
    expect(venue.armed).toHaveLength(2);
    expect(venue.settles).toHaveLength(1);

    const short = report.taken.find((t) => t.skippedReason?.startsWith('x402_balance_short'));
    expect(short?.skippedReason).toBe('x402_balance_short:3918');
    expect(short?.settlement).toBeNull();
  });

  it('reads the payer once a tick, not once an invoice', async () => {
    const venue = fakeVenue({
      mandates: UNBACKED_BID,
      book: [
        row({ invoiceId: 'invoice-1', debtorId: 'debtor-1' }),
        row({ invoiceId: 'invoice-2', debtorId: 'debtor-2' }),
      ],
    });
    const cash = fakeCash();

    await createMarketMaker(config({ dryRun: false }), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(cash.balanceReads).toHaveLength(1);
  });

  /*
   * A dry run reads and reports. It must not sign, because a signature is the money moving —
   * there is no dry version of it, and the venue's 402 is issued against a real hold.
   */
  it('signs nothing in a dry run, and does not arm to find out', async () => {
    const venue = fakeVenue({ mandates: UNBACKED_BID });
    const cash = fakeCash();

    const report = await createMarketMaker(config(), {
      venue,
      wallet: fakeWallet(null),
      logger,
      cash,
    }).tick();

    expect(report.taken[0]?.skippedReason).toBe('dry_run');
    expect(venue.armed).toHaveLength(0);
    expect(venue.settles).toHaveLength(0);
    expect(cash.signCalls).toHaveLength(0);
  });

  /*
   * Reported even when no trade took that rail. "The agent took nothing" and "the agent
   * could not have paid for anything" are different facts and look identical in a tick
   * summary otherwise.
   */
  it('reports what the payer could do, whether or not it did anything', async () => {
    const withKey = await createMarketMaker(config(), {
      venue: fakeVenue({ mandates: UNBACKED_BID }),
      wallet: fakeWallet(null),
      logger,
      cash: fakeCash(),
    }).tick();
    expect(withKey.x402).toEqual({ configured: true, balanceTinybars: 4_827_974_750n });

    const withoutKey = await createMarketMaker(config(), {
      venue: fakeVenue({ mandates: UNBACKED_BID }),
      wallet: fakeWallet(null),
      logger,
    }).tick();
    expect(withoutKey.x402).toEqual({ configured: false, balanceTinybars: null });
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
