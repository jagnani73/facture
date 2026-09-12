/**
 * Posting the agent's own capital into `MandateVault` on Arc.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONE THING THE CIRCLE WALLET IS ACTUALLY FOR
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * The wallet pays for neither settlement rail. A funded mandate settles out of the vault,
 * which the venue draws on with its own key; an unfunded one settles over x402 on Hedera,
 * which needs a native `TransferTransaction` the Circle wallet cannot produce. So for as
 * long as this package only ever *read* the wallet's balance, the wallet was a number the
 * agent looked at rather than money it could use — and `agent.ts` was for a while comparing
 * that number against a price, in the wrong unit, on behalf of a rail it does not pay.
 *
 * What the wallet can do, and the only thing, is fund the vault. That is this file.
 *
 * ## `deposit` pulls from `msg.sender`, and that is why this belongs here
 *
 * `MandateVault.deposit` does `safeTransferFrom(msg.sender, address(this), amount)` and
 * credits `mandateId`. It does **not** require the caller to be the registered buyer. So
 * anyone can deposit into anyone's mandate, and the money becomes that mandate's — which is
 * precisely why `scripts/demo-reset.mjs` refuses to deposit on a buyer's behalf: a
 * relayer-funded deposit credits the mandate with the *venue's* money while the deployment
 * record calls that capital the buyer's own.
 *
 * **The agent depositing its own wallet's USDC into its own buyer's mandate is the correct
 * case, and the only one that closes this loop honestly.** The capital that shows up as the
 * mandate's escrow really is the capital this process holds. Nothing here will deposit into
 * a mandate registered to someone else — see `REGISTERED_TO_ANOTHER_ADDRESS`.
 *
 * ## What this file does not do: register
 *
 * `deposit` reverts `MandateNotRegistered` against an unregistered mandate, so registration
 * has to come first. It is **not** done here. The venue registers a mandate at
 * `POST /v1/mandates` and repairs a missing registration at `POST /v1/mandates/:id/fund`,
 * `registerMandate` is one-shot and names the only address a release may ever pay, and a
 * second registration path — especially one deriving the key its own way — is exactly the
 * divergence that makes the vault's per-mandate custody worthless. An unregistered mandate
 * is refused with a sentence naming the route that fixes it, and `MANDATE_VAULT_ABI` below
 * does not carry `registerMandate` at all, so this package could not call it if it wanted
 * to.
 *
 * ## No amount is converted here
 *
 * The venue converts a mandate's committed capital into USDC minor units through
 * `toSettlementAmount` at a ppm scale, and publishes the result as `requiredUsdcMinor` on
 * every mandate row. **That figure is read from the wire, never recomputed.** A second copy
 * of that scale in this package is how one receivable comes to cost two different amounts,
 * and it is the defect this repo has already made in three separate places. If the venue
 * reports no vault, this refuses rather than deriving a requirement of its own.
 *
 * What *is* read from the chain is the balance, because a balance is not a conversion and
 * because `agent.ts` already holds the line that money is read from the chain rather than
 * remembered.
 */

import { ARC_TESTNET, CASH_CHAIN, err, explorerTxUrl, ok, type Result } from '@facture/shared';
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
} from 'viem';
import type { Logger } from './logger.js';
import type { VaultBacking } from './mandate.js';
import {
  arcAbsoluteFee,
  formatTokenAmount,
  USDC_DECIMALS,
  type AwaitTransactionOptions,
  type TransactionOutcome,
  type WalletClient,
} from './wallet.js';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The vault's key for a mandate
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * `uint256(keccak256(utf8(uuid)))` — the vault's custody key for one mandate.
 *
 * **This is the third copy of one line, and the duplication is deliberate rather than
 * careless.** The others are `vaultMandateId` in `packages/backend/src/services/arc.ts`
 * (the canonical one, which is what registers and what releases) and a local copy in
 * `scripts/demo-reset.mjs`. There is no shared helper to import: `@facture/shared` carries
 * no mandate-id derivation, this package does not depend on the backend, and the id is
 * never persisted or published — the API exposes the mandate's UUID and nothing else, so a
 * client that wants to talk to the vault directly has to derive it.
 *
 * What makes a third copy safe is not care, it is the test. `test/vault.test.ts` pins this
 * against the vector recorded in `docs/deployments.md` — mandate
 * `8b879d02-4593-4d66-82bf-52d4833401b6`, whose capital really is under
 * `15346442137576820289478969865486017349700696992123142042335952903215516347363` on the
 * deployed vault. A copy that drifted would deposit into a bucket nothing else can see, and
 * the money would be unreachable rather than merely misfiled.
 *
 * Note the encoding: `toHex(string)` is the UTF-8 bytes of the 36-character hyphenated
 * UUID, not the 16 raw bytes it encodes. Hashing the parsed bytes instead produces a
 * different, equally plausible number.
 */
export const vaultMandateId = (mandateUuid: string): bigint =>
  BigInt(keccak256(toHex(mandateUuid)));

/** `uint128`'s ceiling. The vault's `deposit` takes one, and an overflow is silent on the wire. */
export const MAX_UINT128 = (1n << 128n) - 1n;

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * ABIs
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * The vault, as this package needs it.
 *
 * **`registerMandate` is deliberately absent**, in the same spirit as the backend's own
 * vault ABI deliberately omitting `deposit`: the venue never deposits and the agent never
 * registers, and an ABI that carries a function nobody may call is an invitation. Nothing
 * that moves capital outward is here either — `executeRelease` and `executePayout` are the
 * attester's, and this wallet is not the attester.
 */
export const MANDATE_VAULT_ABI = parseAbi([
  'function balanceOf(uint256 mandateId) view returns (uint128)',
  'function buyerOf(uint256 mandateId) view returns (address)',
  'function settlementToken() view returns (address)',
  'function deposit(uint256 mandateId, uint128 amount) returns (bytes32)',
]);

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** Exactly what Circle's `abiFunctionSignature` wants. No spaces, no argument names. */
export const APPROVE_SIGNATURE = 'approve(address,uint256)';
export const DEPOSIT_SIGNATURE = 'deposit(uint256,uint128)';

/**
 * Gas limits for the two writes.
 *
 * Conventional, not measured — nothing has been broadcast from this package yet. Sized
 * generously on purpose, because a limit is a solvency requirement rather than a price: the
 * chain charges gas *used* and reserves gas *limit*, so padding costs headroom and nothing
 * else. On Arc that headroom is USDC out of the same wallet the deposit comes from, which
 * is why they are stated here rather than left at the module default.
 *
 * `deposit` is the larger of the two: two SSTOREs, a `transferFrom` into a token that
 * writes two balances, and an event with five fields.
 */
export const APPROVE_GAS_LIMIT = 100_000;
export const DEPOSIT_GAS_LIMIT = 250_000;

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Reading the vault
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * The chain reads this file needs.
 *
 * An interface rather than a viem client, so the decision below can be tested without a
 * network and so the one place that talks to Arc is named.
 */
export interface VaultReader {
  readonly vaultAddress: Address;
  readonly usdcAddress: Address;
  /** The zero address means the mandate has never been registered. */
  buyerOf(mandateId: bigint): Promise<Address>;
  /** Capital posted against the mandate, in USDC minor units. */
  depositedFor(mandateId: bigint): Promise<bigint>;
  allowance(owner: Address, spender: Address): Promise<bigint>;
  usdcBalanceOf(owner: Address): Promise<bigint>;
  /** The asset the vault actually escrows. Approving anything else is a deposit that reverts. */
  settlementToken(): Promise<Address>;
}

export interface ArcVaultReaderConfig {
  readonly vaultAddress: string;
  readonly rpcUrl?: string | undefined;
  readonly usdcAddress?: string | undefined;
}

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * Arc as viem wants it, built from `@facture/shared` rather than restated.
 *
 * `nativeCurrency` is USDC at 18 decimals and that is not a contradiction of the 6 used
 * everywhere else in this file: Arc's gas accounting is 18 decimals over the same balance
 * the ERC-20 interface reports at 6. The two never meet in one calculation — this one is
 * only ever used to price gas, and every amount below is the ERC-20 scale.
 */
export const arcChain = defineChain({
  id: ARC_TESTNET.chainId,
  name: ARC_TESTNET.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET.rpcUrl] } },
});

export function createArcVaultReader(config: ArcVaultReaderConfig): VaultReader {
  const vaultAddress = getAddress(config.vaultAddress);
  const usdcAddress = getAddress(config.usdcAddress ?? ARC_TESTNET.tokens.USDC.address);
  const client = createPublicClient({
    chain: arcChain,
    transport: http(config.rpcUrl ?? ARC_TESTNET.rpcUrl),
  });

  return {
    vaultAddress,
    usdcAddress,
    async buyerOf(mandateId) {
      return client.readContract({
        address: vaultAddress,
        abi: MANDATE_VAULT_ABI,
        functionName: 'buyerOf',
        args: [mandateId],
      });
    },
    async depositedFor(mandateId) {
      return client.readContract({
        address: vaultAddress,
        abi: MANDATE_VAULT_ABI,
        functionName: 'balanceOf',
        args: [mandateId],
      });
    },
    async allowance(owner, spender) {
      return client.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, spender],
      });
    },
    async usdcBalanceOf(owner) {
      return client.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      });
    },
    async settlementToken() {
      return client.readContract({
        address: vaultAddress,
        abi: MANDATE_VAULT_ABI,
        functionName: 'settlementToken',
      });
    },
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The decision
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * Why a deposit was not attempted.
 *
 * A vocabulary of its own, and deliberately not `@facture/shared`'s `RefusalCode`: none of
 * these is the venue declining to trade. They are this process declining to move its own
 * money, which is a different act with a different audience — an operator, not a seller.
 */
export type DepositRefusalCode =
  /** The venue runs no vault, or could not read it, so there is no requirement to meet. */
  | 'VENUE_REPORTED_NO_VAULT'
  /** Arc could not be read. Indeterminate, and an indeterminate answer must not move money. */
  | 'VAULT_UNREADABLE'
  /** `deposit` would revert `MandateNotRegistered`. The venue registers; this does not. */
  | 'MANDATE_NOT_REGISTERED'
  /** Registered to an address this wallet does not control. The capital would not come back. */
  | 'REGISTERED_TO_ANOTHER_ADDRESS'
  /** The vault escrows a different asset than the one about to be approved. */
  | 'SETTLEMENT_TOKEN_MISMATCH'
  /** The configured wallet is not in the configured wallet set. */
  | 'WALLET_SET_MISMATCH'
  /** The vault already holds what the venue asks for. Nothing to do. */
  | 'ALREADY_BACKED'
  /** The wallet does not hold the shortfall. */
  | 'INSUFFICIENT_WALLET_USDC'
  /** Zero, negative, or past `uint128`. */
  | 'AMOUNT_OUT_OF_RANGE';

export interface DepositRefusal {
  readonly code: DepositRefusalCode;
  /** The venue's mandate UUID, which is the id an operator holds. */
  readonly mandateId: string;
  /** One sentence, naming what would fix it where anything can. */
  readonly detail: string;
}

/** Everything the plan was built from, kept so a dry run prints the same figures a live one used. */
export interface DepositPlan {
  readonly mandateId: string;
  /** The vault's custody key. Printed because it is what an operator checks on the explorer. */
  readonly vaultMandateId: bigint;
  /** The registered buyer, confirmed equal to the depositing wallet's own address. */
  readonly buyer: Address;
  readonly walletAddress: Address;
  /** From the venue. Never recomputed here — see the file header. */
  readonly requiredUsdcMinor: bigint;
  /** From the chain, not from the venue's copy. */
  readonly depositedUsdcMinor: bigint;
  readonly shortfallUsdcMinor: bigint;
  /** What will actually be deposited: the shortfall, or an operator's override. */
  readonly amountUsdcMinor: bigint;
  readonly walletUsdcMinor: bigint;
  /** Zero when a standing allowance already covers the deposit and no `approve` is needed. */
  readonly approvalUsdcMinor: bigint;
}

export interface PlanDepositInput {
  readonly mandateId: string;
  /** The venue's own reading of this mandate's vault backing, off `GET /v1/mandates`. */
  readonly backing: VaultBacking | null;
  /** The wallet that will sign, and whose USDC will move. */
  readonly walletAddress: Address;
  readonly walletUsdcMinor: bigint;
  /** `buyerOf` as the vault answers it. */
  readonly registeredBuyer: Address;
  /** `balanceOf` as the vault answers it. */
  readonly depositedUsdcMinor: bigint;
  readonly standingAllowanceUsdcMinor: bigint;
  readonly settlementToken: Address;
  readonly usdcAddress: Address;
  /** Deposit this instead of the shortfall. USDC minor units. */
  readonly overrideAmountUsdcMinor?: bigint | undefined;
}

/**
 * Whether to deposit, and how much. Pure — every chain read is already an argument.
 *
 * The order of the checks is the order in which being wrong is expensive.
 * `REGISTERED_TO_ANOTHER_ADDRESS` comes before anything about amounts because that one is
 * not recoverable by trying again with a different number: `registerMandate` is one-shot,
 * `executeRelease` pays `buyerOf` and takes no recipient argument, and a deposit into a
 * mandate bound to an address nobody here holds a key for is capital with no way out.
 */
export function planDeposit(input: PlanDepositInput): Result<DepositPlan, DepositRefusal> {
  const refuse = (code: DepositRefusalCode, detail: string): Result<never, DepositRefusal> =>
    err({ code, mandateId: input.mandateId, detail });

  /*
   * `checked: false` is the venue saying it holds no vault to ask, which is not the same as
   * a mandate that is unbacked. Without a requirement from the venue there is no figure to
   * deposit against, and inventing one would mean carrying the venue's ppm scale here.
   */
  if (input.backing === null || !input.backing.checked) {
    return refuse(
      'VENUE_REPORTED_NO_VAULT',
      'The venue publishes no escrow figure for this mandate, so there is no requirement ' +
        'to fund. Both processes read the vault address from the same pin in ' +
        '`@facture/shared`, so this is the venue unable to read Arc rather than the two ' +
        'naming different deployments; this process will not derive a requirement of its own.',
    );
  }

  if (input.settlementToken.toLowerCase() !== input.usdcAddress.toLowerCase()) {
    return refuse(
      'SETTLEMENT_TOKEN_MISMATCH',
      `The vault escrows ${input.settlementToken} and this process is configured to approve ` +
        `${input.usdcAddress}. Approving the wrong asset is a deposit that reverts; the vault ` +
        'address is pinned in `@facture/shared`, so check `ARC_USDC_ADDRESS` against the ' +
        'deployment that pin names.',
    );
  }

  if (input.registeredBuyer === ZERO_ADDRESS) {
    return refuse(
      'MANDATE_NOT_REGISTERED',
      'The vault has no buyer bound to this mandate, so deposit would revert ' +
        'MandateNotRegistered. The venue registers a mandate at POST /v1/mandates and ' +
        'repairs a missing registration at POST /v1/mandates/:id/fund; this process ' +
        'deliberately does not, because registerMandate is one-shot and cannot be corrected.',
    );
  }

  if (input.registeredBuyer.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return refuse(
      'REGISTERED_TO_ANOTHER_ADDRESS',
      `This mandate is registered to ${input.registeredBuyer}, and this wallet is ` +
        `${input.walletAddress}. A deposit would still be credited — deposit pulls from ` +
        'msg.sender and asks nothing about who — but executeRelease pays buyerOf and takes ' +
        'no recipient argument, so the capital could only ever come back to the other ' +
        'address. Refusing rather than funding someone else’s bid.',
    );
  }

  const shortfall = input.backing.requiredUsdcMinor - input.depositedUsdcMinor;
  const amount = input.overrideAmountUsdcMinor ?? shortfall;

  if (input.overrideAmountUsdcMinor === undefined && shortfall <= 0n) {
    return refuse(
      'ALREADY_BACKED',
      `The vault holds ${usdc(input.depositedUsdcMinor)} USDC against a requirement of ` +
        `${usdc(input.backing.requiredUsdcMinor)}. Nothing to deposit.`,
    );
  }

  if (amount <= 0n || amount > MAX_UINT128) {
    return refuse(
      'AMOUNT_OUT_OF_RANGE',
      `${amount} is not a depositable amount: the vault takes a positive uint128.`,
    );
  }

  if (amount > input.walletUsdcMinor) {
    return refuse(
      'INSUFFICIENT_WALLET_USDC',
      `This wallet holds ${usdc(input.walletUsdcMinor)} USDC and the deposit needs ` +
        `${usdc(amount)}. Fund ${input.walletAddress} on Arc before running again.`,
    );
  }

  /*
   * `approve` SETS an allowance rather than adding to one, so a standing allowance at or
   * above the deposit needs no second call — and skipping it is worth doing, because it is
   * one fewer transaction that can leave the pair half-done.
   */
  const approvalUsdcMinor = input.standingAllowanceUsdcMinor >= amount ? 0n : amount;

  return ok({
    mandateId: input.mandateId,
    vaultMandateId: vaultMandateId(input.mandateId),
    buyer: input.registeredBuyer,
    walletAddress: input.walletAddress,
    requiredUsdcMinor: input.backing.requiredUsdcMinor,
    depositedUsdcMinor: input.depositedUsdcMinor,
    shortfallUsdcMinor: shortfall > 0n ? shortfall : 0n,
    amountUsdcMinor: amount,
    walletUsdcMinor: input.walletUsdcMinor,
    approvalUsdcMinor,
  });
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Doing it
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * What became of a deposit.
 *
 * **Three states, and `unknown` is the one that had to exist.** A Circle transaction that
 * times out is still live; reporting it as failed would tell an operator their capital is
 * in the wallet when it has already left, and the natural next action after "failed" is to
 * run it again.
 */
export type DepositState = 'deposited' | 'failed' | 'unknown';

export interface DepositReceipt {
  readonly state: DepositState;
  readonly plan: DepositPlan;
  /** Null when a standing allowance already covered the deposit. */
  readonly approve: TransactionOutcome | null;
  /** Null when the approve did not succeed, so no deposit was ever submitted. */
  readonly deposit: TransactionOutcome | null;
  /**
   * The vault's balance read again afterwards, or null when it could not be read.
   *
   * This is the fact that outranks the transaction state. A deposit whose Circle state is
   * `unknown` but whose vault balance moved is a deposit that happened, and saying so is
   * the difference between an operator resuming and an operator paying twice.
   */
  readonly depositedAfterUsdcMinor: bigint | null;
  /**
   * True when an `approve` **succeeded** and no deposit consumed it, so the vault holds a
   * spending allowance over this wallet's USDC. Not dangerous — the vault can only draw it
   * inside `deposit`, against this same mandate — but it is a standing grant and an operator
   * should know it is there.
   *
   * `false` after an approval whose own outcome was unknown, which is literally correct and
   * deliberately narrower than it looks: nothing succeeded, so nothing is known to stand.
   * The sentence in `detail` is what carries that uncertainty.
   */
  readonly allowanceLeftStanding: boolean;
  /**
   * Reuse this on a retry after `unknown`. Circle treats a repeated key as the same request
   * and returns the original response, so a resumed run cannot become a second deposit.
   */
  readonly idempotencyKey: string;
  readonly explorerUrl: string | null;
  readonly detail: string;
}

export interface ExecuteDepositDeps {
  readonly wallet: WalletClient;
  readonly walletId: string;
  readonly reader: VaultReader;
  readonly logger?: Logger | undefined;
  /**
   * One key covering both writes, suffixed per call. Pass the key from a previous run to
   * resume it rather than repeat it; generate a fresh one for a genuinely new deposit.
   */
  readonly idempotencyKey: string;
  readonly wait?: AwaitTransactionOptions | undefined;
}

/**
 * Approve, then deposit. **Two writes, so two failure points, and neither may be reported
 * as the other.**
 *
 * The order is forced: `deposit` pulls with `transferFrom`, so the allowance has to exist
 * first. That means the cheap, reversible write happens before the one that moves money,
 * which is the right way round — an approve that fails costs gas and nothing else, while a
 * deposit that fails after a successful approve leaves an allowance standing and the
 * capital where it was.
 *
 * An `unknown` approve stops the sequence rather than pressing on. Submitting a deposit
 * against an allowance nobody can confirm is how you get a revert that looks like a vault
 * problem, and there is nothing to gain by guessing: no capital has moved at that point.
 */
export async function executeDeposit(
  plan: DepositPlan,
  deps: ExecuteDepositDeps,
): Promise<DepositReceipt> {
  const { wallet, walletId, reader, logger } = deps;
  const vault = reader.vaultAddress;
  const base = {
    plan,
    idempotencyKey: deps.idempotencyKey,
    allowanceLeftStanding: false,
  } as const;

  let approve: TransactionOutcome | null = null;

  if (plan.approvalUsdcMinor > 0n) {
    logger?.info('approving the vault to pull the deposit', {
      mandateId: plan.mandateId,
      spender: vault,
      amountUsdcMinor: plan.approvalUsdcMinor,
      amountUsdc: usdc(plan.approvalUsdcMinor),
    });
    const submitted = await wallet.executeContract({
      walletId,
      contractAddress: reader.usdcAddress,
      abiFunctionSignature: APPROVE_SIGNATURE,
      /*
       * Exactly the deposit, not an unbounded allowance. A successful deposit consumes it
       * to zero, so the wallet is not left with a standing grant it forgot it made.
       */
      abiParameters: [vault, plan.approvalUsdcMinor.toString(10)],
      refId: plan.mandateId,
      idempotencyKey: `${deps.idempotencyKey}-approve`,
      fee: arcAbsoluteFee(APPROVE_GAS_LIMIT),
    });
    approve = await wallet.awaitTransaction(submitted.id, deps.wait);

    if (approve.result === 'failed') {
      return {
        ...base,
        state: 'failed',
        approve,
        deposit: null,
        depositedAfterUsdcMinor: null,
        explorerUrl: txUrl(approve),
        detail:
          `The approval failed (${approve.state}${approve.errorReason === null ? '' : `: ${approve.errorReason}`}). ` +
          'No capital moved and no allowance stands.',
      };
    }
    if (approve.result === 'unknown') {
      return {
        ...base,
        state: 'unknown',
        approve,
        deposit: null,
        depositedAfterUsdcMinor: null,
        explorerUrl: txUrl(approve),
        detail:
          `The approval is ${approve.state} and was not waited out, so it is unknown whether ` +
          'an allowance now stands. No capital has moved either way — no deposit was ' +
          'submitted. Re-run with the same idempotency key once the approval settles.',
      };
    }
  }

  logger?.info('depositing into the mandate vault', {
    mandateId: plan.mandateId,
    vaultMandateId: plan.vaultMandateId.toString(10),
    vault,
    amountUsdcMinor: plan.amountUsdcMinor,
    amountUsdc: usdc(plan.amountUsdcMinor),
  });

  const submitted = await wallet.executeContract({
    walletId,
    contractAddress: vault,
    abiFunctionSignature: DEPOSIT_SIGNATURE,
    abiParameters: [plan.vaultMandateId.toString(10), plan.amountUsdcMinor.toString(10)],
    refId: plan.mandateId,
    idempotencyKey: `${deps.idempotencyKey}-deposit`,
    fee: arcAbsoluteFee(DEPOSIT_GAS_LIMIT),
  });
  const deposit = await wallet.awaitTransaction(submitted.id, deps.wait);

  /*
   * Read the balance again whatever the transaction state says. This is the only statement
   * here that is about the money rather than about a request: a vault that gained the
   * amount gained it, and a Circle poll that ran out of budget cannot unmake that.
   */
  let after: bigint | null = null;
  try {
    after = await reader.depositedFor(plan.vaultMandateId);
  } catch (cause) {
    logger?.warn('could not re-read the vault after depositing', {
      mandateId: plan.mandateId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const landed = after !== null && after >= plan.depositedUsdcMinor + plan.amountUsdcMinor;
  const held =
    after === null
      ? ''
      : ` The vault holds ${usdc(after)} against a requirement of ${usdc(plan.requiredUsdcMinor)}.`;

  if (deposit.result === 'succeeded') {
    return {
      ...base,
      state: 'deposited',
      approve,
      deposit,
      depositedAfterUsdcMinor: after,
      explorerUrl: txUrl(deposit),
      detail: `Deposited ${usdc(plan.amountUsdcMinor)} USDC into mandate ${plan.mandateId}.${held}`,
    };
  }

  /*
   * A terminal refusal from Circle outranks the balance. If the vault gained money anyway it
   * was somebody else's deposit or a reclaimed payout landing in the same block, and calling
   * that this deposit would credit this run with capital it did not post.
   */
  if (deposit.result === 'failed') {
    return {
      ...base,
      state: 'failed',
      approve,
      deposit,
      depositedAfterUsdcMinor: after,
      allowanceLeftStanding: approve !== null,
      explorerUrl: txUrl(deposit),
      detail:
        `The deposit failed (${deposit.state}${deposit.errorReason === null ? '' : `: ${deposit.errorReason}`}) ` +
        'and this wallet posted nothing.' +
        (approve === null
          ? ''
          : ` The approval before it succeeded, so ${usdc(plan.approvalUsdcMinor)} USDC of ` +
            'allowance stands to the vault; it can only ever be drawn by a deposit against ' +
            'this same mandate, but it is there.') +
        (landed
          ? ' The vault balance moved anyway, which this run did not do — check who else ' +
            `deposited before funding again.${held}`
          : ''),
    };
  }

  /*
   * Circle has not answered, but the vault has. A balance that gained exactly this deposit is
   * the deposit, and reporting it as anything else invites an operator to post the money a
   * second time.
   */
  if (landed) {
    return {
      ...base,
      state: 'deposited',
      approve,
      deposit,
      depositedAfterUsdcMinor: after,
      explorerUrl: txUrl(deposit),
      detail:
        `Deposited ${usdc(plan.amountUsdcMinor)} USDC into mandate ${plan.mandateId}.${held} ` +
        `Circle still reports the transaction as ${deposit.state}, but the vault balance moved, ` +
        'which is the fact that decides it.',
    };
  }

  return {
    ...base,
    state: 'unknown',
    approve,
    deposit,
    depositedAfterUsdcMinor: after,
    allowanceLeftStanding: approve !== null,
    explorerUrl: txUrl(deposit),
    detail:
      `The deposit is ${deposit.state} and the vault balance has not moved yet` +
      (after === null ? ' (and could not be re-read)' : ` (still ${usdc(after)} USDC)`) +
      '. This is NOT a failure: the transaction may still settle, and the capital may ' +
      'already have left this wallet. Check the vault before doing anything else, and if a ' +
      'retry is needed, re-run with idempotency key ' +
      `${deps.idempotencyKey} so Circle replays the request rather than making a second one.`,
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ───────────────────────────────────────────────────────────────────────────────────── */

const usdc = (minor: bigint): string => formatTokenAmount(minor, USDC_DECIMALS);

const txUrl = (outcome: TransactionOutcome): string | null =>
  outcome.txHash === null ? null : explorerTxUrl(CASH_CHAIN, outcome.txHash);
