/**
 * A thin typed wrapper over Circle's Developer-Controlled Wallets client.
 *
 * Transport only. There is no product logic in this file and none may be added: it creates
 * wallet sets and wallets, reads balances, transfers USDC and executes a contract call.
 * What a mandate is allowed to spend is decided in `mandate.ts`, before anything here is
 * called.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CIRCLE ENFORCES NO SPENDING LIMIT ON THIS PATH
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Every function below that moves money will move it. There is no cap, no allowlist and no
 * approval step behind any of them, and nothing in this file should be read as implying
 * otherwise.
 *
 * - Circle's docs on developer-controlled wallets: *"Dev-controlled wallets do not include
 *   a built-in policy engine. If you require transaction restrictions, destination
 *   allowlists, or multi-party approval flows, enforce those controls in your own
 *   application logic before calling Circle APIs."*
 * - Circle's spending policies are an Agent Wallets feature and require mainnet:
 *   *"Spending policies require a mainnet agent wallet. Testnet is not supported."*
 * - Arc appears in Circle's Agent Wallets support matrix as testnet-only, with no mainnet
 *   identifier at all. So the mainnet-only feature is not reachable from this chain even in
 *   principle.
 *
 * The mandate cap is therefore ours, enforced in `mandate.ts` and applied in `agent.ts`
 * before any call reaches this module. Circle's policy schema could not express a mandate
 * in any case — it offers flat per-transaction, daily, weekly and monthly ceilings plus
 * allow/blocklists, where a mandate is a rating×tenor bucket with a per-debtor sub-limit.
 *
 * ## Decimals
 *
 * Circle's API speaks **decimal token amounts as strings** (`"5"`, `"39178.08"`). This
 * package speaks `bigint` minor units. The conversion happens here, at the boundary, and
 * nowhere else — see {@link parseTokenAmount} and {@link formatTokenAmount}.
 *
 * USDC on Arc has **6 decimals on the ERC-20 interface**, which is what every balance and
 * transfer uses. Arc's *native gas accounting* is 18 decimals over the same underlying
 * balance. Mixing the two is a 10^12 error — large enough to look like a different asset
 * rather than a rounding bug — so the 18-decimal scale never appears in this file.
 */

import { ARC_TESTNET } from '@facture/shared';
import {
  initiateDeveloperControlledWalletsClient,
  type Balance,
  type CircleDeveloperControlledWalletsClient,
  type FeeConfiguration,
  type FeeLevel,
  type TokenBlockchain,
  type WalletsDataWalletsInner,
} from '@circle-fin/developer-controlled-wallets';
import type { Logger } from './logger.js';

/**
 * Circle's identifier for the chain the cash leg settles on.
 *
 * Typed as `TokenBlockchain` rather than `Blockchain`. The SDK narrows the chain argument on
 * the token-transfer call to the chains that carry tokens, and `TokenBlockchain` is
 * assignable everywhere `Blockchain` is wanted — so the narrower type is the one that works
 * on every call site rather than most of them.
 */
export const ARC_TESTNET_BLOCKCHAIN: TokenBlockchain = 'ARC-TESTNET';

/** Decimals on the USDC ERC-20 interface. Not the 18 Arc uses for native gas accounting. */
export const USDC_DECIMALS = ARC_TESTNET.tokens.USDC.decimals;

export interface WalletClientConfig {
  readonly apiKey: string;
  readonly entitySecret: string;
  /** Override Circle's default base URL. Present for tests and for a sandbox host. */
  readonly baseUrl?: string | undefined;
  readonly blockchain?: TokenBlockchain | undefined;
  /** USDC ERC-20 address on `blockchain`. Defaults to Arc testnet's from `@facture/shared`. */
  readonly usdcAddress?: string | undefined;
  readonly logger?: Logger | undefined;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Decimal ↔ minor units
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * `"5.25", 6` → `5_250_000n`.
 *
 * Strict. Excess precision throws rather than truncating, because on this path excess
 * precision means the caller and the token disagree about the scale — the 18-vs-6 trap —
 * and silently dropping digits would turn a scale error into a plausible-looking amount.
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `parseTokenAmount: decimals must be a non-negative integer, got ${decimals}`,
    );
  }
  const cleaned = input.trim();
  // At least one digit after a decimal point: a bare trailing `5.` is malformed rather
  // than a precise five, and exponent notation is rejected outright.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (match === null) {
    throw new RangeError(`parseTokenAmount: not a decimal amount: ${input}`);
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new RangeError(
      `parseTokenAmount: ${input} carries more than ${decimals} decimal places. ` +
        'That usually means a decimals mismatch rather than a precise amount.',
    );
  }
  const scaled = BigInt(whole + fraction.padEnd(decimals, '0'));
  return sign === '-' ? -scaled : scaled;
}

/**
 * `5_250_000n, 6` → `"5.25"`. The only place a minor-unit amount becomes a Circle amount.
 *
 * Trailing zeros are trimmed and a whole amount renders without a point, which is what
 * Circle's examples show. No grouping separators — this is a wire value, not a display
 * string.
 */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`formatTokenAmount: decimals must be a non-negative integer`);
  }
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString(10).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Fees
 * ───────────────────────────────────────────────────────────────────────────────────── */

/** Arc's `maxFeePerGas` floor in gwei, derived from `@facture/shared` rather than restated. */
export const ARC_MIN_MAX_FEE_GWEI = Number(ARC_TESTNET.minMaxFeePerGasWei / 1_000_000_000n);

/**
 * An absolute fee at Arc's floor.
 *
 * Absolute rather than `feeLevel`, deliberately. Arc rejects anything under 20 gwei
 * outright as `transaction underpriced`, and a dynamic fee level is calculated from network
 * conditions with no knowledge of that floor — on a quiet testnet it would happily bid
 * below it and every transaction would fail. Pinning the floor is the only setting that
 * cannot silently produce an unbroadcastable transaction.
 *
 * **Not exercised.** No transaction has been broadcast from this package, so the gas limit
 * below is a conventional ERC-20 transfer allowance rather than a measured one. Estimate it
 * against Circle's fee endpoint before the first real spend.
 */
export function arcAbsoluteFee(
  gasLimit = 120_000,
  priorityFeeGwei = 1,
): FeeConfiguration<FeeLevel> {
  return {
    type: 'absolute',
    config: {
      maxFee: String(ARC_MIN_MAX_FEE_GWEI),
      priorityFee: String(priorityFeeGwei),
      gasLimit: String(gasLimit),
    },
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Types this module returns
 * ───────────────────────────────────────────────────────────────────────────────────── */

export interface WalletSetSummary {
  readonly id: string;
  readonly name: string | undefined;
  readonly createDate: string | undefined;
}

export interface WalletSummary {
  readonly id: string;
  readonly address: string;
  readonly blockchain: string;
  readonly walletSetId: string;
  readonly state: string | undefined;
  readonly accountType: string | undefined;
}

/** A token balance with the raw Circle string kept alongside the parsed minor units. */
export interface TokenBalance {
  readonly tokenId: string;
  readonly symbol: string | undefined;
  readonly tokenAddress: string | undefined;
  readonly decimals: number;
  /** Minor units at `decimals`. The only representation arithmetic may use. */
  readonly amount: bigint;
  /** Exactly what Circle returned, for the proof view and for debugging a scale mismatch. */
  readonly raw: string;
  readonly updatedAt: string;
}

export interface SubmittedTransaction {
  readonly id: string;
  readonly state: string;
}

export interface TransferInput {
  readonly walletId: string;
  readonly destinationAddress: string;
  /** Minor units at {@link USDC_DECIMALS}. Never a decimal string, never a `number`. */
  readonly amount: bigint;
  /** Client reference carried through to Circle's console. Use the trade or invoice id. */
  readonly refId?: string | undefined;
  /**
   * Idempotency key. **Pass one for every spend.** A retried transfer without a key is a
   * second transfer, and the failure mode is paying a seller twice for one invoice.
   */
  readonly idempotencyKey?: string | undefined;
  readonly fee?: FeeConfiguration<FeeLevel> | undefined;
}

export interface ContractCallInput {
  readonly walletId: string;
  readonly contractAddress: string;
  /** e.g. `transfer(address,uint256)`. */
  readonly abiFunctionSignature: string;
  readonly abiParameters: readonly unknown[];
  /** Native value to attach, in minor units at the chain's native scale. Usually absent. */
  readonly amount?: bigint | undefined;
  readonly nativeDecimals?: number | undefined;
  readonly refId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly fee?: FeeConfiguration<FeeLevel> | undefined;
}

/**
 * The surface `agent.ts` depends on.
 *
 * An interface rather than the concrete client so a test can substitute a fake without
 * reaching Circle, and so the agent's dependency is a handful of named operations rather
 * than the whole SDK.
 */
export interface WalletClient {
  readonly blockchain: TokenBlockchain;
  readonly usdcAddress: string;
  createWalletSet(name: string, idempotencyKey?: string): Promise<WalletSetSummary>;
  listWalletSets(): Promise<readonly WalletSetSummary[]>;
  createWallets(input: {
    readonly walletSetId: string;
    readonly count: number;
    readonly idempotencyKey?: string | undefined;
  }): Promise<readonly WalletSummary[]>;
  listWallets(filter?: {
    readonly walletSetId?: string | undefined;
    readonly address?: string | undefined;
  }): Promise<readonly WalletSummary[]>;
  getWallet(walletId: string): Promise<WalletSummary>;
  /** Every token balance on the wallet, parsed to minor units. */
  tokenBalances(walletId: string): Promise<readonly TokenBalance[]>;
  /**
   * USDC only, or `null` when the wallet holds none.
   *
   * `null` rather than zero is the honest answer: Circle omits a token the wallet has never
   * held, and "no balance record" and "a balance of zero" are the same amount but not the
   * same fact when the question is whether a mandate is funded.
   */
  usdcBalance(walletId: string): Promise<TokenBalance | null>;
  transferUsdc(input: TransferInput): Promise<SubmittedTransaction>;
  executeContract(input: ContractCallInput): Promise<SubmittedTransaction>;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The wrapper
 * ───────────────────────────────────────────────────────────────────────────────────── */

export function createWalletClient(config: WalletClientConfig): WalletClient {
  if (config.apiKey.length === 0) throw new Error('CIRCLE_API_KEY is empty');
  if (config.entitySecret.length === 0) throw new Error('CIRCLE_ENTITY_SECRET is empty');

  const blockchain: TokenBlockchain = config.blockchain ?? ARC_TESTNET_BLOCKCHAIN;
  const usdcAddress = config.usdcAddress ?? ARC_TESTNET.tokens.USDC.address;
  const log = config.logger;

  const client: CircleDeveloperControlledWalletsClient = initiateDeveloperControlledWalletsClient({
    apiKey: config.apiKey,
    entitySecret: config.entitySecret,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  });

  return {
    blockchain,
    usdcAddress,

    async createWalletSet(name, idempotencyKey) {
      const response = await client.createWalletSet({
        name,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      const set = response.data?.walletSet;
      if (set === undefined) throw new Error('Circle returned no wallet set');
      const name_ = nameOf(set);
      log?.info('wallet set created', { walletSetId: set.id, walletSetName: name_ });
      return { id: set.id, name: name_, createDate: set.createDate };
    },

    async listWalletSets() {
      const response = await client.listWalletSets();
      return (response.data?.walletSets ?? []).map((set) => ({
        id: set.id,
        name: nameOf(set),
        createDate: set.createDate,
      }));
    },

    /**
     * Creating a wallet is not free and not reversible — a wallet set accumulates them and
     * there is no delete. Callers should list first and create only what is missing.
     */
    async createWallets(input) {
      const response = await client.createWallets({
        walletSetId: input.walletSetId,
        blockchains: [blockchain],
        count: input.count,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      const wallets = (response.data?.wallets ?? []).map(toWalletSummary);
      log?.info('wallets created', {
        walletSetId: input.walletSetId,
        count: wallets.length,
        walletIds: wallets.map((w) => w.id),
      });
      return wallets;
    },

    async listWallets(filter) {
      const response = await client.listWallets({
        blockchain,
        ...(filter?.walletSetId === undefined ? {} : { walletSetId: filter.walletSetId }),
        ...(filter?.address === undefined ? {} : { address: filter.address }),
      });
      return (response.data?.wallets ?? []).map(toWalletSummary);
    },

    async getWallet(walletId) {
      const response = await client.getWallet({ id: walletId });
      const wallet = response.data?.wallet;
      if (wallet === undefined) throw new Error(`Circle returned no wallet for ${walletId}`);
      return toWalletSummary(wallet);
    },

    async tokenBalances(walletId) {
      const response = await client.getWalletTokenBalance({ id: walletId });
      return (response.data?.tokenBalances ?? []).map(toTokenBalance);
    },

    async usdcBalance(walletId) {
      const response = await client.getWalletTokenBalance({
        id: walletId,
        tokenAddresses: [usdcAddress],
      });
      return selectUsdcBalance(response.data?.tokenBalances ?? [], usdcAddress);
    },

    /**
     * Move USDC. **This spends.** The caller must already have passed `mandate.ts`'s
     * pre-flight; nothing here re-checks a cap, because there is no cap here to check.
     */
    async transferUsdc(input) {
      if (input.amount <= 0n) {
        throw new RangeError(`transferUsdc: amount must be positive, got ${input.amount}`);
      }
      const amounts = [formatTokenAmount(input.amount, USDC_DECIMALS)];
      log?.info('submitting USDC transfer', {
        walletId: input.walletId,
        destinationAddress: input.destinationAddress,
        amount: input.amount,
        amountDecimal: amounts[0],
        refId: input.refId,
      });
      /*
       * `amount`, plural array — the SDK's own input field is singular and it renames it to
       * `amounts` on the wire. And no `blockchain` alongside `walletId`: the SDK's input
       * type makes the two mutually exclusive, because the wallet already determines the
       * chain and a second answer could only contradict the first.
       */
      const response = await client.createTransaction({
        walletId: input.walletId,
        destinationAddress: input.destinationAddress,
        tokenAddress: usdcAddress,
        amount: amounts,
        fee: input.fee ?? arcAbsoluteFee(),
        ...(input.refId === undefined ? {} : { refId: input.refId }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      return toSubmitted(response.data, 'transfer');
    },

    /** Execute a contract call from the wallet. **This spends gas and may spend tokens.** */
    async executeContract(input) {
      const response = await client.createContractExecutionTransaction({
        walletId: input.walletId,
        contractAddress: input.contractAddress,
        abiFunctionSignature: input.abiFunctionSignature,
        abiParameters: [...input.abiParameters],
        fee: input.fee ?? arcAbsoluteFee(),
        ...(input.amount === undefined
          ? {}
          : { amount: formatTokenAmount(input.amount, input.nativeDecimals ?? USDC_DECIMALS) }),
        ...(input.refId === undefined ? {} : { refId: input.refId }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      return toSubmitted(response.data, 'contract execution');
    },
  };
}

/**
 * Pick the ERC-20 USDC balance out of what Circle returns for an Arc wallet.
 *
 * **Circle returns the same balance twice, at two scales.** Observed against the live API
 * for an Arc-testnet wallet holding 5 USDC:
 *
 * ```
 *   USDC  raw="5"  decimals=18  tokenAddress=<none>   ← native gas accounting
 *   USDC  raw="5"  decimals=6   tokenAddress=0x3600…  ← the ERC-20 interface
 * ```
 *
 * Same money, same symbol, two representations — and picking the wrong one is a 10^12
 * error in every balance comparison downstream. This is the 18-vs-6 trap the repo's
 * CLAUDE.md warns about, present in the API response rather than only in theory.
 *
 * Selection is by **contract address**, never by symbol and never by "the first USDC". The
 * native entry has no token address at all, so matching on the address excludes it
 * structurally; and a symbol is a label anyone can mint, so a wallet could hold two tokens
 * both calling themselves USDC with only the address to tell them apart.
 *
 * Exported so the selection is testable against exactly the pair the live API returned.
 */
export function selectUsdcBalance(
  balances: readonly Balance[],
  usdcAddress: string,
): TokenBalance | null {
  const wanted = usdcAddress.toLowerCase();
  const match = balances.find((b) => b.token.tokenAddress?.toLowerCase() === wanted);
  return match === undefined ? null : toTokenBalance(match);
}

/**
 * A wallet set's name, read defensively.
 *
 * Circle's API returns `name` on a wallet set; the shipped SDK's `WalletSet` type does not
 * declare it. Reading it through a guard rather than a cast keeps the value without
 * asserting a shape the package does not promise — if a future SDK adds the field properly,
 * nothing here has to change.
 */
function nameOf(set: object): string | undefined {
  const value = (set as { name?: unknown }).name;
  return typeof value === 'string' ? value : undefined;
}

function toWalletSummary(wallet: WalletsDataWalletsInner): WalletSummary {
  return {
    id: wallet.id,
    address: wallet.address,
    blockchain: wallet.blockchain,
    walletSetId: wallet.walletSetId,
    state: wallet.state,
    accountType: wallet.accountType,
  };
}

function toTokenBalance(balance: Balance): TokenBalance {
  /*
   * Circle marks `decimals` optional on the token. Falling back to USDC's 6 would be a
   * guess about a scale, and a wrong guess is a 10^n error in an amount — exactly the trap
   * this module exists to close. Fail loudly instead.
   */
  const decimals = balance.token.decimals;
  if (decimals === undefined) {
    throw new Error(
      `Circle returned no decimals for token ${balance.token.id} ` +
        `(${balance.token.symbol ?? 'unknown symbol'}); refusing to guess a scale`,
    );
  }
  return {
    tokenId: balance.token.id,
    symbol: balance.token.symbol,
    tokenAddress: balance.token.tokenAddress,
    decimals,
    amount: parseTokenAmount(balance.amount, decimals),
    raw: balance.amount,
    updatedAt: balance.updateDate,
  };
}

function toSubmitted(
  data: { readonly id: string; readonly state: string } | undefined,
  what: string,
): SubmittedTransaction {
  if (data === undefined) throw new Error(`Circle returned no ${what} transaction`);
  return { id: data.id, state: data.state };
}
