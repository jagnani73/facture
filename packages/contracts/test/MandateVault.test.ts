import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, toHex, zeroAddress } from 'viem';

const { viem } = await hre.network.getOrCreate();

const MANDATE_1 = 1n;
const MANDATE_2 = 2n;
const FUNDING = 100_000_000_000n; // $100,000.000000

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
    const vault = await viem.deployContract('MandateVault', [
      usdc.address,
      attester.account.address,
      owner.account.address,
    ]);

    await usdc.write.mint([buyer.account.address, FUNDING * 10n]);
    await usdc.write.approve([vault.address, FUNDING * 10n], { account: buyer.account });

    return { usdc, vault, owner, attester, buyer, seller, stranger };
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

  const AUTH_A = keccak256(toHex('auth:1'));
  const AUTH_B = keccak256(toHex('auth:2'));

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

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, FUNDING], { account: ctx.buyer.account }),
      ctx.vault,
      'NotAttester',
    );

    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_A, MANDATE_1, ctx.buyer.account.address, FUNDING], {
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

  it('pays a settled trade out to the named beneficiary', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);

    await viem.assertions.emitWithArgs(
      ctx.vault.write.executePayout(
        [AUTH_B, MANDATE_1, ctx.seller.account.address, 39_178_082_192n],
        { account: ctx.attester.account },
      ),
      ctx.vault,
      'PayoutExecuted',
      [AUTH_B, MANDATE_1, ctx.seller.account.address, 39_178_082_192n],
    );

    assert.equal(await ctx.usdc.read.balanceOf([ctx.seller.account.address]), 39_178_082_192n);
  });

  it('shares the replay guard across both outflow paths', async () => {
    const ctx = await deploy();
    await registerAndFund(ctx);

    await ctx.vault.write.executeRelease([AUTH_A, MANDATE_1, 1_000_000n], {
      account: ctx.attester.account,
    });

    // The same id must not work on the other path either.
    await viem.assertions.revertWithCustomError(
      ctx.vault.write.executePayout([AUTH_A, MANDATE_1, ctx.seller.account.address, 1_000_000n], {
        account: ctx.attester.account,
      }),
      ctx.vault,
      'AuthorisationConsumed',
    );
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
      ctx.vault.write.executePayout([AUTH_A, MANDATE_1, zeroAddress, 1_000n], from),
      ctx.vault,
      'ZeroAddress',
    );
  });
});
