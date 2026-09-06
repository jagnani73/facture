/**
 * Funding the vault out of the agent's own wallet.
 *
 * Two things here are load-bearing beyond the usual, and both are tested first.
 *
 * **The custody key.** `vaultMandateId` is the third copy of one line in this repo. A copy
 * that drifted would deposit into a bucket the venue and the vault cannot see, and the money
 * would be unreachable rather than misfiled — `executeRelease` reads `_balanceOf[mandateId]`
 * and nothing else. So it is pinned against the vector `docs/deployments.md` records for a
 * mandate whose capital really is under that number on the deployed contract.
 *
 * **The three outcomes.** A deposit that Circle has not reported on is not a deposit that
 * failed. Reporting it as one tells an operator their capital is in the wallet when it may
 * already be in the vault, and the natural next action after "failed" is to run it again.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '../src/logger.js';
import type { VaultBacking } from '../src/mandate.js';
import {
  APPROVE_SIGNATURE,
  createArcVaultReader,
  DEPOSIT_SIGNATURE,
  ERC20_ABI,
  executeDeposit,
  MANDATE_VAULT_ABI,
  MAX_UINT128,
  planDeposit,
  vaultMandateId,
  ZERO_ADDRESS,
  type DepositPlan,
  type PlanDepositInput,
  type VaultReader,
} from '../src/vault.js';
import type {
  ContractCallInput,
  SubmittedTransaction,
  TokenBalance,
  TransactionOutcome,
  TransferInput,
  WalletClient,
  WalletSetSummary,
  WalletSummary,
} from '../src/wallet.js';
import type { Address } from 'viem';

/* ── the custody key ─────────────────────────────────────────────────────────────────── */

describe('vaultMandateId', () => {
  /*
   * The one assertion that makes a third copy of this derivation safe. From
   * docs/deployments.md: Harrow Point's mandate, whose 5 USDC really is under this key on
   * MandateVault at 0x217256d0…, deposited by the buyer's own wallet.
   */
  it('agrees with the deployed vault on a mandate that actually holds capital', () => {
    expect(vaultMandateId('8b879d02-4593-4d66-82bf-52d4833401b6')).toBe(
      15346442137576820289478969865486017349700696992123142042335952903215516347363n,
    );
  });

  it('hashes the UUID string, not the 16 bytes it encodes', () => {
    // The parsed-bytes reading of the same UUID. A plausible alternative that would put the
    // capital somewhere else entirely.
    const asBytes = BigInt(
      '0x' + [...'8b879d0245934d6682bf52d4833401b6'.matchAll(/../g)].map((m) => m[0]).join(''),
    );
    expect(vaultMandateId('8b879d02-4593-4d66-82bf-52d4833401b6')).not.toBe(asBytes);
  });

  it('is deterministic and fits a uint256', () => {
    const id = 'c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d';
    expect(vaultMandateId(id)).toBe(vaultMandateId(id));
    expect(vaultMandateId(id)).toBeLessThan(1n << 256n);
    expect(vaultMandateId(id)).not.toBe(vaultMandateId('c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3e'));
  });
});

describe('the ABI carries only what this package may call', () => {
  const names = MANDATE_VAULT_ABI.map((entry) => entry.name);

  it('cannot register a mandate — that is the venue’s one-shot write', () => {
    expect(names).not.toContain('registerMandate');
  });

  it('cannot move capital out — those are the attester’s', () => {
    expect(names).not.toContain('executeRelease');
    expect(names).not.toContain('executePayout');
    expect(names).not.toContain('registerMatch');
  });

  it('carries the reads a deposit has to make first, and the deposit', () => {
    expect(names).toEqual(
      expect.arrayContaining(['balanceOf', 'buyerOf', 'settlementToken', 'deposit']),
    );
  });

  it('spells the Circle signatures exactly as the contracts declare them', () => {
    expect(DEPOSIT_SIGNATURE).toBe('deposit(uint256,uint128)');
    expect(APPROVE_SIGNATURE).toBe('approve(address,uint256)');
    expect(ERC20_ABI.map((e) => e.name)).toEqual(
      expect.arrayContaining(['allowance', 'approve', 'balanceOf']),
    );
  });
});

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const OTHER: Address = '0x2222222222222222222222222222222222222222';
const USDC: Address = '0x3600000000000000000000000000000000000000';
/**
 * The real `MandateVault` on Arc testnet, EIP-55 checksummed.
 *
 * Written as viem computes it rather than as it reads in `docs/deployments.md`, which is
 * lowercase. Typing a checksum by hand does not produce one — the first draft of this line
 * did exactly that and `getAddress` caught it, which is the same tripwire `demo-reset.mjs`
 * relies on to catch the four invented seed addresses.
 */
const VAULT: Address = '0x217256d0FDF83ffd81bbC6884Ad44f5C02501102';
const MANDATE = '8b879d02-4593-4d66-82bf-52d4833401b6';

/** Harrow Point's real figures: 0.05 USDC required against $50,000.00 committed. */
const backing = (over: Partial<VaultBacking> = {}): VaultBacking => ({
  checked: true,
  depositedUsdcMinor: 0n,
  requiredUsdcMinor: 50_000n,
  backed: false,
  ...over,
});

const input = (over: Partial<PlanDepositInput> = {}): PlanDepositInput => ({
  mandateId: MANDATE,
  backing: backing(),
  walletAddress: WALLET,
  walletUsdcMinor: 6_000_000n,
  registeredBuyer: WALLET,
  depositedUsdcMinor: 0n,
  standingAllowanceUsdcMinor: 0n,
  settlementToken: USDC,
  usdcAddress: USDC,
  ...over,
});

const planned = (over: Partial<PlanDepositInput> = {}): DepositPlan => {
  const result = planDeposit(input(over));
  if (!result.ok) throw new Error(`expected a plan, got ${result.error.code}`);
  return result.value;
};

const refusedCode = (over: Partial<PlanDepositInput> = {}): string => {
  const result = planDeposit(input(over));
  if (result.ok) throw new Error('expected a refusal');
  return result.error.code;
};

/* ── planDeposit ─────────────────────────────────────────────────────────────────────── */

describe('planDeposit refuses before it converts anything', () => {
  it('will not invent a requirement when the venue publishes none', () => {
    expect(refusedCode({ backing: null })).toBe('VENUE_REPORTED_NO_VAULT');
  });

  it('treats "the venue holds no vault to ask" as no requirement, not as unbacked', () => {
    expect(refusedCode({ backing: backing({ checked: false }) })).toBe('VENUE_REPORTED_NO_VAULT');
  });

  it('refuses when the vault escrows an asset other than the one it would approve', () => {
    expect(refusedCode({ settlementToken: OTHER })).toBe('SETTLEMENT_TOKEN_MISMATCH');
  });

  it('refuses an unregistered mandate rather than registering it', () => {
    const result = planDeposit(input({ registeredBuyer: ZERO_ADDRESS }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MANDATE_NOT_REGISTERED');
    // The sentence has to name where a registration comes from, or the refusal is a dead end.
    expect(result.error.detail).toContain('POST /v1/mandates');
  });
});

describe('planDeposit will not fund someone else’s bid', () => {
  it('refuses a mandate registered to another address', () => {
    expect(refusedCode({ registeredBuyer: OTHER })).toBe('REGISTERED_TO_ANOTHER_ADDRESS');
  });

  /*
   * The ordering matters. A wrong registration is not recoverable by retrying with a
   * different amount — registerMandate is one-shot and executeRelease pays buyerOf — so it
   * must be the refusal an operator sees, not a funding message they would act on first.
   */
  it('says so even when the amount would also have been refused', () => {
    expect(refusedCode({ registeredBuyer: OTHER, walletUsdcMinor: 0n })).toBe(
      'REGISTERED_TO_ANOTHER_ADDRESS',
    );
  });

  it('compares addresses without caring about checksum case', () => {
    expect(planDeposit(input({ registeredBuyer: WALLET.toUpperCase() as Address })).ok).toBe(true);
  });
});

describe('planDeposit sizes the deposit from the venue’s figure and the chain’s balance', () => {
  it('deposits the shortfall', () => {
    const plan = planned({ depositedUsdcMinor: 20_000n });
    expect(plan.requiredUsdcMinor).toBe(50_000n);
    expect(plan.depositedUsdcMinor).toBe(20_000n);
    expect(plan.shortfallUsdcMinor).toBe(30_000n);
    expect(plan.amountUsdcMinor).toBe(30_000n);
  });

  /*
   * The venue's number is the converted one and is taken as given; the chain's is the
   * balance. Nothing here recomputes a requirement from committed capital, because that is
   * the ppm scale this package must not carry a second copy of.
   */
  it('takes the requirement from the venue and the balance from the chain', () => {
    const plan = planned({
      backing: backing({ requiredUsdcMinor: 50_000n, depositedUsdcMinor: 999n }),
      depositedUsdcMinor: 20_000n,
    });
    expect(plan.requiredUsdcMinor).toBe(50_000n);
    expect(plan.depositedUsdcMinor).toBe(20_000n);
  });

  it('has nothing to do when the vault already covers the requirement', () => {
    expect(refusedCode({ depositedUsdcMinor: 5_000_000n })).toBe('ALREADY_BACKED');
  });

  it('lets an operator top up past the requirement with an explicit amount', () => {
    const plan = planned({ depositedUsdcMinor: 5_000_000n, overrideAmountUsdcMinor: 1_000_000n });
    expect(plan.amountUsdcMinor).toBe(1_000_000n);
    expect(plan.shortfallUsdcMinor).toBe(0n);
  });

  it('refuses a wallet that cannot cover the deposit', () => {
    expect(refusedCode({ walletUsdcMinor: 49_999n })).toBe('INSUFFICIENT_WALLET_USDC');
  });

  it('refuses an amount the uint128 argument cannot carry', () => {
    expect(refusedCode({ overrideAmountUsdcMinor: 0n })).toBe('AMOUNT_OUT_OF_RANGE');
    expect(refusedCode({ overrideAmountUsdcMinor: MAX_UINT128 + 1n })).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('needs an approval for exactly the deposit, and none when one already stands', () => {
    expect(planned().approvalUsdcMinor).toBe(50_000n);
    expect(planned({ standingAllowanceUsdcMinor: 50_000n }).approvalUsdcMinor).toBe(0n);
    expect(planned({ standingAllowanceUsdcMinor: 1_000_000n }).approvalUsdcMinor).toBe(0n);
    expect(planned({ standingAllowanceUsdcMinor: 49_999n }).approvalUsdcMinor).toBe(50_000n);
  });

  it('carries the custody key the deposit will actually be made against', () => {
    expect(planned().vaultMandateId).toBe(vaultMandateId(MANDATE));
  });
});

/* ── executeDeposit ──────────────────────────────────────────────────────────────────── */

interface Submitted {
  readonly input: ContractCallInput;
}

interface FakeWallet extends WalletClient {
  readonly calls: Submitted[];
}

const outcome = (over: Partial<TransactionOutcome> = {}): TransactionOutcome => ({
  id: 'tx-1',
  state: 'CONFIRMED',
  result: 'succeeded',
  txHash: '0xabc',
  errorReason: null,
  errorDetails: null,
  timedOut: false,
  ...over,
});

/** Answers each submitted call in turn with the outcome queued for it. */
function fakeWallet(outcomes: readonly TransactionOutcome[]): FakeWallet {
  const calls: Submitted[] = [];
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} must not be called when depositing`);
  };
  return {
    blockchain: 'ARC-TESTNET',
    usdcAddress: USDC,
    calls,
    async executeContract(callInput) {
      calls.push({ input: callInput });
      return { id: `tx-${calls.length}`, state: 'INITIATED' } satisfies SubmittedTransaction;
    },
    async awaitTransaction(transactionId) {
      const index = Number(transactionId.replace('tx-', '')) - 1;
      const answer = outcomes[index];
      if (answer === undefined) throw new Error(`no outcome queued for ${transactionId}`);
      return { ...answer, id: transactionId };
    },
    transaction: notUsed('transaction') as unknown as (id: string) => Promise<TransactionOutcome>,
    /*
     * Fatal. A deposit is a contract execution; a plain USDC transfer to the vault would be
     * credited to no mandate at all and could never be released.
     */
    transferUsdc: notUsed('transferUsdc') as unknown as (
      i: TransferInput,
    ) => Promise<SubmittedTransaction>,
    createWalletSet: notUsed('createWalletSet') as unknown as (
      n: string,
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
    usdcBalance: notUsed('usdcBalance') as unknown as (id: string) => Promise<TokenBalance | null>,
  };
}

function fakeReader(balances: readonly bigint[]): VaultReader & { reads: number } {
  let reads = 0;
  const reader = {
    vaultAddress: VAULT,
    usdcAddress: USDC,
    get reads() {
      return reads;
    },
    async buyerOf(): Promise<Address> {
      return WALLET;
    },
    async depositedFor(): Promise<bigint> {
      const value = balances[Math.min(reads, balances.length - 1)];
      reads += 1;
      if (value === undefined) throw new Error('vault unreadable');
      return value;
    },
    async allowance(): Promise<bigint> {
      return 0n;
    },
    async usdcBalanceOf(): Promise<bigint> {
      return 6_000_000n;
    },
    async settlementToken(): Promise<Address> {
      return USDC;
    },
  };
  return reader as VaultReader & { reads: number };
}

let logger: Logger;
beforeEach(() => {
  logger = createLogger({ level: 'error', write: () => {} });
});

const run = (
  outcomes: readonly TransactionOutcome[],
  balancesAfter: readonly bigint[],
  plan = planned(),
): Promise<{ receipt: Awaited<ReturnType<typeof executeDeposit>>; wallet: FakeWallet }> => {
  const wallet = fakeWallet(outcomes);
  return executeDeposit(plan, {
    wallet,
    walletId: 'wallet-1',
    reader: fakeReader(balancesAfter),
    logger,
    idempotencyKey: 'run-key',
  }).then((receipt) => ({ receipt, wallet }));
};

describe('executeDeposit approves then deposits', () => {
  it('sends both calls, to the right contracts, in the right order', async () => {
    const { receipt, wallet } = await run([outcome(), outcome()], [50_000n]);

    expect(receipt.state).toBe('deposited');
    expect(wallet.calls).toHaveLength(2);

    const [approve, deposit] = wallet.calls;
    expect(approve?.input.contractAddress).toBe(USDC);
    expect(approve?.input.abiFunctionSignature).toBe(APPROVE_SIGNATURE);
    expect(approve?.input.abiParameters).toEqual([VAULT, '50000']);

    expect(deposit?.input.contractAddress).toBe(VAULT);
    expect(deposit?.input.abiFunctionSignature).toBe(DEPOSIT_SIGNATURE);
    expect(deposit?.input.abiParameters).toEqual([vaultMandateId(MANDATE).toString(10), '50000']);
  });

  it('passes amounts as decimal strings, never as bigints or numbers', async () => {
    const { wallet } = await run([outcome(), outcome()], [50_000n]);
    for (const call of wallet.calls) {
      for (const parameter of call.input.abiParameters) expect(typeof parameter).toBe('string');
    }
  });

  it('approves exactly the deposit, so a success leaves no standing allowance', async () => {
    const { receipt, wallet } = await run([outcome(), outcome()], [50_000n]);
    expect(wallet.calls[0]?.input.abiParameters[1]).toBe('50000');
    expect(receipt.allowanceLeftStanding).toBe(false);
  });

  it('skips the approval when one already covers it', async () => {
    const plan = planned({ standingAllowanceUsdcMinor: 1_000_000n });
    const { receipt, wallet } = await run([outcome()], [50_000n], plan);
    expect(wallet.calls).toHaveLength(1);
    expect(wallet.calls[0]?.input.abiFunctionSignature).toBe(DEPOSIT_SIGNATURE);
    expect(receipt.approve).toBeNull();
    expect(receipt.state).toBe('deposited');
  });

  it('gives each write its own idempotency key, both derived from the run’s', async () => {
    const { wallet } = await run([outcome(), outcome()], [50_000n]);
    expect(wallet.calls[0]?.input.idempotencyKey).toBe('run-key-approve');
    expect(wallet.calls[1]?.input.idempotencyKey).toBe('run-key-deposit');
  });

  it('pads the gas limit rather than the price — Arc’s floor is a floor', async () => {
    const { wallet } = await run([outcome(), outcome()], [50_000n]);
    const fees = wallet.calls.map((call) => {
      const fee = call.input.fee;
      if (fee === undefined || fee.type !== 'absolute') throw new Error('expected an absolute fee');
      return fee.config as { maxFee: string; gasLimit: string };
    });
    for (const fee of fees) expect(fee.maxFee).toBe('20');
    // Deposit writes more than an approval does, and a limit is headroom rather than a price.
    expect(Number(fees[1]?.gasLimit)).toBeGreaterThan(Number(fees[0]?.gasLimit));
  });
});

describe('executeDeposit when the approval does not land', () => {
  it('never submits the deposit after a failed approval', async () => {
    const { receipt, wallet } = await run([outcome({ state: 'FAILED', result: 'failed' })], []);
    expect(receipt.state).toBe('failed');
    expect(receipt.deposit).toBeNull();
    expect(wallet.calls).toHaveLength(1);
    expect(receipt.allowanceLeftStanding).toBe(false);
  });

  /*
   * The point of stopping here is that nothing has moved yet. Pressing on would submit a
   * deposit against an allowance nobody can confirm, and the revert would look like a vault
   * problem rather than a sequencing one.
   */
  it('stops on an unknown approval, and says no capital moved', async () => {
    const { receipt, wallet } = await run([outcome({ state: 'SENT', result: 'unknown' })], []);
    expect(receipt.state).toBe('unknown');
    expect(receipt.deposit).toBeNull();
    expect(wallet.calls).toHaveLength(1);
    expect(receipt.detail).toContain('No capital has moved');
  });
});

describe('executeDeposit when the deposit does not land', () => {
  it('reports a revert as a failure and names the allowance left standing', async () => {
    const { receipt } = await run(
      [outcome(), outcome({ state: 'FAILED', result: 'failed', errorReason: 'reverted' })],
      [0n],
    );
    expect(receipt.state).toBe('failed');
    expect(receipt.allowanceLeftStanding).toBe(true);
    expect(receipt.detail).toContain('allowance stands');
  });

  /*
   * A terminal refusal from Circle outranks a balance that moved. Money arriving in the same
   * block from somewhere else — another depositor, a reclaimed payout — must not be credited
   * to a run that Circle says posted nothing.
   */
  it('does not credit itself with capital somebody else posted', async () => {
    const { receipt } = await run(
      [outcome(), outcome({ state: 'FAILED', result: 'failed' })],
      [50_000n],
    );
    expect(receipt.state).toBe('failed');
    expect(receipt.detail).toContain('check who else');
  });

  /**
   * The defect this whole three-state design exists to prevent. Circle has not reported the
   * transaction settled, but the vault gained the money — so the capital HAS left the
   * wallet, and calling it a failure invites an operator to deposit again.
   */
  it('calls it deposited when the vault balance moved, whatever Circle says', async () => {
    const { receipt } = await run(
      [outcome(), outcome({ state: 'SENT', result: 'unknown', timedOut: true })],
      [50_000n],
    );
    expect(receipt.state).toBe('deposited');
    expect(receipt.depositedAfterUsdcMinor).toBe(50_000n);
    expect(receipt.detail).toContain('the vault balance moved');
  });

  it('is unknown — never failed — when nothing settled and nothing moved', async () => {
    const { receipt } = await run(
      [outcome(), outcome({ state: 'SENT', result: 'unknown', timedOut: true })],
      [0n],
    );
    expect(receipt.state).toBe('unknown');
    expect(receipt.state).not.toBe('failed');
    expect(receipt.detail).toContain('NOT a failure');
    // An operator resuming has to be told the key, or the retry becomes a second deposit.
    expect(receipt.detail).toContain('run-key');
  });

  it('still answers when the vault cannot be re-read afterwards', async () => {
    const wallet = fakeWallet([outcome(), outcome()]);
    const reader: VaultReader = {
      ...fakeReader([]),
      async depositedFor(): Promise<bigint> {
        throw new Error('rpc down');
      },
    };
    const receipt = await executeDeposit(planned(), {
      wallet,
      walletId: 'wallet-1',
      reader,
      logger,
      idempotencyKey: 'run-key',
    });
    expect(receipt.state).toBe('deposited');
    expect(receipt.depositedAfterUsdcMinor).toBeNull();
  });
});

/* ── the reader ──────────────────────────────────────────────────────────────────────── */

describe('createArcVaultReader', () => {
  it('checksums the addresses it was given rather than trusting the case', () => {
    const reader = createArcVaultReader({
      vaultAddress: '0x217256d0fdf83ffd81bbc6884ad44f5c02501102',
      usdcAddress: USDC,
    });
    expect(reader.vaultAddress).toBe(VAULT);
    expect(reader.usdcAddress).toBe(USDC);
  });

  it('rejects an address that is not one, before any call is made', () => {
    expect(() => createArcVaultReader({ vaultAddress: '0xnope' })).toThrow();
  });
});
