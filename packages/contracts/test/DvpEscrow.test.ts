import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, toHex } from 'viem';

const { viem, networkHelpers } = await hre.network.getOrCreate();

const LegKind = { Unspecified: 0, Delivery: 1, Payment: 2 } as const;
const LockStatus = { None: 0, Locked: 1, Claimed: 2, Refunded: 3 } as const;

const AMOUNT = 39_473_972_603n; // one invoice's worth of proceeds
const HOUR = 3_600;

/**
 * These tests cover one leg on one chain, which is all a single deployment can be tested for. The
 * cross-chain property - that both legs complete or both refund - is a consequence of the ordering
 * rule documented on {IDvpEscrow}, and that rule is an operator obligation this contract cannot
 * enforce and a single-chain test cannot exercise.
 *
 * What IS testable here, and is what actually protects funds: claim and refund are disjoint in time,
 * neither can happen twice, and the preimage becomes public exactly when the claim succeeds.
 */
describe('DvpEscrow', () => {
  async function deploy() {
    const [depositor, beneficiary, stranger] = await viem.getWalletClients();
    assert.ok(depositor && beneficiary && stranger);

    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract('MockUSDC', []);
    const escrow = await viem.deployContract('DvpEscrow', []);

    await usdc.write.mint([depositor.account.address, AMOUNT * 10n]);
    await usdc.write.approve([escrow.address, AMOUNT * 10n], { account: depositor.account });

    return { publicClient, usdc, escrow, depositor, beneficiary, stranger };
  }

  const SECRET = keccak256(toHex('facture:preimage:trade-1'));
  const SECRET_HASH = keccak256(SECRET);
  const LOCK_ID = keccak256(toHex('lock:1'));
  const TRADE_REF = keccak256(toHex('match:1'));

  async function openLock(
    ctx: Awaited<ReturnType<typeof deploy>>,
    timeoutSeconds = 2 * HOUR,
  ): Promise<bigint> {
    const now = (await ctx.publicClient.getBlock()).timestamp;
    const timeout = now + BigInt(timeoutSeconds);

    await ctx.escrow.write.openLock(
      [
        LOCK_ID,
        SECRET_HASH,
        TRADE_REF,
        ctx.beneficiary.account.address,
        ctx.usdc.address,
        AMOUNT,
        timeout,
        LegKind.Payment,
      ],
      { account: ctx.depositor.account },
    );

    return timeout;
  }

  it('escrows the asset on open', async () => {
    const ctx = await deploy();
    await openLock(ctx);

    assert.equal(await ctx.usdc.read.balanceOf([ctx.escrow.address]), AMOUNT);

    const lock = await ctx.escrow.read.getLock([LOCK_ID]);
    assert.equal(lock.status, LockStatus.Locked);
    assert.equal(lock.amount, AMOUNT);
    assert.equal(lock.kind, LegKind.Payment);
  });

  /**
   * The claim publishes the preimage. That publication IS the cross-chain mechanism - the
   * counterparty's relayer watches for it in order to claim the other leg - so it is asserted
   * explicitly rather than treated as an incidental log field.
   */
  it('claims with the correct preimage and publishes it', async () => {
    const ctx = await deploy();
    await openLock(ctx);

    assert.equal(await ctx.escrow.read.isClaimable([LOCK_ID, SECRET]), true);

    await viem.assertions.emitWithArgs(
      ctx.escrow.write.claim([LOCK_ID, SECRET], { account: ctx.beneficiary.account }),
      ctx.escrow,
      'LockClaimed',
      [LOCK_ID, TRADE_REF, ctx.beneficiary.account.address, SECRET],
    );

    assert.equal(await ctx.usdc.read.balanceOf([ctx.beneficiary.account.address]), AMOUNT);
    assert.equal(await ctx.escrow.read.revealedSecret([LOCK_ID]), SECRET);
    assert.equal((await ctx.escrow.read.getLock([LOCK_ID])).status, LockStatus.Claimed);
  });

  it('rejects a wrong preimage', async () => {
    const ctx = await deploy();
    await openLock(ctx);

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.claim([LOCK_ID, keccak256(toHex('wrong'))], {
        account: ctx.beneficiary.account,
      }),
      ctx.escrow,
      'InvalidSecret',
    );
  });

  it('rejects a claim from anyone but the beneficiary', async () => {
    const ctx = await deploy();
    await openLock(ctx);

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.claim([LOCK_ID, SECRET], { account: ctx.stranger.account }),
      ctx.escrow,
      'NotBeneficiary',
    );
  });

  // -----------------------------------------------------------------------------------------
  // Timeout and refund - the path that guarantees a failed exchange costs only time
  // -----------------------------------------------------------------------------------------

  it('refuses to refund before the timeout', async () => {
    const ctx = await deploy();
    await openLock(ctx);

    assert.equal(await ctx.escrow.read.isRefundable([LOCK_ID]), false);

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.refund([LOCK_ID], { account: ctx.depositor.account }),
      ctx.escrow,
      'TimeoutNotReached',
    );
  });

  it('refunds the depositor in full after the timeout', async () => {
    const ctx = await deploy();
    const before = await ctx.usdc.read.balanceOf([ctx.depositor.account.address]);
    await openLock(ctx, 2 * HOUR);

    await networkHelpers.time.increase(2 * HOUR + 1);

    assert.equal(await ctx.escrow.read.isRefundable([LOCK_ID]), true);

    await viem.assertions.emitWithArgs(
      ctx.escrow.write.refund([LOCK_ID], { account: ctx.depositor.account }),
      ctx.escrow,
      'LockRefunded',
      [LOCK_ID, TRADE_REF, ctx.depositor.account.address, AMOUNT],
    );

    // Whole, not partial. A failed cross-chain exchange costs the time value of the lock and
    // nothing else.
    assert.equal(await ctx.usdc.read.balanceOf([ctx.depositor.account.address]), before);
    assert.equal(await ctx.usdc.read.balanceOf([ctx.escrow.address]), 0n);
    assert.equal((await ctx.escrow.read.getLock([LOCK_ID])).status, LockStatus.Refunded);
  });

  /**
   * Disjointness. Claim is strictly before the timeout and refund is at or after it, so there is no
   * moment at which both are live and the asset cannot be taken twice.
   */
  it('closes the claim window exactly when the refund window opens', async () => {
    const ctx = await deploy();
    await openLock(ctx, 2 * HOUR);

    await networkHelpers.time.increase(2 * HOUR + 1);

    assert.equal(await ctx.escrow.read.isClaimable([LOCK_ID, SECRET]), false);
    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.claim([LOCK_ID, SECRET], { account: ctx.beneficiary.account }),
      ctx.escrow,
      'LockExpired',
    );

    await ctx.escrow.write.refund([LOCK_ID], { account: ctx.depositor.account });
  });

  it('refuses to refund a lock that was already claimed', async () => {
    const ctx = await deploy();
    await openLock(ctx, 2 * HOUR);

    await ctx.escrow.write.claim([LOCK_ID, SECRET], { account: ctx.beneficiary.account });
    await networkHelpers.time.increase(2 * HOUR + 1);

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.refund([LOCK_ID], { account: ctx.depositor.account }),
      ctx.escrow,
      'LockNotOpen',
    );
  });

  it('refuses to refund to anyone but the depositor', async () => {
    const ctx = await deploy();
    await openLock(ctx, 2 * HOUR);
    await networkHelpers.time.increase(2 * HOUR + 1);

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.refund([LOCK_ID], { account: ctx.stranger.account }),
      ctx.escrow,
      'NotDepositor',
    );
  });

  // -----------------------------------------------------------------------------------------
  // Timeout bounds
  // -----------------------------------------------------------------------------------------

  /**
   * A lock too short to claim is a free option dressed up as a trade: the beneficiary cannot realise
   * it, and the depositor takes the asset back having appeared to offer something.
   */
  it('refuses a timeout too near to be claimable', async () => {
    const ctx = await deploy();
    const now = (await ctx.publicClient.getBlock()).timestamp;

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.openLock(
        [
          LOCK_ID,
          SECRET_HASH,
          TRADE_REF,
          ctx.beneficiary.account.address,
          ctx.usdc.address,
          AMOUNT,
          now + 60n,
          LegKind.Payment,
        ],
        { account: ctx.depositor.account },
      ),
      ctx.escrow,
      'TimeoutTooSoon',
    );
  });

  it('refuses a timeout far enough out to strand capital', async () => {
    const ctx = await deploy();
    const now = (await ctx.publicClient.getBlock()).timestamp;

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.openLock(
        [
          LOCK_ID,
          SECRET_HASH,
          TRADE_REF,
          ctx.beneficiary.account.address,
          ctx.usdc.address,
          AMOUNT,
          now + 7n * 86_400n,
          LegKind.Payment,
        ],
        { account: ctx.depositor.account },
      ),
      ctx.escrow,
      'TimeoutTooLate',
    );
  });

  it('refuses to reuse a lock id', async () => {
    const ctx = await deploy();
    await openLock(ctx);

    await viem.assertions.revertWithCustomError(
      ctx.escrow.write.openLock(
        [
          LOCK_ID,
          SECRET_HASH,
          TRADE_REF,
          ctx.beneficiary.account.address,
          ctx.usdc.address,
          AMOUNT,
          (await ctx.publicClient.getBlock()).timestamp + BigInt(2 * HOUR),
          LegKind.Payment,
        ],
        { account: ctx.depositor.account },
      ),
      ctx.escrow,
      'LockExists',
    );
  });

  it('publishes its timeout bounds', async () => {
    const ctx = await deploy();
    assert.equal(await ctx.escrow.read.MIN_LOCK_DURATION(), 900n);
    assert.equal(await ctx.escrow.read.MAX_LOCK_DURATION(), 172_800n);
    assert.equal(await ctx.escrow.read.MIN_LEG_GAP(), 3_600n);
  });
});
