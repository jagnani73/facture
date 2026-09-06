/**
 * A thin typed wrapper over Circle's Developer-Controlled Wallets client.
 *
 * Transport only. There is no product logic in this file and none may be added: it creates
 * wallet sets and wallets, reads balances, transfers USDC, executes a contract call and
 * reads back what became of one. What a mandate is allowed to spend is decided in
 * `mandate.ts`, and whether capital may be posted into the vault in `vault.ts`, before
 * anything here is called.
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
 *
 * A limit is a solvency requirement, not a price: the chain charges gas *used* and reserves
 * gas *limit*. So padding it costs nothing but headroom — which on Arc is USDC, the same
 * balance the deposit itself comes out of. `vault.ts` passes its own limits for that reason
 * rather than taking this default.
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

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Waiting for a transaction to actually happen
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * What became of a submitted transaction. **Three outcomes, and the third is the point.**
 *
 * `createTransaction` and `createContractExecutionTransaction` resolve as soon as Circle has
 * *accepted* the request; the state they return is `INITIATED`. This repo has shipped the
 * "a write is not a receipt" bug twice already — a `deployBond` selector and a uniqueness
 * claim both reported a revert as a success — so nothing here may treat a submission as an
 * outcome.
 *
 * `unknown` is not a failure and must never be rendered as one. Circle is still working, or
 * the poll ran out of budget, or the transaction is `STUCK` and may yet be mined. Reporting
 * that as failed would tell an operator their money is where it is not — and on this path
 * the money is the agent's own capital, already gone from the wallet.
 */
export type TransactionResult = 'succeeded' | 'failed' | 'unknown';

/** Circle's states that mean the transaction is on chain and did what it said. */
const SUCCEEDED_STATES: readonly string[] = ['CONFIRMED', 'COMPLETE'];

/**
 * Circle's states that mean it will never be on chain.
 *
 * **`STUCK` is deliberately absent.** It is a transaction Circle has broadcast and cannot
 * get mined at the fee it bid, and it can still confirm — or be accelerated. Calling it
 * failed is exactly the false negative this type exists to prevent.
 */
const FAILED_STATES: readonly string[] = ['FAILED', 'DENIED', 'CANCELLED'];

/** States worth stopping the poll for even though they are not an answer. */
const STOP_WAITING_STATES: readonly string[] = ['STUCK'];

export const classifyTransactionState = (state: string): TransactionResult =>
  SUCCEEDED_STATES.includes(state)
    ? 'succeeded'
    : FAILED_STATES.includes(state)
      ? 'failed'
      : 'unknown';

export interface TransactionOutcome {
  readonly id: string;
  /** Circle's last observed state. Kept raw beside `result`, so a new state is still visible. */
  readonly state: string;
  readonly result: TransactionResult;
  /** Present once broadcast. The coordinate an operator checks on the explorer. */
  readonly txHash: string | null;
  readonly errorReason: string | null;
  readonly errorDetails: string | null;
  /** True when the poll gave up rather than reaching an answer. Always `unknown` if so. */
  readonly timedOut: boolean;
}

export interface AwaitTransactionOptions {
  /** Total budget. When it runs out the answer is `unknown`, never `failed`. */
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** Injectable delay, so a test does not wait in real time. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
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
  /** One read of a submitted transaction. No waiting; the state may be non-terminal. */
  transaction(transactionId: string): Promise<TransactionOutcome>;
  /**
   * Poll until the transaction succeeds, fails, or the budget runs out.
   *
   * The budget running out returns `unknown`, and a caller that renders that as a failure
   * has reintroduced the bug this exists to close.
   */
  awaitTransaction(
    transactionId: string,
    options?: AwaitTransactionOptions,
  ): Promise<TransactionOutcome>;
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

  /*
   * A closure rather than a method, so `awaitTransaction` calls it without `this` — the
   * client is routinely destructured into a fake's shape in tests, and a method that
   * depended on its receiver would break the moment it was.
   */
  const readTransaction = async (transactionId: string): Promise<TransactionOutcome> => {
    const response = await client.getTransaction({ id: transactionId });
    const tx = response.data?.transaction;
    /*
     * The SDK's own type marks `data` optional because *"the API may return an empty
     * body"*. An empty body is not "the transaction failed" — it is no answer at all, and
     * the honest reading of no answer is `unknown`.
     */
    if (tx === undefined) {
      return {
        id: transactionId,
        state: 'UNREPORTED',
        result: 'unknown',
        txHash: null,
        errorReason: null,
        errorDetails: 'Circle returned no transaction record',
        timedOut: false,
      };
    }
    return {
      id: tx.id,
      state: tx.state,
      result: classifyTransactionState(tx.state),
      txHash: tx.txHash ?? null,
      errorReason: tx.errorReason ?? null,
      errorDetails: tx.errorDetails ?? null,
      timedOut: false,
    };
  };

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

    transaction: readTransaction,

    awaitTransaction(transactionId, options) {
      return pollTransaction(readTransaction, transactionId, { ...options, logger: log });
    },
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The waiting itself, over any single-read function.
 *
 * Polled here rather than through the SDK's `waitForState`, which **rejects** on a terminal
 * failure. A thrown error cannot distinguish "the transaction reverted" from "the poll was
 * aborted", and those are the two cases the three-way {@link TransactionResult} exists to
 * keep apart — collapsing them is how a live deposit gets reported as money still in the
 * wallet.
 *
 * Separated from the client so it can be exercised without a network, because every rule in
 * it is about a case the happy path never reaches.
 */
export async function pollTransaction(
  read: (transactionId: string) => Promise<TransactionOutcome>,
  transactionId: string,
  options?: (AwaitTransactionOptions & { readonly logger?: Logger | undefined }) | undefined,
): Promise<TransactionOutcome> {
  const budgetMs = options?.timeoutMs ?? 120_000;
  const intervalMs = options?.pollIntervalMs ?? 2_000;
  const sleep = options?.sleep ?? defaultSleep;
  const deadline = Date.now() + budgetMs;

  let last: TransactionOutcome = {
    id: transactionId,
    state: 'UNREPORTED',
    result: 'unknown',
    txHash: null,
    errorReason: null,
    errorDetails: null,
    timedOut: false,
  };

  for (;;) {
    try {
      last = await read(transactionId);
      if (last.result !== 'unknown') return last;
      // `STUCK` is not an answer, but it is not going to become one by asking again.
      if (STOP_WAITING_STATES.includes(last.state)) return last;
    } catch (cause) {
      /*
       * A read that fails says nothing about the transaction. Keep the last thing we did
       * know and try again until the budget is gone — the alternative is turning a
       * transient network fault into a report that the agent's capital did not move.
       */
      options?.logger?.debug('could not read transaction state', {
        transactionId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (Date.now() >= deadline) return { ...last, timedOut: true };
    await sleep(intervalMs);
  }
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
