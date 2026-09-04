import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, toHex, zeroAddress, zeroHash } from 'viem';

const { viem, networkHelpers } = await hre.network.getOrCreate();

const MANDATE_1 = 1n;
const MANDATE_2 = 2n;
const FUNDING = 100_000_000_000n; // $100,000.000000
const PRICE = 39_178_082_192n; // one invoice's proceeds: $40,000 face, 60 days, 12.5%

const LockStatus = { None: 0, Locked: 1, Claimed: 2, Refunded: 3 } as const;
const LegKind = { Unspecified: 0, Delivery: 1, Payment: 2 } as const;

// The delivery leg's preimage, already public by the time a payout is authorised: the book only
// authorises one against a lock that was CLAIMED. It is carried across so the two legs of a trade
// pair up, not to keep anyone out — see IMandateVault.executePayout.
const SECRET = keccak256(toHex('facture:delivery-preimage'));
const SECRET_HASH = keccak256(SECRET);

/**
 * The vault is the cash leg. The book on Hedera holds only an ATTESTED view of what is in here, and
 * that attestation is sound for exactly one reason: the only ways out of this contract are the two
 * the book opens. Most of what follows tests that claim from the adversarial side rather than the
 * happy path, because the happy path is not what the design is defending.
 */
describe('MandateVault', () => {
  async function deploy() {
    const [owner, attester, buyer, seller, stranger] = await viem.getWalletClients();
    assert.ok(owner && attester && buyer && seller && stranger);

    const usdc = await viem.deployContract('MockUSDC', []);
    // The escrow deploys FIRST: the vault records it as an immutable and every settled payout leaves
    // toward it. Escrow, then vault, then the Hedera book that records the vault — the dependency
    // runs one way and never doubles back.
    const escrow = await viem.deployContract('DvpEscrow', []);
    const vault = await viem.deployContract('MandateVault', [
      usdc.address,
      escrow.address,
      attester.account.address,
      owner.account.address,
    ]);

    await usdc.write.mint([buyer.account.address, FUNDING * 10n]);
    await usdc.write.approve([vault.address, FUNDING * 10n], { account: buyer.account });

    return { usdc, escrow, vault, owner, attester, buyer, seller, stranger };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;

  async function registerAndFund(ctx: Ctx, mandateId = MANDATE_1, amount = FUNDING) {
    await ctx.vault.write.registerMandate([mandateId, ctx.buyer.account.address], {
      account: ctx.attester.account,
    });
    if (amount > 0n) {
      await ctx.vault.write.deposit([mandateId, amount], { account: ctx.buyer.account });
    }
  }

  /** Relay a `Matched` from the book: bind the payee, the payer and the price before delivery. */
  async function registerMatch(ctx: Ctx, matchId = MATCH_1, mandateId = MANDATE_1, price = PRICE) {
    await ctx.vault.write.registerMatch([matchId, mandateId, ctx.seller.account.address, price], {
      account: ctx.attester.account,
    });
  }

  const AUTH_A = keccak256(toHex('auth:1'));
  const AUTH_B = keccak256(toHex('auth:2'));
  const MATCH_1 = keccak256(toHex('match:1'));
  const MATCH_2 = keccak256(toHex('match:2'));
  const LOCK_A = keccak256(toHex('lock:a'));
  const LOCK_B = keccak256(toHex('lock:b'));

  // -----------------------------------------------------------------------------------------
  // Registration and funding
  // -----------------------------------------------------------------------------------------

  it('binds a mandate to its buyer, once and permanently', async () => {
    const ctx = await deploy();
    await ctx.vault.write.registerMandate([MANDATE_1, ctx.buyer.account.address], {
      account: ctx.attester.account,
    });

    assert.equal(
      (await ctx.vault.read.buyerOf([MANDATE_1])).toLowerCase(),
      ctx.buyer.account.address.toLowerCase(),
    );

    // The binding is what executeRelease relies on to refuse a redirected payment, so it must not
    // be re-pointable — not even by the attester that set it.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.registerMandate([MANDATE_1, ctx.stranger.account.address], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'MandateAlreadyRegistered',
    );
  });

  it('refuses a deposit against an unregistered mandate', async () => {
    const ctx = await deploy();

    // Otherwise capital could land somewhere with no bound recipient, and therefore no way out.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.deposit([MANDATE_1, FUNDING], { account: ctx.buyer.account }),
      ctx.vault,
      'MandateNotRegistered',
    );
  });

  it('escrows a deposit and tracks it per mandate', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
    assert.equal(await ctx.usdc.read.balanceOf([ctx.vault.address]), FUNDING);
    assert.equal(await ctx.vault.read.balanceOf([MANDATE_2]), 0n);
  });

  /** Anyone may fund; a treasury funding a policy-capped agent's mandate is a first-class use. */
  it('lets a third party fund a mandate they do not own', async () => {
    const ctx = await deploy();
    await ctx.vault.write.registerMandate([MANDATE_1, ctx.buyer.account.address], {
      account: ctx.attester.account,
    });

    await ctx.usdc.write.mint([ctx.stranger.account.address, FUNDING]);
    await ctx.usdc.write.approve([ctx.vault.address, FUNDING], { account: ctx.stranger.account });
    await ctx.vault.write.deposit([MANDATE_1, FUNDING], { account: ctx.stranger.account });

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
    // Funding does not confer any claim: the way out is still bound to the buyer.
    assert.equal(
      (await ctx.vault.read.buyerOf([MANDATE_1])).toLowerCase(),
      ctx.buyer.account.address.toLowerCase(),
    );
  });

  // -----------------------------------------------------------------------------------------
  // The safety property: no exit without the book's word
  // -----------------------------------------------------------------------------------------

  /**
   * THE test. If a buyer could pull capital here while the Hedera book still counted it as
   * committed, the attested balance would be worthless and the book could match against money that
   * was already gone. There is deliberately no withdraw function, no timeout escape and no owner
   * sweep — so the only way to assert this is that the authorised paths reject the buyer outright.
   */
  it('gives the buyer no unilateral way out', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, FUNDING], { account: ctx.buyer.account }),
      ctx.vault,
      'NotAttester',
    );

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_A, MATCH_1, LOCK_A, SECRET_HASH], {
        account: ctx.buyer.account,
      }),
      ctx.vault,
      'NotAttester',
    );

    // Untouched.
    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
  });

  it('releases to the buyer under an authorisation', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    const before = await ctx.usdc.read.balanceOf([ctx.buyer.account.address]);

    await viem.assertions.emitWithArgs(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, 40_000_000_000n], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'ReleaseExecuted',
      [AUTH_A, MANDATE_1, ctx.buyer.account.address, 40_000_000_000n],
    );

    assert.equal(
      await ctx.usdc.read.balanceOf([ctx.buyer.account.address]),
      before + 40_000_000_000n,
    );
    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING - 40_000_000_000n);
  });

  /**
   * `executeRelease` takes no recipient. A compromised attester relaying a forged release can only
   * return a buyer's capital to that same buyer — it cannot redirect it to itself.
   */
  it('pays the registered buyer even when the attester is the caller', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    const attesterBefore = await ctx.usdc.read.balanceOf([ctx.attester.account.address]);
    const buyerBefore = await ctx.usdc.read.balanceOf([ctx.buyer.account.address]);

    await ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, FUNDING], {
      account: ctx.attester.account,
    });

    assert.equal(await ctx.usdc.read.balanceOf([ctx.attester.account.address]), attesterBefore);
    assert.equal(await ctx.usdc.read.balanceOf([ctx.buyer.account.address]), buyerBefore + FUNDING);
  });

  /** Replay guard. The book mints ids from its own chain id and address; here they are single-use. */
  it('consumes an authorisation exactly once', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);

    await ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, 10_000_000_000n], {
      account: ctx.attester.account,
    });
    assert.equal(await ctx.vault.read.isConsumed([AUTH_A]), true);

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, 10_000_000_000n], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'AuthorisationConsumed',
    );
  });

  /**
   * Per-mandate accounting is arithmetic, not policy: even a fully compromised attester cannot make
   * one mandate's authorisation reach another mandate's capital.
   */
  it('cannot pay out more than the mandate itself holds', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx, MANDATE_1, FUNDING);
    await registerAndFund(ctx, MANDATE_2, 0n);

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_2, FUNDING], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'InsufficientVaultBalance',
    );

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
  });

  // -----------------------------------------------------------------------------------------
  // Payouts: bound to the registered seller, and delivered through the escrow
  // -----------------------------------------------------------------------------------------

  /**
   * The payee binding, and the reason it is made at MATCH time rather than at payout time: the
   * seller can read it on Arc while they still hold the paper. A binding they could only check after
   * delivering would not be worth checking.
   */
  it('binds a match to its payee once and permanently', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);

    const payout = await ctx.vault.read.payoutOf([MATCH_1]);
    assert.equal(payout.seller.toLowerCase(), ctx.seller.account.address.toLowerCase());
    assert.equal(payout.mandateId, MANDATE_1);
    assert.equal(payout.price, PRICE);
    assert.equal(payout.executed, false);

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.registerMatch([MATCH_1, MANDATE_1, ctx.stranger.account.address, PRICE], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'MatchAlreadyRegistered',
    );
  });

  it('refuses a payout for a match it was never told about', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);

    // No fallback to a caller-supplied payee: an unregistered match has no address this contract is
    // willing to invent.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_B, MATCH_1, LOCK_A, SECRET_HASH], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'MatchNotRegistered',
    );

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
  });

  /**
   * THE test for this path. `executePayout` takes no beneficiary and no amount, so there is nothing
   * for the relay to choose: the capital leaves toward the immutable escrow, in a lock that names the
   * registered seller at the registered price. The attester is the caller here and still cannot make
   * the money come to it — and cannot claim the lock either, because the escrow refuses anyone but
   * the beneficiary.
   */
  it('pays into the escrow, locked for the registered seller and nobody else', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);

    await viem.assertions.emitWithArgs(
      ctx.vault.write.executePayout([AUTH_B, MATCH_1, LOCK_A, SECRET_HASH], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'PayoutExecuted',
      [AUTH_B, MATCH_1, MANDATE_1, ctx.seller.account.address, LOCK_A, SECRET_HASH, PRICE],
    );

    // The capital is in the escrow, not in an account of the relay's choosing.
    assert.equal(await ctx.usdc.read.balanceOf([ctx.escrow.address]), PRICE);
    assert.equal(await ctx.usdc.read.balanceOf([ctx.attester.account.address]), 0n);
    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING - PRICE);

    const lock = await ctx.escrow.read.getLock([LOCK_A]);
    assert.equal(lock.status, LockStatus.Locked);
    assert.equal(lock.kind, LegKind.Payment);
    assert.equal(lock.beneficiary.toLowerCase(), ctx.seller.account.address.toLowerCase());
    assert.equal(lock.depositor.toLowerCase(), ctx.vault.address.toLowerCase());
    assert.equal(lock.tradeRef, MATCH_1);
    assert.equal(lock.secretHash, SECRET_HASH);
    assert.equal(lock.amount, PRICE);

    // Even holding the (public) preimage, the attester is not the beneficiary.
    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.claim([LOCK_A, SECRET], { account: ctx.attester.account }),
      ctx.escrow,
      'NotBeneficiary',
    );

    await ctx.escrow.write.claim([LOCK_A, SECRET], { account: ctx.seller.account });
    assert.equal(await ctx.usdc.read.balanceOf([ctx.seller.account.address]), PRICE);
  });

  /** One match, at most one payout, ever — independent of how many authorisation ids exist. */
  it('refuses a second payout against the same match', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);

    await ctx.vault.write.executePayout([AUTH_B, MATCH_1, LOCK_A, SECRET_HASH], {
      account: ctx.attester.account,
    });

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_A, MATCH_1, LOCK_B, SECRET_HASH], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'PayoutAlreadyExecuted',
    );

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING - PRICE);
  });

  /**
   * The recovery path that the escrow hop makes possible. A payout the seller cannot take — a
   * hashlock the relay got wrong, a lost key — is not burned: at timeout it comes back to the
   * mandate and re-enters the book through the ordinary funding path, as a {Deposited} the attester
   * already knows how to relay.
   */
  it('returns an unclaimed payout to the mandate at timeout', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);
    await ctx.vault.write.executePayout([AUTH_B, MATCH_1, LOCK_A, SECRET_HASH], {
      account: ctx.attester.account,
    });

    // Too early: the escrow decides when a lock is refundable, and it is still claimable.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.reclaimPayout([LOCK_A]),
      ctx.escrow,
      'TimeoutNotReached',
    );

    await networkHelpers.time.increase(Number(await ctx.vault.read.PAYMENT_LOCK_DURATION()) + 1);

    // Permissionless, because it can only move capital back where it came from.
    await viem.assertions.emit(
      ctx.vault.write.reclaimPayout([LOCK_A], { account: ctx.stranger.account }),
      ctx.vault,
      'PayoutReclaimed',
    );

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
    assert.equal(await ctx.usdc.read.balanceOf([ctx.escrow.address]), 0n);
    assert.equal((await ctx.escrow.read.getLock([LOCK_A])).status, LockStatus.Refunded);
    // The trace is cleared, so the same lock cannot be reclaimed twice.
    assert.equal(await ctx.vault.read.payoutLockOf([LOCK_A]), zeroHash);
  });

  it('cannot reclaim a payout the seller already took, or a lock it never opened', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);
    await ctx.vault.write.executePayout([AUTH_B, MATCH_1, LOCK_A, SECRET_HASH], {
      account: ctx.attester.account,
    });

    await ctx.escrow.write.claim([LOCK_A, SECRET], { account: ctx.seller.account });
    await networkHelpers.time.increase(Number(await ctx.vault.read.PAYMENT_LOCK_DURATION()) + 1);

    // A claim is terminal in the escrow, so a settled payout can never be recalled.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.reclaimPayout([LOCK_A]),
      ctx.escrow,
      'LockNotOpen',
    );

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.reclaimPayout([LOCK_B]),
      ctx.vault,
      'PayoutLockUnknown',
    );
  });

  it('shares the replay guard across both outflow paths', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    await registerMatch(ctx);

    await ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, 1_000_000n], {
      account: ctx.attester.account,
    });

    // The same id must not work on the other path either.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_A, MATCH_1, LOCK_A, SECRET_HASH], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'AuthorisationConsumed',
    );
  });

  /** Per-mandate accounting applies to payouts too: a binding cannot reach another mandate's money. */
  it('cannot pay out more than the bound mandate holds', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx, MANDATE_1, FUNDING);
    await registerAndFund(ctx, MANDATE_2, 0n);
    await registerMatch(ctx, MATCH_2, MANDATE_2, PRICE);

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_B, MATCH_2, LOCK_A, SECRET_HASH], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'InsufficientVaultBalance',
    );

    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), FUNDING);
  });

  // -----------------------------------------------------------------------------------------
  // Liveness recovery
  // -----------------------------------------------------------------------------------------

  /**
   * A stalled attester freezes capital here. That is a liveness failure, not a loss, and the fix is
   * rotation — deliberately the only recovery path, because a timeout-based withdrawal would hand
   * the buyer exactly the unilateral exit the design exists to deny.
   */
  it('recovers a stalled relay by rotating the attester', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, FUNDING], {
        account: ctx.stranger.account,
      }),
      ctx.vault,
      'NotAttester',
    );

    await ctx.vault.write.setAttester([ctx.stranger.account.address], {
      account: ctx.owner.account,
    });

    await ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, FUNDING], {
      account: ctx.stranger.account,
    });
    assert.equal(await ctx.vault.read.balanceOf([MANDATE_1]), 0n);
  });

  it('lets only the owner rotate the attester', async () => {
    const ctx = await deploy();

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.setAttester([ctx.stranger.account.address], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'NotOwner',
    );
  });

  it('rejects zero addresses and zero amounts', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);
    const from = { account: ctx.attester.account };

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.registerMandate([MANDATE_2, zeroAddress], from),
      ctx.vault,
      'ZeroAddress',
    );

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, 0n], from),
      ctx.vault,
      'ZeroValue',
    );

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.registerMatch([MATCH_1, MANDATE_1, zeroAddress, PRICE], from),
      ctx.vault,
      'ZeroAddress',
    );

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.registerMatch([MATCH_1, MANDATE_1, ctx.seller.account.address, 0n], from),
      ctx.vault,
      'ZeroValue',
    );

    // A payee binding against a mandate with no cash leg would have no capital to draw on.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.registerMatch([MATCH_2, MANDATE_2, ctx.seller.account.address, PRICE], from),
      ctx.vault,
      'MandateNotRegistered',
    );
  });
});
