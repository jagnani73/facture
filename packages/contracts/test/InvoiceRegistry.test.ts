import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, stringToHex, toHex, zeroAddress, zeroHash } from 'viem';

const { viem } = await hre.network.getOrCreate();

// Enum ordinals, mirrored from contracts/libraries/FactureTypes.sol. Their ORDER is load-bearing —
// `Rating` is compared with `>=` inside the book, and `InvoiceStatus.Unknown == 0` is what makes an
// unwritten record read as "not listed" — so a reordering there should break these loudly.
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

const reason = (code: string) => stringToHex(code, { size: 32 });

const DAY = 86_400n;
const FACE = 40_000_000_000n; // $40,000.000000 at six decimals
const INVOICE_REF = keccak256(toHex('INV-2026-0041'));
const DEBTOR = keccak256(toHex('debtor:meridian-fabrication'));
const INV_1 = keccak256(toHex('invoice:1'));
const INV_2 = keccak256(toHex('invoice:2'));

// Cash-leg wiring for the integration test at the bottom. Declarative only; nothing verifies it.
const CASH_LEG_CHAIN_ID = 5_042_002n;
const CASH_LEG_VAULT = '0x00000000000000000000000000000000000000AC' as const;
const SETTLEMENT_WINDOW = 3n * DAY;

/**
 * The registry is the on-chain source of invoice truth that {MandateBook} reads before it allows a
 * match. Two properties carry everything below.
 *
 * Nobody but an attester may write, because a forged `A` rating on a defaulted debtor would price,
 * match and settle exactly as a real one — the mock's unpermissioned `setInvoice` would have made
 * every refusal in the book a check against the caller's own claims.
 *
 * And reads never revert, because `previewMatch` is a `view` that has to report `INVOICE_UNKNOWN` as
 * a named refusal. A refusal is a product output here; a revert is a failure.
 */
describe('InvoiceRegistry', () => {
  async function deploy() {
    const [owner, attester, seller, stranger] = await viem.getWalletClients();
    assert.ok(owner && attester && seller && stranger, 'expected at least four funded accounts');

    const publicClient = await viem.getPublicClient();

    // The uniqueness registry deploys first and is an immutable of the invoice registry: listing
    // verifies that the receivable was actually claimed against the instrument being listed, rather
    // than taking the attester's word for it.
    const uniqueness = await viem.deployContract('UniquenessRegistry', [owner.account.address]);
    await uniqueness.write.setIssuer([owner.account.address, true]);

    const registry = await viem.deployContract('InvoiceRegistry', [
      owner.account.address,
      uniqueness.address,
    ]);
    await registry.write.setAttester([attester.account.address, true]);

    // MockUSDC stands in for the ATS diamond's ERC-20 facade, which is how the venue reaches a
    // security token on Hedera anyway. Only its address matters here.
    const bond = await viem.deployContract('MockUSDC', []);

    return { publicClient, uniqueness, registry, bond, owner, attester, seller, stranger };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;

  /** Claim the receivable in the uniqueness registry, then list it. Returns the hash used. */
  async function listInvoice(
    ctx: Ctx,
    invoiceId: `0x${string}` = INV_1,
    overrides: Partial<{
      instrument: `0x${string}`;
      debtorId: `0x${string}`;
      seller: `0x${string}`;
      faceValue: bigint;
      tenorDays: bigint;
      rating: number;
      uniquenessHash: `0x${string}`;
      claim: boolean;
    }> = {},
  ): Promise<`0x${string}`> {
    const { registry, uniqueness, bond, publicClient, attester } = ctx;
    const instrument = overrides.instrument ?? bond.address;
    const faceValue = overrides.faceValue ?? FACE;
    const hash =
      overrides.uniquenessHash ??
      (await uniqueness.read.computeHash([overrides.debtorId ?? DEBTOR, INVOICE_REF, faceValue]));

    if (overrides.claim !== false) {
      await uniqueness.write.claim([hash, instrument]);
    }

    const now = (await publicClient.getBlock()).timestamp;

    await registry.write.list(
      [
        invoiceId,
        instrument,
        overrides.debtorId ?? DEBTOR,
        overrides.seller ?? ctx.seller.account.address,
        faceValue,
        now + (overrides.tenorDays ?? 60n) * DAY,
        hash,
        overrides.rating ?? Rating.A,
      ],
      { account: attester.account },
    );

    return hash;
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /**
   * The interface's hard requirement. `MandateBook.previewMatch` is a `view` and cannot catch a
   * revert, so an unknown id has to come back as data.
   */
  it('returns a zero-filled struct for an unknown id rather than reverting', async () => {
    const { registry } = await deploy();

    const invoice = await registry.read.getInvoice([keccak256(toHex('never-listed'))]);

    assert.equal(invoice.status, InvoiceStatus.Unknown);
    assert.equal(invoice.instrument, zeroAddress);
    assert.equal(invoice.seller, zeroAddress);
    assert.equal(invoice.debtorId, zeroHash);
    assert.equal(invoice.uniquenessHash, zeroHash);
    assert.equal(invoice.faceValue, 0n);
    assert.equal(invoice.dueDate, 0n);
    // A zero slot decodes to `Rating.D`, the WORST bucket — an unwritten record can never present
    // as investment grade. See the note on `Rating` in FactureTypes.sol.
    assert.equal(invoice.rating, Rating.D);

    assert.equal(await registry.read.isConfirmed([keccak256(toHex('never-listed'))]), false);
    assert.equal(await registry.read.isListed([keccak256(toHex('never-listed'))]), false);
  });

  it('records every field the book reads, and lands in Draft', async () => {
    const ctx = await deploy();
    const hash = await listInvoice(ctx);

    const invoice = await ctx.registry.read.getInvoice([INV_1]);

    assert.equal(invoice.instrument.toLowerCase(), ctx.bond.address.toLowerCase());
    assert.equal(invoice.seller.toLowerCase(), ctx.seller.account.address.toLowerCase());
    assert.equal(invoice.debtorId, DEBTOR);
    assert.equal(invoice.faceValue, FACE);
    assert.equal(invoice.rating, Rating.A);
    assert.equal(invoice.uniquenessHash, hash);
    // Listing never produces `Confirmed`. The debtor's acknowledgement is a separate transition,
    // and it is what removes dispute risk and justifies a full advance with no holdback.
    assert.equal(invoice.status, InvoiceStatus.Draft);
    assert.equal(await ctx.registry.read.isConfirmed([INV_1]), false);
    assert.equal(await ctx.registry.read.isListed([INV_1]), true);

    assert.equal(await ctx.registry.read.invoiceOfReceivable([hash]), INV_1);
    assert.equal(await ctx.registry.read.invoiceOfInstrument([ctx.bond.address]), INV_1);
  });

  // -------------------------------------------------------------------------------------------
  // Who may write
  // -------------------------------------------------------------------------------------------

  /**
   * The reason this contract exists. `MockInvoiceRegistry.setInvoice` is `external` with no access
   * control, so deploying it would let anyone assert any invoice fact — and every refusal in the
   * book would then be checking the caller's claims against the mandate rather than reality.
   */
  it('refuses every write from an address that is not an attester', async () => {
    const ctx = await deploy();
    const { registry, uniqueness, bond, stranger, publicClient } = ctx;

    const hash = await uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    await uniqueness.write.claim([hash, bond.address]);
    const now = (await publicClient.getBlock()).timestamp;

    await viem.assertions.revertWithCustomError(
      registry.write.list(
        [
          INV_1,
          bond.address,
          DEBTOR,
          stranger.account.address,
          FACE,
          now + 60n * DAY,
          hash,
          Rating.A,
        ],
        { account: stranger.account },
      ),
      registry,
      'NotAttester',
    );

    // Nothing was written on the way to the revert.
    assert.equal((await registry.read.getInvoice([INV_1])).status, InvoiceStatus.Unknown);

    // The same for every other write path, on a record that DOES exist — so the refusal is about
    // the caller and not about the invoice being absent. The receivable is already claimed above.
    await listInvoice(ctx, INV_1, { claim: false });

    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: stranger.account }),
      registry,
      'NotAttester',
    );
    await viem.assertions.revertWithCustomError(
      registry.write.setRating([INV_1, Rating.A], { account: stranger.account }),
      registry,
      'NotAttester',
    );
    await viem.assertions.revertWithCustomError(
      registry.write.amendDueDate([INV_1, now + 90n * DAY], { account: stranger.account }),
      registry,
      'NotAttester',
    );

    assert.equal((await registry.read.getInvoice([INV_1])).status, InvoiceStatus.Draft);
  });

  it('refuses a write from the owner, who curates attesters but is not one', async () => {
    const ctx = await deploy();
    const { registry, uniqueness, bond, owner, publicClient } = ctx;

    const hash = await uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    await uniqueness.write.claim([hash, bond.address]);
    const now = (await publicClient.getBlock()).timestamp;

    await viem.assertions.revertWithCustomError(
      registry.write.list(
        [INV_1, bond.address, DEBTOR, owner.account.address, FACE, now + 60n * DAY, hash, Rating.A],
        { account: owner.account },
      ),
      registry,
      'NotAttester',
    );
  });

  it('lets only the owner curate the attester set', async () => {
    const { registry, attester, stranger } = await deploy();

    await viem.assertions.revertWithCustomError(
      registry.write.setAttester([stranger.account.address, true], { account: stranger.account }),
      registry,
      'NotOwner',
    );

    await viem.assertions.emitWithArgs(
      registry.write.setAttester([stranger.account.address, true]),
      registry,
      'AttesterSet',
      [stranger.account.address, true],
    );
    assert.equal(await registry.read.isAttester([stranger.account.address]), true);

    // Revocation is immediate, which is the whole recovery story for a compromised relay key.
    await registry.write.setAttester([attester.account.address, false]);
    assert.equal(await registry.read.isAttester([attester.account.address]), false);
  });

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  it('emits the whole record on listing, so a match can be reconstructed from logs alone', async () => {
    const ctx = await deploy();
    const { registry, uniqueness, bond, attester, seller, publicClient } = ctx;

    const hash = await uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    await uniqueness.write.claim([hash, bond.address]);
    const now = (await publicClient.getBlock()).timestamp;
    const dueDate = now + 60n * DAY;

    await viem.assertions.emitWithArgs(
      registry.write.list(
        [INV_1, bond.address, DEBTOR, seller.account.address, FACE, dueDate, hash, Rating.B],
        { account: attester.account },
      ),
      registry,
      'InvoiceListed',
      [
        INV_1,
        bond.address,
        DEBTOR,
        seller.account.address,
        FACE,
        dueDate,
        Rating.B,
        hash,
        attester.account.address,
      ],
    );
  });

  it('emits a status change on listing and on every transition', async () => {
    const ctx = await deploy();
    const { registry, uniqueness, bond, attester, seller, publicClient } = ctx;

    const hash = await uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    await uniqueness.write.claim([hash, bond.address]);
    const now = (await publicClient.getBlock()).timestamp;

    // Unknown -> Draft is a transition too, so a consumer watching only status changes still sees
    // the record appear.
    await viem.assertions.emitWithArgs(
      registry.write.list(
        [
          INV_1,
          bond.address,
          DEBTOR,
          seller.account.address,
          FACE,
          now + 60n * DAY,
          hash,
          Rating.A,
        ],
        { account: attester.account },
      ),
      registry,
      'InvoiceStatusChanged',
      [INV_1, InvoiceStatus.Unknown, InvoiceStatus.Draft, attester.account.address],
    );

    await viem.assertions.emitWithArgs(
      registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account }),
      registry,
      'InvoiceStatusChanged',
      [INV_1, InvoiceStatus.Draft, InvoiceStatus.Confirmed, attester.account.address],
    );

    assert.equal(await registry.read.isConfirmed([INV_1]), true);
  });

  it('emits rating and due-date amendments with their previous values', async () => {
    const ctx = await deploy();
    const { registry, attester, publicClient } = ctx;
    await listInvoice(ctx, INV_1, { rating: Rating.Unrated });

    await viem.assertions.emitWithArgs(
      registry.write.setRating([INV_1, Rating.B], { account: attester.account }),
      registry,
      'InvoiceRatingChanged',
      [INV_1, Rating.Unrated, Rating.B, attester.account.address],
    );
    assert.equal((await registry.read.getInvoice([INV_1])).rating, Rating.B);

    const before = (await registry.read.getInvoice([INV_1])).dueDate;
    const now = (await publicClient.getBlock()).timestamp;
    const corrected = now + 90n * DAY;

    await viem.assertions.emitWithArgs(
      registry.write.amendDueDate([INV_1, corrected], { account: attester.account }),
      registry,
      'InvoiceDueDateAmended',
      [INV_1, before, corrected, attester.account.address],
    );
    assert.equal((await registry.read.getInvoice([INV_1])).dueDate, corrected);
  });

  // -------------------------------------------------------------------------------------------
  // One receivable, one listing
  // -------------------------------------------------------------------------------------------

  /**
   * The book's double-sale guard is keyed on the INVOICE ID, so it is only sound if an id maps to a
   * receivable one-for-one. Two ids over one receivable would be two independently matchable
   * listings of the same paper — the exact fraud the uniqueness registry exists to stop, re-entering
   * one contract further up.
   */
  it('refuses a second listing of the same receivable', async () => {
    const ctx = await deploy();
    const hash = await listInvoice(ctx, INV_1);

    // Same hash, already claimed to this instrument, presented under a fresh invoice id.
    const now = (await ctx.publicClient.getBlock()).timestamp;
    await viem.assertions.revertWithCustomError(
      ctx.registry.write.list(
        [
          INV_2,
          ctx.bond.address,
          DEBTOR,
          ctx.seller.account.address,
          FACE,
          now + 60n * DAY,
          hash,
          Rating.A,
        ],
        { account: ctx.attester.account },
      ),
      ctx.registry,
      'ReceivableAlreadyListed',
    );
  });

  it('refuses a second listing of the same instrument under a different receivable', async () => {
    const ctx = await deploy();
    await listInvoice(ctx, INV_1);

    // A different receivable — different face — claimed against the SAME bond. That is an issuer
    // error in the uniqueness registry, and it would otherwise put one instrument on the book twice.
    const otherHash = await ctx.uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE + 1n]);
    await ctx.uniqueness.write.claim([otherHash, ctx.bond.address]);
    const now = (await ctx.publicClient.getBlock()).timestamp;

    await viem.assertions.revertWithCustomError(
      ctx.registry.write.list(
        [
          INV_2,
          ctx.bond.address,
          DEBTOR,
          ctx.seller.account.address,
          FACE + 1n,
          now + 60n * DAY,
          otherHash,
          Rating.A,
        ],
        { account: ctx.attester.account },
      ),
      ctx.registry,
      'InstrumentAlreadyListed',
    );
  });

  it('refuses a second listing under an invoice id that already exists', async () => {
    const ctx = await deploy();
    await listInvoice(ctx, INV_1);

    const otherBond = await viem.deployContract('MockUSDC', []);
    const otherHash = await ctx.uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE + 2n]);
    await ctx.uniqueness.write.claim([otherHash, otherBond.address]);
    const now = (await ctx.publicClient.getBlock()).timestamp;

    await viem.assertions.revertWithCustomError(
      ctx.registry.write.list(
        [
          INV_1,
          otherBond.address,
          DEBTOR,
          ctx.seller.account.address,
          FACE + 2n,
          now + 60n * DAY,
          otherHash,
          Rating.A,
        ],
        { account: ctx.attester.account },
      ),
      ctx.registry,
      'InvoiceAlreadyListed',
    );

    // The incumbent record is untouched — a failed listing must not partially write.
    assert.equal(
      (await ctx.registry.read.getInvoice([INV_1])).instrument.toLowerCase(),
      ctx.bond.address.toLowerCase(),
    );
  });

  /**
   * `IUniquenessRegistry.claim` states the obligation directly: "a `deployBond` whose `claim`
   * reverts leaves an orphaned bond that must never be listed. The listing path enforces that by
   * requiring a matching claim." This is that enforcement.
   */
  it('refuses an instrument the uniqueness registry never bound', async () => {
    const ctx = await deploy();
    const { registry, uniqueness, bond, attester, seller, publicClient } = ctx;

    const hash = await uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    const now = (await publicClient.getBlock()).timestamp;

    // No claim at all: the orphaned-bond case.
    await viem.assertions.revertWithCustomError(
      registry.write.list(
        [
          INV_1,
          bond.address,
          DEBTOR,
          seller.account.address,
          FACE,
          now + 60n * DAY,
          hash,
          Rating.A,
        ],
        { account: attester.account },
      ),
      registry,
      'UniquenessMismatch',
    );

    // Claimed, but to a different instrument: the attester's `instrument` field disagrees with the
    // binding a buyer would diligence.
    const otherBond = await viem.deployContract('MockUSDC', []);
    await uniqueness.write.claim([hash, otherBond.address]);

    await viem.assertions.revertWithCustomError(
      registry.write.list(
        [
          INV_1,
          bond.address,
          DEBTOR,
          seller.account.address,
          FACE,
          now + 60n * DAY,
          hash,
          Rating.A,
        ],
        { account: attester.account },
      ),
      registry,
      'UniquenessMismatch',
    );
  });

  it('rejects blank fields and a due date that has already passed', async () => {
    const ctx = await deploy();
    const { registry, uniqueness, bond, attester, seller, publicClient } = ctx;

    const hash = await uniqueness.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    await uniqueness.write.claim([hash, bond.address]);
    const now = (await publicClient.getBlock()).timestamp;
    const due = now + 60n * DAY;
    const S = seller.account.address;
    const B = bond.address;

    // Literal error names rather than `string`, so a renamed error is a type error here.
    type ListError =
      | 'ZeroInvoiceId'
      | 'ZeroInstrument'
      | 'ZeroDebtor'
      | 'ZeroAddress'
      | 'ZeroFaceValue'
      | 'ZeroHash'
      | 'DueDateNotInFuture';

    const cases: Array<[ListError, Parameters<typeof registry.write.list>[0]]> = [
      ['ZeroInvoiceId', [zeroHash, B, DEBTOR, S, FACE, due, hash, Rating.A]],
      ['ZeroInstrument', [INV_1, zeroAddress, DEBTOR, S, FACE, due, hash, Rating.A]],
      ['ZeroDebtor', [INV_1, B, zeroHash, S, FACE, due, hash, Rating.A]],
      ['ZeroAddress', [INV_1, B, DEBTOR, zeroAddress, FACE, due, hash, Rating.A]],
      ['ZeroFaceValue', [INV_1, B, DEBTOR, S, 0n, due, hash, Rating.A]],
      ['ZeroHash', [INV_1, B, DEBTOR, S, FACE, due, zeroHash, Rating.A]],
      // Already matured: there is no tenor left to price, so it can never match.
      ['DueDateNotInFuture', [INV_1, B, DEBTOR, S, FACE, now - DAY, hash, Rating.A]],
    ];

    for (const [error, args] of cases) {
      await viem.assertions.revertWithCustomError(
        registry.write.list(args, { account: attester.account }),
        registry,
        error,
      );
    }
  });

  // -------------------------------------------------------------------------------------------
  // Lifecycle transitions
  // -------------------------------------------------------------------------------------------

  it('walks the happy lifecycle through to repayment', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx);

    for (const next of [
      InvoiceStatus.Confirmed,
      InvoiceStatus.Matched,
      InvoiceStatus.Settled,
      InvoiceStatus.Repaid,
    ]) {
      await registry.write.setStatus([INV_1, next], { account: attester.account });
      assert.equal((await registry.read.getInvoice([INV_1])).status, next);
    }
  });

  it('refuses a status move the lifecycle does not admit', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx);

    // Draft cannot skip confirmation. This is the transition that would let paper be matched
    // without the debtor ever acknowledging the debt.
    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_1, InvoiceStatus.Matched], { account: attester.account }),
      registry,
      'InvalidStatusTransition',
    );

    // A no-op is refused too: a transition in the log that did not happen is worse than none.
    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_1, InvoiceStatus.Draft], { account: attester.account }),
      registry,
      'InvalidStatusTransition',
    );

    // Zero is the "not listed" sentinel `getInvoice` leans on. Writing it would make a listed
    // invoice read as never listed while its receivable stayed permanently spoken for.
    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_1, InvoiceStatus.Unknown], { account: attester.account }),
      registry,
      'InvalidStatusTransition',
    );

    assert.equal((await registry.read.getInvoice([INV_1])).status, InvoiceStatus.Draft);
  });

  it('refuses to re-list paper that has already been sold, and treats repayment as terminal', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx);

    for (const next of [InvoiceStatus.Confirmed, InvoiceStatus.Matched, InvoiceStatus.Settled]) {
      await registry.write.setStatus([INV_1, next], { account: attester.account });
    }

    // Settled paper is held by a buyer. Saying "for sale" about it would offer a second mandate
    // something the venue has already sold.
    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account }),
      registry,
      'InvalidStatusTransition',
    );

    await registry.write.setStatus([INV_1, InvoiceStatus.Repaid], { account: attester.account });

    // Terminal. A late payment after default, or a reversal of one, is an off-chain recovery — not
    // a rewrite of what happened.
    for (const next of [InvoiceStatus.Defaulted, InvoiceStatus.Confirmed, InvoiceStatus.Draft]) {
      await viem.assertions.revertWithCustomError(
        registry.write.setStatus([INV_1, next], { account: attester.account }),
        registry,
        'InvalidStatusTransition',
      );
    }
  });

  it('treats a default as terminal', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx);

    for (const next of [InvoiceStatus.Confirmed, InvoiceStatus.Matched, InvoiceStatus.Settled]) {
      await registry.write.setStatus([INV_1, next], { account: attester.account });
    }
    await registry.write.setStatus([INV_1, InvoiceStatus.Defaulted], { account: attester.account });

    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_1, InvoiceStatus.Repaid], { account: attester.account }),
      registry,
      'InvalidStatusTransition',
    );
  });

  /**
   * A cancelled match returns the paper to the book, so the registry has to be able to say so.
   * Without this edge the mirror would be stuck at `Matched` on paper the book will happily match
   * again — the two records would disagree about what is for sale.
   */
  it('returns a cancelled match to Confirmed', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx);

    await registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account });
    await registry.write.setStatus([INV_1, InvoiceStatus.Matched], { account: attester.account });
    await registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account });

    assert.equal(await registry.read.isConfirmed([INV_1]), true);
  });

  /**
   * The one non-obvious edge. A terminal `Cancelled` would burn a receivable on this venue forever,
   * because `list` refuses a receivable already spoken for and the bond is permanently bound in the
   * uniqueness registry. Re-opening costs nothing: it lands in `Draft`, which is unmatchable.
   */
  it('re-opens a cancelled listing into Draft, needing a fresh confirmation', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx);

    await registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account });
    await registry.write.setStatus([INV_1, InvoiceStatus.Cancelled], { account: attester.account });
    assert.equal(await registry.read.isConfirmed([INV_1]), false);

    await registry.write.setStatus([INV_1, InvoiceStatus.Draft], { account: attester.account });
    assert.equal((await registry.read.getInvoice([INV_1])).status, InvoiceStatus.Draft);
    // Re-opening does not re-confirm. The debtor has to acknowledge again.
    assert.equal(await registry.read.isConfirmed([INV_1]), false);
  });

  it('refuses a status change on an unknown id', async () => {
    const { registry, attester } = await deploy();

    await viem.assertions.revertWithCustomError(
      registry.write.setStatus([INV_2, InvoiceStatus.Confirmed], { account: attester.account }),
      registry,
      'InvoiceUnknown',
    );
  });

  // -------------------------------------------------------------------------------------------
  // What is frozen once paper is priced
  // -------------------------------------------------------------------------------------------

  it('freezes the rating once a match has been struck', async () => {
    const ctx = await deploy();
    const { registry, attester } = ctx;
    await listInvoice(ctx, INV_1, { rating: Rating.C });

    // Ratings are earned, so they move while the invoice sits on the book waiting for a bid.
    await registry.write.setRating([INV_1, Rating.B], { account: attester.account });
    await registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account });
    await registry.write.setRating([INV_1, Rating.A], { account: attester.account });
    assert.equal((await registry.read.getInvoice([INV_1])).rating, Rating.A);

    // Past the match, the rating is a fact about a completed trade. Rewriting it would leave a
    // reader unable to reconstruct why the match was allowed.
    await registry.write.setStatus([INV_1, InvoiceStatus.Matched], { account: attester.account });
    await viem.assertions.revertWithCustomError(
      registry.write.setRating([INV_1, Rating.D], { account: attester.account }),
      registry,
      'RatingLocked',
    );
    assert.equal((await registry.read.getInvoice([INV_1])).rating, Rating.A);
  });

  it('freezes the due date once the debtor has acknowledged it', async () => {
    const ctx = await deploy();
    const { registry, attester, publicClient } = ctx;
    await listInvoice(ctx);

    await registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account });
    const now = (await publicClient.getBlock()).timestamp;

    // Confirmation is the debtor acknowledging an amount AND a date. Moving the date afterwards
    // would leave the venue holding an acknowledgement of something the record no longer says.
    await viem.assertions.revertWithCustomError(
      registry.write.amendDueDate([INV_1, now + 120n * DAY], { account: attester.account }),
      registry,
      'DueDateLocked',
    );
  });

  it('refuses a correction that puts the due date in the past', async () => {
    const ctx = await deploy();
    const { registry, attester, publicClient } = ctx;
    await listInvoice(ctx);

    const now = (await publicClient.getBlock()).timestamp;
    await viem.assertions.revertWithCustomError(
      registry.write.amendDueDate([INV_1, now - DAY], { account: attester.account }),
      registry,
      'DueDateNotInFuture',
    );
  });

  // -------------------------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------------------------

  it('requires two steps to move ownership', async () => {
    const { registry, owner, stranger } = await deploy();

    await viem.assertions.emitWithArgs(
      registry.write.transferOwnership([stranger.account.address]),
      registry,
      'OwnershipTransferStarted',
      [owner.account.address, stranger.account.address],
    );
    // Nomination alone changes nothing. A one-step transfer to a mistyped address would leave the
    // attester set permanently unmanageable, and there is no upgrade path to recover through.
    assert.equal((await registry.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(
      (await registry.read.pendingOwner()).toLowerCase(),
      stranger.account.address.toLowerCase(),
    );

    await viem.assertions.emitWithArgs(
      registry.write.acceptOwnership({ account: stranger.account }),
      registry,
      'OwnerTransferred',
      [owner.account.address, stranger.account.address],
    );
    assert.equal(
      (await registry.read.owner()).toLowerCase(),
      stranger.account.address.toLowerCase(),
    );
    assert.equal(await registry.read.pendingOwner(), zeroAddress);
  });

  it('rejects a zero owner and a zero uniqueness registry at construction', async () => {
    const { uniqueness, owner } = await deploy();

    await assert.rejects(viem.deployContract('InvoiceRegistry', [zeroAddress, uniqueness.address]));
    await assert.rejects(
      viem.deployContract('InvoiceRegistry', [owner.account.address, zeroAddress]),
    );
  });

  // -------------------------------------------------------------------------------------------
  // The book reading the real registry
  // -------------------------------------------------------------------------------------------

  /**
   * The point of the whole exercise: this contract is what `MandateBook` reads in production, so the
   * refusal it has to be able to produce from an unknown id — a `view` return, not a revert — is
   * checked against the real thing rather than against the mock.
   */
  it('drives MandateBook refusals and matches as the mock did', async () => {
    const ctx = await deploy();
    const { registry, attester, owner } = ctx;

    const [, , , , buyer, matcher] = await viem.getWalletClients();
    assert.ok(buyer && matcher, 'expected at least six funded accounts');

    const gate = await viem.deployContract('MockComplianceGate', []);
    const escrow = await viem.deployContract('DvpEscrow', []);
    const book = await viem.deployContract('MandateBook', [
      registry.address,
      gate.address,
      escrow.address,
      owner.account.address,
      attester.account.address,
      CASH_LEG_CHAIN_ID,
      CASH_LEG_VAULT,
      SETTLEMENT_WINDOW,
    ]);
    await book.write.setMatcher([matcher.account.address, true]);

    await book.write.postMandate([Rating.B, 90, 800, 200_000_000_000n], {
      account: buyer.account,
    });
    const mandateId = await book.read.mandateCount();
    await book.write.creditFunding(
      [mandateId, buyer.account.address, 100_000_000_000n, keccak256(toHex('deposit:registry'))],
      { account: attester.account },
    );

    // Unknown id: a named refusal out of a `view`, which is only possible because `getInvoice`
    // returns a zero-filled struct instead of reverting.
    const unknown = await book.read.previewMatch([keccak256(toHex('never-listed')), mandateId]);
    assert.equal(unknown[0], false);
    assert.equal(unknown[1], reason('INVOICE_UNKNOWN'));

    // Listed but not yet acknowledged by the debtor.
    await listInvoice(ctx);
    const draft = await book.read.previewMatch([INV_1, mandateId]);
    assert.equal(draft[0], false);
    assert.equal(draft[1], reason('INVOICE_NOT_CONFIRMED'));

    // Confirmed, and it prices.
    await registry.write.setStatus([INV_1, InvoiceStatus.Confirmed], { account: attester.account });
    const confirmed = await book.read.previewMatch([INV_1, mandateId]);
    assert.equal(confirmed[1], reason(''));
    assert.equal(confirmed[0], true);
    assert.ok(confirmed[2] > 0n && confirmed[2] < FACE);

    // A rating the mandate's floor rejects, written by the attester rather than by the caller —
    // which is the property the mock could not provide.
    await registry.write.setRating([INV_1, Rating.C], { account: attester.account });
    const belowFloor = await book.read.previewMatch([INV_1, mandateId]);
    assert.equal(belowFloor[0], false);
    assert.equal(belowFloor[1], reason('RATING_BELOW_MANDATE'));

    await registry.write.setRating([INV_1, Rating.A], { account: attester.account });
    await book.write.matchInvoice([INV_1, mandateId], { account: matcher.account });
    assert.notEqual(await book.read.matchOfInvoice([INV_1]), zeroHash);
  });
});
