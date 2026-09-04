import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, stringToHex, toHex, zeroHash } from 'viem';

const { viem, networkHelpers } = await hre.network.getOrCreate();

// Enum ordinals, mirrored from contracts/libraries/FactureTypes.sol. Their ORDER is load-bearing on
// the Solidity side (rating is compared with `>=`), so a change there should break these constants
// loudly rather than quietly reprice the book.
const Rating = { D: 0, Unrated: 1, C: 2, B: 3, A: 4 } as const;
const InvoiceStatus = {
  Unknown: 0,
  Draft: 1,
  Confirmed: 2,
  Matched: 3,
  Settled: 4,
  Repaid: 5,
  Defaulted: 6,
  Cancelled: 7,
} as const;
const MandateStatus = { Uninitialised: 0, Active: 1, Paused: 2, Closed: 3 } as const;
const MatchStatus = { Uninitialised: 0, Open: 1, Settled: 2, Cancelled: 3, Matured: 4 } as const;
const LegKind = { Unspecified: 0, Delivery: 1, Payment: 2 } as const;

const reason = (code: string) => stringToHex(code, { size: 32 });

const DAY = 86_400n;
// Must exceed DvpEscrow.MAX_LOCK_DURATION (2 days) — the book's constructor now enforces it, since
// a shorter window would let an allocation be cancelled while the delivery leg was still claimable.
const SETTLEMENT_WINDOW = 3n * DAY;

// The book records its cash leg declaratively — it cannot read Arc — so these are just the values
// an operator would pass. Nothing on-chain verifies them, which is the point being tested elsewhere.
const CASH_LEG_CHAIN_ID = 5_042_002n;
const CASH_LEG_VAULT = '0x00000000000000000000000000000000000000AC' as const;

// Deposit references are minted by the vault on Arc. The book only ever sees them as opaque,
// single-use bytes32, so the tests mint their own.
let depositCounter = 0;
const nextDepositRef = (): `0x${string}` => keccak256(toHex(`deposit:${++depositCounter}`));

const FACE = 40_000_000_000n; // $40,000.000000 at six decimals
const YIELD_BPS = 800; // 8.00%
const TENOR_DAYS = 60;
const MAX_TENOR = 90;

const DEBTOR_A = keccak256(toHex('debtor:meridian-fabrication'));
const DEBTOR_B = keccak256(toHex('debtor:northgate-logistics'));

// The instrument is a real ERC-20 in these tests rather than a placeholder address, because
// settlement and maturity now both interrogate it: settlement checks the escrowed asset, maturity
// asks it who holds the paper. `MockUSDC` stands in for the ATS diamond's ERC-20 facade, which is
// how the venue reaches a security token on Hedera anyway.
const BOND_UNITS = 40_000n;

// One preimage, one hash. DvpEscrow hashes `abi.encodePacked(secret)`, which for a bytes32 is the
// 32 bytes themselves.
const SECRET = keccak256(toHex('facture:delivery-preimage'));
const SECRET_HASH = keccak256(SECRET);
const HOUR = 3_600n;

describe('MandateBook', () => {
  async function deploy() {
    const [owner, buyer, seller, matcher, settler, attester, stranger] =
      await viem.getWalletClients();
    assert.ok(owner && buyer && seller && matcher && settler && attester && stranger);

    const publicClient = await viem.getPublicClient();
    const invoices = await viem.deployContract('MockInvoiceRegistry', []);
    const gate = await viem.deployContract('MockComplianceGate', []);
    const bond = await viem.deployContract('MockUSDC', []);

    // The delivery-leg escrow deploys BEFORE the book, which records it as an immutable and reads
    // every settlement proof out of it. Same direction of dependency as the Arc side, where the
    // payment escrow deploys before the vault.
    const escrow = await viem.deployContract('DvpEscrow', []);

    // No settlement token here. The book holds no capital — it holds an attested view of what the
    // Arc-side MandateVault holds. See MandateVault.test.ts for the custody side.
    const book = await viem.deployContract('MandateBook', [
      invoices.address,
      gate.address,
      escrow.address,
      owner.account.address,
      attester.account.address,
      CASH_LEG_CHAIN_ID,
      CASH_LEG_VAULT,
      SETTLEMENT_WINDOW,
    ]);

    await book.write.setMatcher([matcher.account.address, true]);
    await book.write.setSettler([settler.account.address, true]);

    return {
      publicClient,
      invoices,
      gate,
      bond,
      escrow,
      book,
      owner,
      buyer,
      seller,
      matcher,
      settler,
      attester,
      stranger,
    };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;

  /** Post a mandate and escrow `amount` against it. Returns the mandate id. */
  async function postAndFund(
    ctx: Ctx,
    amount: bigint,
    overrides: Partial<{
      minRating: number;
      maxTenorDays: number;
      yieldBps: number;
      maxPerDebtor: bigint;
    }> = {},
  ): Promise<bigint> {
    const { book, buyer } = ctx;
    const minRating = overrides.minRating ?? Rating.A;
    const maxTenorDays = overrides.maxTenorDays ?? MAX_TENOR;
    const yieldBps = overrides.yieldBps ?? YIELD_BPS;
    const maxPerDebtor = overrides.maxPerDebtor ?? 200_000_000_000n;

    await book.write.postMandate([minRating, maxTenorDays, yieldBps, maxPerDebtor], {
      account: buyer.account,
    });
    const mandateId = await book.read.mandateCount();

    if (amount > 0n) {
      // Stands in for: buyer deposits on Arc -> attester relays the Deposited event here.
      await ctx.book.write.creditFunding(
        [mandateId, buyer.account.address, amount, nextDepositRef()],
        { account: ctx.attester.account },
      );
    }

    return mandateId;
  }

  /**
   * List an invoice whose tenor is exactly `tenorDays` at match time.
   *
   * `dueDate` is set to the current block timestamp plus a whole number of days. The book computes
   * tenor with CEILING division, so any elapsed time strictly inside one day still rounds back up to
   * `tenorDays` - which is what keeps the expected price deterministic without freezing the clock.
   */
  async function listInvoice(
    ctx: Ctx,
    invoiceId: `0x${string}`,
    overrides: Partial<{
      rating: number;
      status: number;
      tenorDays: number;
      faceValue: bigint;
      debtorId: `0x${string}`;
      instrument: `0x${string}`;
    }> = {},
  ): Promise<void> {
    const { invoices, publicClient, seller } = ctx;
    const now = (await publicClient.getBlock()).timestamp;
    const tenorDays = overrides.tenorDays ?? TENOR_DAYS;

    await invoices.write.setInvoice([
      invoiceId,
      {
        instrument: overrides.instrument ?? ctx.bond.address,
        rating: overrides.rating ?? Rating.A,
        status: overrides.status ?? InvoiceStatus.Confirmed,
        dueDate: now + BigInt(tenorDays) * DAY,
        debtorId: overrides.debtorId ?? DEBTOR_A,
        seller: seller.account.address,
        faceValue: overrides.faceValue ?? FACE,
        uniquenessHash: keccak256(invoiceId),
      },
    ]);
  }

  /**
   * Run the delivery leg for a match: the seller escrows the bond for the buyer in the venue's
   * escrow, and the buyer claims it by revealing the preimage.
   *
   * That claim is the ONLY thing that produces a settlement proof, and it can only be produced by
   * the buyer, because `DvpEscrow.claim` refuses anyone but the beneficiary. Every override below
   * exists so a test can break one property of the lock and check that the book refuses it.
   */
  async function deliver(
    ctx: Ctx,
    matchId: `0x${string}`,
    overrides: Partial<{
      lockId: `0x${string}`;
      tradeRef: `0x${string}`;
      depositor: Ctx['seller'];
      beneficiary: Ctx['buyer'];
      token: Ctx['bond'];
      kind: number;
      claim: boolean;
    }> = {},
  ): Promise<`0x${string}`> {
    const depositor = overrides.depositor ?? ctx.seller;
    const beneficiary = overrides.beneficiary ?? ctx.buyer;
    const token = overrides.token ?? ctx.bond;
    const lockId = overrides.lockId ?? keccak256(toHex(`lock:${matchId}`));
    const now = (await ctx.publicClient.getBlock()).timestamp;

    await token.write.mint([depositor.account.address, BOND_UNITS]);
    await token.write.approve([ctx.escrow.address, BOND_UNITS], { account: depositor.account });

    await ctx.escrow.write.openLock(
      [
        lockId,
        SECRET_HASH,
        overrides.tradeRef ?? matchId,
        beneficiary.account.address,
        token.address,
        BOND_UNITS,
        now + 2n * HOUR,
        overrides.kind ?? LegKind.Delivery,
      ],
      { account: depositor.account },
    );

    if (overrides.claim !== false) {
      await ctx.escrow.write.claim([lockId, SECRET], { account: beneficiary.account });
    }

    return lockId;
  }

  const INV_1 = keccak256(toHex('invoice:1'));
  const INV_2 = keccak256(toHex('invoice:2'));

  // ---------------------------------------------------------------------------------------------
  // Pricing
  // ---------------------------------------------------------------------------------------------

  describe('pricing', () => {
    /**
     * The product's canonical example, pinned so the day-count convention cannot drift silently.
     * $40,000 face, 60 days, 12.5% annualised, simple discount on face, ACT/365:
     *   discount = 40_000_000_000 * 1250 * 60 / (10_000 * 365) = 821_917_808  (floored)
     *   price    = 39_178_082_192                                -> $39,178.08
     * These are the same figures the root README quotes; if either moves, this fails.
     */
    it("matches the product's canonical quote", async () => {
      const { book } = await deploy();
      assert.equal(await book.read.previewPrice([FACE, TENOR_DAYS, 1_250]), 39_178_082_192n);
    });

    it('prices on a simple ACT/365 discount basis', async () => {
      const { book } = await deploy();
      assert.equal(await book.read.previewPrice([FACE, TENOR_DAYS, YIELD_BPS]), 39_473_972_603n);
    });

    /** Rounding is toward the seller: the discount floors, so the price never rounds down on them. */
    it('floors the discount, favouring the seller by at most one unit', async () => {
      const { book } = await deploy();
      // 1_000_001 * 800 * 1 / 3_650_000 = 219.17... -> 219 discount, price 1_000_000_000... check the
      // exact arithmetic rather than the direction alone.
      const face = 1_000_001n;
      const expected = face - (face * 800n * 1n) / 3_650_000n;
      assert.equal(await book.read.previewPrice([face, 1, 800]), expected);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Escrow and allocation - the property that makes a quote firm
  // ---------------------------------------------------------------------------------------------

  describe('attested capital', () => {
    it('records credited capital and reports it as unallocated', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);

      assert.equal(await ctx.book.read.unallocated([id]), 100_000_000_000n);
    });

    /**
     * The replay guard on the attestation path. An honest relay retrying a dropped transaction and a
     * malicious relay double-crediting are indistinguishable from the book's side, so both are
     * refused by the same check — otherwise a single Arc deposit could inflate the attested balance
     * without bound, which is precisely the direction that is NOT safe.
     */
    it('credits a vault deposit reference exactly once', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 0n);
      const ref = nextDepositRef();
      const from = { account: ctx.attester.account };

      await ctx.book.write.creditFunding([id, ctx.buyer.account.address, 1_000_000n, ref], from);
      assert.equal(await ctx.book.read.isDepositCredited([ref]), true);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.creditFunding([id, ctx.buyer.account.address, 1_000_000n, ref], from),
        ctx.book,
        'DepositAlreadyCredited',
      );

      assert.equal(await ctx.book.read.unallocated([id]), 1_000_000n);
    });

    it('only the attester may credit funding', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 0n);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.creditFunding(
          [id, ctx.buyer.account.address, 1_000_000n, nextDepositRef()],
          { account: ctx.buyer.account },
        ),
        ctx.book,
        'NotAttester',
      );
    });

    it('records its cash leg declaratively', async () => {
      const ctx = await deploy();
      const [chainId, vault] = await ctx.book.read.cashLeg();
      assert.equal(chainId, CASH_LEG_CHAIN_ID);
      assert.equal(vault.toLowerCase(), CASH_LEG_VAULT.toLowerCase());
    });

    /**
     * The headline invariant. A mandate funded with exactly one invoice's worth of capital takes the
     * first invoice and refuses the second - deterministically, because allocation is a state write
     * and not a check against a live wallet balance.
     */
    it('cannot allocate beyond its funded balance', async () => {
      const ctx = await deploy();
      const price = await ctx.book.read.previewPrice([FACE, TENOR_DAYS, YIELD_BPS]);
      const id = await postAndFund(ctx, price);

      await listInvoice(ctx, INV_1);
      await listInvoice(ctx, INV_2);

      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
      assert.equal(await ctx.book.read.unallocated([id]), 0n);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_2, id], { account: ctx.matcher.account }),
        ctx.book,
        'InsufficientUnallocated',
      );

      // The refused match left nothing behind.
      assert.equal(await ctx.book.read.unallocated([id]), 0n);
      assert.equal(await ctx.book.read.matchOfInvoice([INV_2]), zeroHash);
    });

    it('refuses to release capital that is allocated to an open match', async () => {
      const ctx = await deploy();
      const price = await ctx.book.read.previewPrice([FACE, TENOR_DAYS, YIELD_BPS]);
      const id = await postAndFund(ctx, price + 1_000n);

      await listInvoice(ctx, INV_1);
      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });

      // Only the 1_000 surplus is free.
      assert.equal(await ctx.book.read.unallocated([id]), 1_000n);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.authoriseRelease([id, 1_001n], { account: ctx.buyer.account }),
        ctx.book,
        'InsufficientUnallocated',
      );

      await ctx.book.write.authoriseRelease([id, 1_000n], { account: ctx.buyer.account });
      assert.equal(await ctx.book.read.unallocated([id]), 0n);
    });

    /**
     * The ordering that makes an attested balance safe: the book gives up its claim BEFORE the vault
     * is opened. Between the two steps it under-counts, never over-counts.
     */
    it('decrements the attested balance at authorisation, not at execution', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 10_000_000n);

      await viem.assertions.emitWithArgs(
        ctx.book.write.authoriseRelease([id, 4_000_000n], { account: ctx.buyer.account }),
        ctx.book,
        'ReleaseAuthorised',
        [
          await ctx.book.read.computeAuthorisationId([1n]),
          id,
          ctx.buyer.account.address,
          4_000_000n,
          6_000_000n,
        ],
      );

      // Already gone from the book, though nothing has moved on Arc yet.
      assert.equal(await ctx.book.read.unallocated([id]), 6_000_000n);
    });

    it('only the buyer may authorise a release', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 1_000_000n);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.authoriseRelease([id, 1_000_000n], { account: ctx.stranger.account }),
        ctx.book,
        'NotMandateBuyer',
      );
    });

    /** Authorisation ids are single-use downstream, so they must never repeat. */
    it('mints a distinct authorisation id each time', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 10_000_000n);

      await ctx.book.write.authoriseRelease([id, 1_000_000n], { account: ctx.buyer.account });
      await ctx.book.write.authoriseRelease([id, 1_000_000n], { account: ctx.buyer.account });

      const first = await ctx.book.read.computeAuthorisationId([1n]);
      const second = await ctx.book.read.computeAuthorisationId([2n]);
      assert.notEqual(first, second);
      assert.equal(await ctx.book.read.authorisationCount(), 2n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Refusals - every path gets its own error type and its own reason code
  // ---------------------------------------------------------------------------------------------

  describe('refusals', () => {
    it('MandateUnknown for an id that was never posted', async () => {
      const ctx = await deploy();
      await listInvoice(ctx, INV_1);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, 999n], { account: ctx.matcher.account }),
        ctx.book,
        'MandateUnknown',
      );
    });

    it('MandateNotActive for a paused mandate', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);

      await ctx.book.write.setMandateStatus([id, MandateStatus.Paused], {
        account: ctx.buyer.account,
      });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'MandateNotActive',
      );
    });

    it('InvoiceUnknown for an invoice that was never listed', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([keccak256(toHex('nope')), id], {
          account: ctx.matcher.account,
        }),
        ctx.book,
        'InvoiceUnknown',
      );
    });

    it('InvoiceNotConfirmed until the debtor acknowledges', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1, { status: InvoiceStatus.Draft });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'InvoiceNotConfirmed',
      );

      // Confirmation is the only thing that changes, and it is enough.
      await ctx.invoices.write.setStatus([INV_1, InvoiceStatus.Confirmed]);
      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
    });

    /**
     * Distinct from InvoiceNotConfirmed on purpose: one needs the debtor to act, the other means the
     * paper has already been sold. Also the guard that stops one receivable being promised twice.
     */
    it('InvoiceAlreadyAllocated once an invoice has an open match', async () => {
      const ctx = await deploy();
      const idA = await postAndFund(ctx, 100_000_000_000n);
      const idB = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);

      await ctx.book.write.matchInvoice([INV_1, idA], { account: ctx.matcher.account });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, idB], { account: ctx.matcher.account }),
        ctx.book,
        'InvoiceAlreadyAllocated',
      );
    });

    it('RatingBelowFloor when the debtor sits under the mandate floor', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n, { minRating: Rating.A });
      await listInvoice(ctx, INV_1, { rating: Rating.B });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'RatingBelowFloor',
      );
    });

    /** A debtor with no settled history fails any mandate whose floor is a real grade. */
    it('RatingBelowFloor for an unrated debtor', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n, { minRating: Rating.C });
      await listInvoice(ctx, INV_1, { rating: Rating.Unrated });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'RatingBelowFloor',
      );
    });

    /**
     * The ordering property the whole scale rests on: `D` sits BELOW `Unrated`, so a mandate whose
     * floor is `Unrated` - the widest floor a buyer realistically writes, meaning "I will price a
     * cold start" - still refuses a debtor already known to have defaulted. If the enum were ever
     * reordered so that `D` sat above `Unrated`, this test is what fails, and it fails before any
     * defaulted paper can match against a bid that never meant to take it.
     */
    it('RatingBelowFloor for a defaulted debtor even at the widest floor', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n, { minRating: Rating.Unrated });
      await listInvoice(ctx, INV_1, { rating: Rating.D });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'RatingBelowFloor',
      );
    });

    it('TenorAboveCeiling when maturity is further out than the mandate accepts', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n, { maxTenorDays: 30 });
      await listInvoice(ctx, INV_1, { tenorDays: 60 });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'TenorAboveCeiling',
      );
    });

    it('InvoiceMatured once the due date has passed', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1, { tenorDays: 1 });

      await networkHelpers.time.increase(2 * 86_400);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'InvoiceMatured',
      );
    });

    it('DebtorLimitExceeded when concentration would breach the cap', async () => {
      const ctx = await deploy();
      const price = await ctx.book.read.previewPrice([FACE, TENOR_DAYS, YIELD_BPS]);
      // Plenty of capital overall, but not enough headroom against this one debtor. Ordering matters:
      // the unallocated check must pass first, or this would surface as the wrong refusal.
      const id = await postAndFund(ctx, 500_000_000_000n, { maxPerDebtor: price - 1n });
      await listInvoice(ctx, INV_1);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'DebtorLimitExceeded',
      );
    });

    /** The cap is per debtor, not per mandate: a second debtor is unaffected by the first's exposure. */
    it('tracks debtor exposure separately per debtor', async () => {
      const ctx = await deploy();
      const price = await ctx.book.read.previewPrice([FACE, TENOR_DAYS, YIELD_BPS]);
      const id = await postAndFund(ctx, 500_000_000_000n, { maxPerDebtor: price });

      await listInvoice(ctx, INV_1, { debtorId: DEBTOR_A });
      await listInvoice(ctx, INV_2, { debtorId: DEBTOR_B });

      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
      await ctx.book.write.matchInvoice([INV_2, id], { account: ctx.matcher.account });

      assert.equal(await ctx.book.read.debtorExposure([id, DEBTOR_A]), price);
      assert.equal(await ctx.book.read.debtorExposure([id, DEBTOR_B]), price);
    });

    it('NotEligible when the instrument refuses the buyer', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);

      await ctx.gate.write.setVerdict([false, reason('KYC_NOT_GRANTED')]);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'NotEligible',
      );
    });

    /**
     * The gate address is owner-mutable, so the book must not trust a gate to honour its own
     * "never reverts" contract. A reverting gate has to become a named refusal, not a broken venue.
     */
    it('survives a gate that violates its interface and reverts', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);

      await ctx.gate.write.setRevertMode([true]);

      // previewMatch is a view the UI depends on; it must answer rather than throw.
      const [ok, code] = await ctx.book.read.previewMatch([INV_1, id]);
      assert.equal(ok, false);
      assert.equal(code, reason('COMPLIANCE_PROBE_FAILED'));

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'NotEligible',
      );
    });

    it('only a matcher may strike a match', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.matchInvoice([INV_1, id], { account: ctx.stranger.account }),
        ctx.book,
        'NotMatcher',
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Refusal as an output rather than a failure
  // ---------------------------------------------------------------------------------------------

  describe('tryMatch', () => {
    /**
     * The product path. A refusal here is a SUCCESSFUL transaction carrying a receipt the rejected
     * party can check, which is the behaviour the venue promises and which a revert cannot provide.
     */
    it('emits MatchRefused and does not revert', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n, { minRating: Rating.A });
      await listInvoice(ctx, INV_1, { rating: Rating.B });

      await viem.assertions.emitWithArgs(
        ctx.book.write.tryMatch([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'MatchRefused',
        [INV_1, id, reason('RATING_BELOW_FLOOR')],
      );

      // Nothing was allocated.
      assert.equal(await ctx.book.read.unallocated([id]), 100_000_000_000n);
    });

    it('reports the same reason previewMatch does', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 1n); // funded, but nowhere near enough
      await listInvoice(ctx, INV_1);

      const [ok, previewed] = await ctx.book.read.previewMatch([INV_1, id]);
      assert.equal(ok, false);
      assert.equal(previewed, reason('INSUFFICIENT_UNALLOCATED'));

      await viem.assertions.emitWithArgs(
        ctx.book.write.tryMatch([INV_1, id], { account: ctx.matcher.account }),
        ctx.book,
        'MatchRefused',
        [INV_1, id, previewed],
      );
    });

    it('strikes the match when eligible', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);

      const [ok, , price] = await ctx.book.read.previewMatch([INV_1, id]);
      assert.equal(ok, true);

      await ctx.book.write.tryMatch([INV_1, id], { account: ctx.matcher.account });

      const matchId = await ctx.book.read.matchOfInvoice([INV_1]);
      const record = await ctx.book.read.getMatch([matchId]);
      assert.equal(record.status, MatchStatus.Open);
      assert.equal(record.price, price);
      assert.equal(record.tenorDays, TENOR_DAYS);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------------------------

  describe('settlement', () => {
    async function matched() {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);
      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
      const matchId = await ctx.book.read.matchOfInvoice([INV_1]);
      return { ctx, id, matchId };
    }

    it('authorises the seller payout and consumes the allocation', async () => {
      const { ctx, id, matchId } = await matched();
      const record = await ctx.book.read.getMatch([matchId]);
      const expectedAuthId = await ctx.book.read.computeAuthorisationId([1n]);
      const lockId = await deliver(ctx, matchId);

      // No tokens move here — they are on Arc. What settlement produces is an authorisation the
      // attester relays to MandateVault.executePayout, carrying the delivery leg's own lock id and
      // hashlock so the cash leg can be opened as its mirror.
      await viem.assertions.emitWithArgs(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.stranger.account }),
        ctx.book,
        'PayoutAuthorised',
        [
          expectedAuthId,
          matchId,
          id,
          ctx.seller.account.address,
          record.price,
          lockId,
          SECRET_HASH,
        ],
      );

      const mandate = await ctx.book.read.getMandate([id]);
      assert.equal(mandate.allocated, 0n);
      assert.equal(mandate.totalCommitted, 100_000_000_000n - record.price);

      // Exposure survives settlement: the buyer now genuinely holds the paper.
      assert.equal(await ctx.book.read.debtorExposure([id, DEBTOR_A]), record.price);
    });

    // -------------------------------------------------------------------------------------------
    // The settlement authorisation itself. Every test below is the unauthorised case.
    // -------------------------------------------------------------------------------------------

    /**
     * THE test for this path. Before the wiring, an authorised settler's word released the buyer's
     * capital. Now the role buys nothing at all: the settler is still a settler, and still cannot
     * settle, because there is no claimed delivery lock to point at.
     */
    it('refuses a settler who has no delivery proof', async () => {
      const { ctx, id, matchId } = await matched();
      const before = await ctx.book.read.getMandate([id]);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, keccak256(toHex('no-such-lock'))], {
          account: ctx.settler.account,
        }),
        ctx.book,
        'DeliveryNotProven',
      );

      // Nothing moved, and no authorisation was minted against the vault.
      const after = await ctx.book.read.getMandate([id]);
      assert.equal(after.allocated, before.allocated);
      assert.equal(after.totalCommitted, before.totalCommitted);
      assert.equal(await ctx.book.read.authorisationCount(), 0n);
    });

    /**
     * A locked-but-unclaimed leg means the paper is escrowed and the buyer has not taken it. Paying
     * the seller at that point would be paying against an option, not against a delivery.
     */
    it('refuses a delivery lock that has been opened but not claimed', async () => {
      const { ctx, matchId } = await matched();
      const lockId = await deliver(ctx, matchId, { claim: false });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account }),
        ctx.book,
        'DeliveryNotProven',
      );
    });

    /** A real, claimed lock — belonging to some other trade. Otherwise one delivery settles many. */
    it('refuses a claimed lock carrying a different trade reference', async () => {
      const { ctx, matchId } = await matched();
      const lockId = await deliver(ctx, matchId, { tradeRef: keccak256(toHex('other-trade')) });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account }),
        ctx.book,
        'DeliveryLockMismatch',
      );
    });

    /** The paper has to have come from the party the payout pays. */
    it('refuses a lock escrowed by someone other than the recorded seller', async () => {
      const { ctx, matchId } = await matched();
      const lockId = await deliver(ctx, matchId, { depositor: ctx.stranger });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account }),
        ctx.book,
        'DeliveryDepositorMismatch',
      );
    });

    /** ...and it has to have gone to the party whose capital is about to be spent. */
    it('refuses a lock delivering to someone other than the buyer', async () => {
      const { ctx, matchId } = await matched();
      const lockId = await deliver(ctx, matchId, { beneficiary: ctx.stranger });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account }),
        ctx.book,
        'DeliveryBeneficiaryMismatch',
      );
    });

    /** Delivering a different token is not delivering the invoice's instrument. */
    it('refuses a lock holding an asset that is not the instrument', async () => {
      const { ctx, matchId } = await matched();
      const other = await viem.deployContract('MockUSDC', []);
      const lockId = await deliver(ctx, matchId, { token: other });

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account }),
        ctx.book,
        'DeliveryAssetMismatch',
      );
    });

    /**
     * The other half of removing the role: with a proof, settlement is COMPELLED. A buyer who has
     * taken the paper cannot decline to pay for it, and a keeper that has gone dark cannot hold a
     * completed trade hostage — the seller, or anyone, can force the authorisation themselves.
     */
    it('lets anyone at all settle once delivery is proven', async () => {
      const { ctx, id, matchId } = await matched();
      const lockId = await deliver(ctx, matchId);

      await ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.seller.account });

      assert.equal((await ctx.book.read.getMatch([matchId])).status, MatchStatus.Settled);
      assert.equal((await ctx.book.read.getMandate([id])).allocated, 0n);
    });

    it('returns the allocation on cancel and authorises nothing', async () => {
      const { ctx, id, matchId } = await matched();

      await ctx.book.write.cancelMatch([matchId, reason('SETTLEMENT_TIMEOUT')], {
        account: ctx.settler.account,
      });

      assert.equal(await ctx.book.read.unallocated([id]), 100_000_000_000n);
      // Nothing was authorised against the vault, so the buyer's Arc capital is untouched.
      assert.equal(await ctx.book.read.authorisationCount(), 0n);
      assert.equal(await ctx.book.read.debtorExposure([id, DEBTOR_A]), 0n);

      // The invoice is free to be matched again.
      assert.equal(await ctx.book.read.matchOfInvoice([INV_1]), zeroHash);
    });

    /**
     * Escrowed capital must not be hostage to venue liveness. Past the settlement window anyone may
     * free it, so a buyer whose keeper has gone dark is not stuck.
     */
    it('lets anyone cancel once the settlement window has elapsed', async () => {
      const { ctx, id, matchId } = await matched();

      await viem.assertions.revertWithCustomError(
        ctx.book.write.cancelMatch([matchId, reason('SETTLEMENT_TIMEOUT')], {
          account: ctx.stranger.account,
        }),
        ctx.book,
        'NotSettler',
      );

      await networkHelpers.time.increase(Number(SETTLEMENT_WINDOW) + 1);

      await ctx.book.write.cancelMatch([matchId, reason('SETTLEMENT_TIMEOUT')], {
        account: ctx.stranger.account,
      });
      assert.equal(await ctx.book.read.unallocated([id]), 100_000_000_000n);
    });

    it('refuses to settle a match twice', async () => {
      const { ctx, matchId } = await matched();
      const lockId = await deliver(ctx, matchId);

      await ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account });

      // The same proof stays valid forever — the lock is permanently `Claimed` — so it is the match
      // status, not the proof, that has to stop a replay.
      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account }),
        ctx.book,
        'MatchNotOpen',
      );
    });

    /** A cancelled match must not block a later one, which is why the id carries an attempt counter. */
    it('allows a fresh match after cancellation, under a new match id', async () => {
      const { ctx, id, matchId } = await matched();

      await ctx.book.write.cancelMatch([matchId, reason('SETTLEMENT_TIMEOUT')], {
        account: ctx.settler.account,
      });

      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
      const second = await ctx.book.read.matchOfInvoice([INV_1]);

      assert.notEqual(second, matchId);
      assert.equal(await ctx.book.read.matchAttempts([INV_1]), 2n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Maturity — the leg that makes the paper transferable at all
  // ---------------------------------------------------------------------------------------------

  describe('maturity', () => {
    /** Match, deliver, settle. Leaves the buyer holding the whole instrument. */
    async function settled() {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);
      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
      const matchId = await ctx.book.read.matchOfInvoice([INV_1]);
      const lockId = await deliver(ctx, matchId);
      await ctx.book.write.confirmSettlement([matchId, lockId], { account: ctx.settler.account });
      return { ctx, id, matchId };
    }

    const pastMaturity = () => networkHelpers.time.increase((TENOR_DAYS + 1) * 86_400);

    /**
     * THE test for this path, and the one the product argument rests on. The paper changed hands
     * after settlement, so redemption is owed to the second holder — and the book has to work that
     * out from the instrument rather than from the buyer it recorded at match time. Without this a
     * second buyer would have no way to be paid, and the secondary market the venue claims to run
     * would not be one.
     */
    it('routes redemption to the current holder, not the original buyer', async () => {
      const { ctx, id, matchId } = await settled();

      // The buyer sells on. Nothing in the book is told about it.
      await ctx.bond.write.transfer([ctx.stranger.account.address, BOND_UNITS], {
        account: ctx.buyer.account,
      });
      await pastMaturity();

      // The original buyer is refused by name, even though the book still records them as the buyer.
      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]),
        ctx.book,
        'NotInstrumentHolder',
      );

      const record = await ctx.book.read.getMatch([matchId]);
      await viem.assertions.emitWithArgs(
        ctx.book.write.confirmMaturity([matchId, ctx.stranger.account.address]),
        ctx.book,
        'MaturityConfirmed',
        [matchId, id, ctx.bond.address, ctx.stranger.account.address, record.faceValue],
      );

      assert.equal((await ctx.book.read.getMatch([matchId])).status, MatchStatus.Matured);
    });

    /** A caller cannot nominate a payee: the instrument is asked, and it answers about itself. */
    it('refuses an address that holds none of the instrument', async () => {
      const { ctx, matchId } = await settled();
      await pastMaturity();

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.stranger.account.address], {
          account: ctx.stranger.account,
        }),
        ctx.book,
        'NotInstrumentHolder',
      );
    });

    /**
     * Sole holder, not merely a holder. One unit dusted onto an address you control must not make
     * you the payee — and, symmetrically, must not make the real holder one either, because a split
     * position is not something this venue can issue and refusing is the safe way to notice.
     */
    it('refuses a partial holding on both sides of a dusting attempt', async () => {
      const { ctx, matchId } = await settled();
      await ctx.bond.write.transfer([ctx.stranger.account.address, 1n], {
        account: ctx.buyer.account,
      });
      await pastMaturity();

      for (const who of [ctx.stranger, ctx.buyer]) {
        await viem.assertions.revertWithCustomError(
          ctx.book.write.confirmMaturity([matchId, who.account.address]),
          ctx.book,
          'NotInstrumentHolder',
        );
      }
    });

    it('refuses before the position reaches its due date', async () => {
      const { ctx, matchId } = await settled();

      const maturesAt = await ctx.book.read.maturityOf([matchId]);
      const record = await ctx.book.read.getMatch([matchId]);
      assert.equal(maturesAt, record.matchedAt + BigInt(record.tenorDays) * DAY);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]),
        ctx.book,
        'NotYetMatured',
      );

      // A day short is still short: the guard is the snapshotted due date, not "roughly then".
      await networkHelpers.time.increase((TENOR_DAYS - 1) * 86_400);
      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]),
        ctx.book,
        'NotYetMatured',
      );
    });

    /**
     * The bug the role call it replaced actually had. `releaseDebtorExposure` could be called twice,
     * and the second call decremented a DIFFERENT live position's exposure to the same debtor —
     * understating concentration on a mandate that had done nothing wrong. A status transition makes
     * that arithmetically impossible rather than a matter of asking politely once.
     */
    it('releases the debtor exposure exactly once', async () => {
      const { ctx, id, matchId } = await settled();
      const record = await ctx.book.read.getMatch([matchId]);

      // A second live position against the same debtor, which a double release would eat into.
      await listInvoice(ctx, INV_2, { debtorId: DEBTOR_A });
      await ctx.book.write.matchInvoice([INV_2, id], { account: ctx.matcher.account });
      const both = await ctx.book.read.debtorExposure([id, DEBTOR_A]);

      await pastMaturity();
      await ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]);
      assert.equal(await ctx.book.read.debtorExposure([id, DEBTOR_A]), both - record.price);

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]),
        ctx.book,
        'MatchNotSettled',
      );

      // The second position's exposure is untouched by the first's maturity.
      assert.equal(await ctx.book.read.debtorExposure([id, DEBTOR_A]), both - record.price);
    });

    it('refuses to mature a match that never settled', async () => {
      const ctx = await deploy();
      const id = await postAndFund(ctx, 100_000_000_000n);
      await listInvoice(ctx, INV_1);
      await ctx.book.write.matchInvoice([INV_1, id], { account: ctx.matcher.account });
      const matchId = await ctx.book.read.matchOfInvoice([INV_1]);
      await pastMaturity();

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]),
        ctx.book,
        'MatchNotSettled',
      );
    });

    /**
     * Fails closed. An instrument that cannot answer produces a named refusal and no state change,
     * because the alternative failure — routing a redemption on an assumption — is not recoverable.
     */
    it('refuses when the instrument cannot be asked who holds it', async () => {
      const { ctx, matchId } = await settled();
      await ctx.bond.write.setProbeBroken([true]);
      await pastMaturity();

      await viem.assertions.revertWithCustomError(
        ctx.book.write.confirmMaturity([matchId, ctx.buyer.account.address]),
        ctx.book,
        'HolderProbeFailed',
      );

      assert.equal((await ctx.book.read.getMatch([matchId])).status, MatchStatus.Settled);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Mandate terms
  // ---------------------------------------------------------------------------------------------

  describe('postMandate', () => {
    it('rejects degenerate terms', async () => {
      const { book, buyer } = await deploy();
      const from = { account: buyer.account };
      const bad = (promise: Promise<unknown>) =>
        viem.assertions.revertWithCustomError(promise, book, 'InvalidTerms');

      await bad(book.write.postMandate([Rating.A, 0, YIELD_BPS, 1n], from)); // zero tenor
      await bad(book.write.postMandate([Rating.A, 400, YIELD_BPS, 1n], from)); // tenor too long
      await bad(book.write.postMandate([Rating.A, MAX_TENOR, 0, 1n], from)); // zero yield
      await bad(book.write.postMandate([Rating.A, MAX_TENOR, 6_000, 1n], from)); // yield too high
      await bad(book.write.postMandate([Rating.A, MAX_TENOR, YIELD_BPS, 0n], from)); // zero cap
    });

    it('numbers mandates from one so zero is never a valid id', async () => {
      const ctx = await deploy();
      assert.equal(await ctx.book.read.mandateCount(), 0n);
      const id = await postAndFund(ctx, 0n);
      assert.equal(id, 1n);

      const absent = await ctx.book.read.getMandate([0n]);
      assert.equal(absent.status, MandateStatus.Uninitialised);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Deployment wiring
  // ---------------------------------------------------------------------------------------------

  describe('deployment', () => {
    it('records the escrow it reads settlement proofs from', async () => {
      const ctx = await deploy();
      assert.equal(
        (await ctx.book.read.deliveryEscrow()).toLowerCase(),
        ctx.escrow.address.toLowerCase(),
      );
    });

    /**
     * The one deployment parameter whose misconfiguration loses money silently. A cancellation
     * window that does not outlast the escrow's longest lock would let a match be cancelled — the
     * buyer's capital returned — while the delivery leg was still claimable, handing the buyer the
     * bond for free. It used to be a check in a deploy script; now the constructor refuses.
     */
    it('refuses a settlement window that does not outlast the escrow', async () => {
      const ctx = await deploy();
      const maxLock = await ctx.escrow.read.MAX_LOCK_DURATION();

      await viem.assertions.revertWithCustomError(
        viem.deployContract('MandateBook', [
          ctx.invoices.address,
          ctx.gate.address,
          ctx.escrow.address,
          ctx.owner.account.address,
          ctx.attester.account.address,
          CASH_LEG_CHAIN_ID,
          CASH_LEG_VAULT,
          maxLock,
        ]),
        ctx.book,
        'InvalidTerms',
      );
    });
  });
});
