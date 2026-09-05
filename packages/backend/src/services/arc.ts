/**
 * The cash leg's escrow, on Arc.
 *
 * `POST /v1/mandates/:id/fund` takes an `escrowRef` and credits whatever amount the request
 * asked for. Its own comment says what it wants to be — *"the escrow record is the authority
 * on how much landed, never the request body"* — and then says there is no escrow provider
 * wired, so the reference is recorded and believed. This is that provider.
 *
 * `MandateVault` on Arc holds the USDC. `balanceOf(mandateId)` is a **view**, so verifying a
 * mandate's capital costs no key, no gas and no signature — the venue can simply ask the
 * chain how much is actually there and refuse to count more than that. A funding request can
 * then be wrong without being believed, which is the same class of fix as taking a seller's
 * email from a signed token rather than from a request body.
 *
 * ## The mandate id is derived, and this is the load-bearing detail
 *
 * The vault keys capital by `uint256 mandateId`. `MandateBook` mints those sequentially, and
 * **the venue's mandates have never been posted to MandateBook** — they are UUIDs in a
 * database. So the id used here is derived from the UUID rather than taken from the book.
 *
 * That is sound because to the vault a mandate id is only a key: it needs to be unique and
 * stable, not meaningful. It is `uint256(keccak256(uuid))`, which is both. But it does mean
 * **the vault's id space and MandateBook's id space are different**, and anything that later
 * posts these mandates to the book must reconcile them rather than assume they match. Two
 * systems silently disagreeing about which mandate is which is exactly how capital ends up
 * credited to the wrong one.
 *
 * ## The vault answers in USDC, and a mandate is written in dollars
 *
 * `balanceOf` returns USDC ERC-20 minor units — 6 decimals. A mandate's `fundedMinor` is
 * minor units of its own currency — 2 decimals for USD and EUR. **These were compared
 * directly**, so a mandate counted as holding $50,000.00 (5,000,000 cents) was read as
 * backed by 5,000,000 USDC minor units, which is 5 USDC. Identical digits, four orders of
 * magnitude apart, and the check passed.
 *
 * {@link ArcEscrow.requiredFor} is the boundary now: callers hand it money in an invoice
 * currency and get back what the vault would have to hold. The conversion itself is
 * {@link toSettlementAmount}, the same one the Hedera cash leg settles through, so a
 * mandate is backed on Arc by exactly the amount a trade would cost on either rail.
 *
 * ## Capital arrives on its own and leaves only on the venue's word
 *
 * **It does not deposit.** `deposit` pulls USDC from `msg.sender`, so funding is the buyer's
 * own transaction from the buyer's own wallet — the venue holds the attester key, not the
 * buyer's. What the venue does before that is `registerMandate`, which names the one address a
 * release may ever be paid to, and **without which a deposit reverts `MandateNotRegistered`.**
 * That is why {@link ensureMandateRegistered} runs when a mandate is written rather than being
 * left to a provisioning script: a mandate nobody registered is a mandate nobody can fund.
 *
 * **It does move money out**, on the vault's two authorised paths and no others.
 * `executePayout` pays a settled trade's seller into the escrow, and `executeRelease` returns
 * a buyer's unallocated capital to that buyer. Both are attester-only, and neither takes a
 * recipient: the vault reads the binding it already holds, so a forged authorisation can only
 * ever return a buyer's own money to that buyer.
 */

import { randomUUID } from 'node:crypto';
import type { Currency } from '@facture/shared';
import { ARC_TESTNET, CURRENCY_DECIMALS } from '@facture/shared';
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcChain } from '../chain.js';
import { badRequest, upstreamUnavailable } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';
import { toSettlementAmount } from '../units.js';

/**
 * A venue mandate UUID as the vault's key.
 *
 * Deterministic, so the same mandate always resolves to the same slot, and collision-free in
 * any sense that matters — a keccak collision is not the failure mode to design against here.
 */
export function vaultMandateId(mandateUuid: string): bigint {
  return BigInt(keccak256(toHex(mandateUuid)));
}

const VAULT_ABI = parseAbi([
  'struct Payout { uint256 mandateId; address seller; bool executed; uint128 price; }',
  'function balanceOf(uint256 mandateId) view returns (uint128)',
  'function buyerOf(uint256 mandateId) view returns (address)',
  'function settlementToken() view returns (address)',
  'function payoutOf(bytes32 matchId) view returns (Payout)',
  'function paymentEscrow() view returns (address)',
  'function registerMandate(uint256 mandateId, address buyer)',
  'function registerMatch(bytes32 matchId, uint256 mandateId, address seller, uint128 price)',
  /*
   * The vault's OTHER way out, and it was missing from this ABI entirely — so "withdraw
   * unallocated capital" decremented a SQLite row and left the real USDC with no path out of
   * the contract at all. A buyer could post capital and never get it back.
   *
   * It takes no recipient on purpose. `executeRelease` pays `buyerOf(mandateId)`, the one-shot
   * binding written at registration, so the venue cannot redirect a buyer's own money even by
   * accident — which is why the caller reads that binding rather than passing an address.
   */
  'function executeRelease(bytes32 authId, uint256 mandateId, uint128 amount)',
  'function executePayout(bytes32 authId, bytes32 matchId, bytes32 lockId, bytes32 secretHash)',
]);

/**
 * Read-only, and only ever read. The venue never calls the escrow directly — capital reaches
 * it through `MandateVault.executePayout`, which is what binds a payout to the seller the
 * match named. Opening a lock here by hand would bypass that binding entirely.
 */
const ESCROW_ABI = parseAbi([
  'struct Lock { bytes32 secretHash; bytes32 tradeRef; address depositor; uint64 timeout; uint8 kind; uint8 status; address beneficiary; address asset; uint256 amount; }',
  'function getLock(bytes32 lockId) view returns (Lock)',
]);

/** `DvpEscrow.LockStatus`. `Claimed` and `Refunded` are terminal; there is no reopen path. */
export const LOCK_STATUS = ['none', 'locked', 'claimed', 'refunded'] as const;
export type LockStatus = (typeof LOCK_STATUS)[number];

/**
 * The ids a payout is made of, and where each one comes from.
 *
 * `MandateBook` mints all of these on Hedera in the intended design — `computeMatchId` and
 * `computeAuthorisationId`, both domain-separated and bound to the book's own chain id and
 * address. **The book is not wired**, so the venue mints them instead, and these derivations
 * are deliberately NOT the book's: they take the venue's trade id, which is the thing the
 * venue actually reasons about, rather than a match id it would have to invent to imitate a
 * contract nobody is calling.
 *
 * That is the same trade `vaultMandateId` already makes, and it carries the same obligation:
 * **anything that later wires `MandateBook` has to reconcile these id spaces rather than
 * assume they line up.** Two systems disagreeing about which match is which is how a payout
 * ends up bound to the wrong seller — and `registerMatch` is one-shot, so that binding could
 * not be corrected afterwards.
 *
 * The vault verifies none of them. It checks `authId` is non-zero and unused, and treats
 * `matchId` as a mapping key. The derivation buys replay separation between deployments, not
 * authentication — `IMandateVault` says so plainly, and the four bounds in its header are
 * what actually limit a compromised relay.
 */
const domainId = (domain: string, tradeId: string): `0x${string}` =>
  keccak256(toHex(`facture.${domain}.v1:${tradeId}`));

/**
 * ## Retrying is arming a new trade, and that is the whole mechanism
 *
 * An earlier version of these took an `attempt` number, and documented bumping it to recover
 * from a squatted lock id. **Nothing ever bumped it** — every call site passed `0`, there was
 * no retry loop, and the parameter described a recovery path that did not exist. It is gone
 * rather than left as an unused hook, because a documented mechanism with no caller is worse
 * than no mechanism: the next person reads it as a guarantee.
 *
 * The real recovery is simpler and already works. `prepareTrade` inserts a fresh trade row on
 * every arming, so a retry has a new trade id, and therefore a new match id, a new
 * authorisation id and a new lock id. A burned lock id can never be reused by the trade that
 * burned it, and no other trade would ever derive it.
 */

/** One match per trade, permanently: a match binding cannot be replaced once written. */
export const matchIdFor = (tradeId: string): `0x${string}` => domainId('match', tradeId);

/**
 * Single-use in the vault, and shared across releases and payouts.
 *
 * A payout that reverted did NOT consume its authorisation — the whole transaction rolls back
 * — so the id survives a failed attempt. A succeeded one burns it forever, which is caught
 * earlier by the `executed` check on the binding.
 */
export const authIdFor = (tradeId: string): `0x${string}` => domainId('auth', tradeId);

/**
 * Caller-supplied in a **permissionless, shared** escrow, so one can in principle be squatted.
 *
 * `openLock` rejects any id it has ever seen — `Claimed` and `Refunded` included, since a lock
 * id is burned forever — and that revert propagates out of `executePayout` as
 * `DvpEscrow.LockExists`, decoded against the escrow's ABI rather than the vault's. The whole
 * call reverts, so nothing is consumed and the sale is refused; the seller arms again and gets
 * a new id with the new trade.
 */
export const lockIdFor = (tradeId: string): `0x${string}` => domainId('lock', tradeId);

/**
 * The one authorisation id here that is minted rather than derived, and why.
 *
 * Every other id on this path comes from a trade id, because a trade is a row this venue can
 * name and a retry of one trade must produce the same match. **A withdrawal is not a row.**
 * `withdrawFromMandate` decrements a mandate and returns an amount; there is nothing durable
 * to derive from, and the obvious substitutes all collide: two withdrawals of the same amount
 * from the same mandate would derive one id, and the vault's `_consumed` guard would refuse
 * the second one forever. That is a buyer permanently unable to take their own capital out.
 *
 * So the id is fresh per authorisation, which is exactly what `_consumed` wants. Randomness
 * costs nothing here — the id authenticates nobody (`IMandateVault` says so plainly; only the
 * attester may call), it merely has to be unique and unreplayable.
 *
 * It is published on a successful release and logged beside the transaction hash on a failed
 * one, which is the case that needs it: a release whose receipt never arrived can be settled
 * against the vault's own `isConsumed(authId)` by hand, rather than guessed at from a timeout.
 */
export const releaseAuthId = (): `0x${string}` =>
  keccak256(toHex(`facture.release.v1:${randomUUID()}`));

export interface ArcEscrow {
  /** Whether a vault is configured at all. False means funding is recorded, not verified. */
  readonly enabled: boolean;
  /**
   * USDC the vault would have to hold to back `amountMinor` of `currency`, in the same
   * ERC-20 minor units (6dp) {@link depositedFor} answers in.
   *
   * The two are only comparable through here. Comparing a mandate's own minor units against
   * a vault balance is a 10^4 error that looks like agreement, which is how it survived.
   */
  requiredFor(amountMinor: bigint, currency: string): bigint;
  /**
   * USDC the vault may return when `amountMinor` of `currency` is withdrawn from the book,
   * in the same ERC-20 minor units (6dp) {@link depositedFor} answers in.
   *
   * The same conversion as {@link requiredFor} and the opposite rounding, which is not a
   * detail — see {@link usdcReleasableFor}.
   */
  releasableFor(amountMinor: bigint, currency: string): bigint;
  /** USDC actually held for this mandate, in ERC-20 minor units (6dp). */
  depositedFor(mandateUuid: string): Promise<bigint>;
  /** The address a release would pay, or `null` when the mandate was never registered. */
  buyerOf(mandateUuid: string): Promise<string | null>;
  /**
   * Attester-only. Must happen before any deposit can land against the mandate.
   *
   * One-shot and uncorrectable — `MandateAlreadyRegistered` on a second call, with no update
   * path — so the address bound here is the only address this mandate's capital can ever come
   * back to. Call it through {@link ensureMandateRegistered}, which reads the binding first
   * and refuses an address nobody can be shown to hold a key for.
   */
  registerMandate(mandateUuid: string, buyer: string): Promise<{ transactionHash: string }>;

  /**
   * Return unallocated capital to the mandate's registered buyer.
   *
   * Takes no recipient: the vault pays `buyerOf(mandateId)` and ignores anything the relay
   * might prefer. `amountUsdcMinor` is USDC ERC-20 minor units (6dp), never the mandate's own
   * currency — the two differ by four orders of magnitude and read as the same number.
   */
  executeRelease(input: {
    mandateUuid: string;
    amountUsdcMinor: bigint;
  }): Promise<{ transactionHash: string; authId: string }>;

  /**
   * The payout binding for a trade, or `null` if this match was never registered.
   *
   * Asked before every write on this path, because **`registerMatch` is one-shot**: a second
   * call reverts `MatchAlreadyRegistered` even from the attester with identical arguments,
   * and there is no update path. A restart mid-settlement must be able to tell "already bound"
   * from "not bound yet" without spending a transaction to find out.
   */
  payoutFor(tradeId: string): Promise<VaultPayout | null>;

  /**
   * Bind who gets paid, how much, and out of which mandate — **before the seller delivers.**
   *
   * That ordering is the point rather than an implementation detail: a seller can read
   * `payoutOf(matchId)` and see the price and payee fixed and public before parting with the
   * paper. It is also irreversible, so a wrong seller or price is permanent for this trade.
   */
  registerMatch(input: {
    tradeId: string;
    mandateUuid: string;
    seller: string;
    priceUsdcMinor: bigint;
  }): Promise<{ transactionHash: string; matchId: string }>;

  /**
   * Move the mandate's capital into the escrow, locked for the seller the match named.
   *
   * The money leaves the vault here; it does not reach the seller. It sits in `DvpEscrow`
   * claimable only by that address, only with the preimage of `secretHash`, and only for the
   * vault's `PAYMENT_LOCK_DURATION` — 24 hours, read from the deployed contract. So this is
   * the cash committing, not the cash being paid, which is what lets the asset leg go second.
   */
  executePayout(input: {
    tradeId: string;
    secretHash: `0x${string}`;
  }): Promise<{ transactionHash: string; lockId: string; authId: string }>;

  /** The escrow's own view of a lock. `null` for an id it has never seen. */
  lockOf(lockId: string): Promise<EscrowLock | null>;
  /**
   * Where payouts land, read off the vault's immutable rather than configured.
   *
   * Published because the seller has to send `claim` to it themselves — the escrow
   * checks `msg.sender == beneficiary`, so nobody can collect on their behalf, and a
   * seller who cannot see the address cannot act on the lock.
   */
  escrowAddress(): Promise<string>;
}

/** `MandateVault.Payout`. The binding a payout is measured against. */
export interface VaultPayout {
  matchId: string;
  mandateId: bigint;
  seller: string;
  /** One match, at most one payout, ever — and `reclaimPayout` does not clear it. */
  executed: boolean;
  /** USDC minor units (6dp). */
  price: bigint;
}

/** `DvpEscrow.Lock`, as much of it as this service has any business reading. */
export interface EscrowLock {
  status: LockStatus;
  beneficiary: string;
  /** USDC minor units (6dp). */
  amount: bigint;
  /** Unix seconds. Claiming is permitted strictly before this; refunding at or after it. */
  timeout: number;
  secretHash: string;
  /** The match id, carried through so an indexer can pair the two legs. */
  tradeRef: string;
}

export interface ArcEscrowConfig {
  readonly vaultAddress: string | undefined;
  readonly settlementPrivateKey: string;
  readonly maxFeePerGasGwei: number;
  /**
   * Parts-per-million scale on settled amounts, shared with the Hedera cash leg.
   *
   * Deliberately not its own variable. One receivable has to cost the same money whichever
   * rail settles it, and a second knob is how the two rails come to disagree.
   */
  readonly settlementScalePpm: number;
  readonly logger?: Logger | undefined;
}

/** USDC on Arc, read through the ERC-20 interface. Never the 18-decimal gas accounting. */
const USDC_DECIMALS = ARC_TESTNET.tokens.USDC.decimals;

/**
 * What the vault must hold to back an amount written in an invoice currency.
 *
 * Shared by both escrow implementations, including the disabled one — a deployment with no
 * vault still has to answer what backing *would* mean, or the two would convert differently
 * and the answer would depend on configuration.
 *
 * Exported so a test double converts the same way the service does. A stub with its own
 * arithmetic is a test that passes while production is wrong, which is the shape of the
 * defect this function exists to close.
 */
export const usdcRequiredFor = (amountMinor: bigint, currency: string, scalePpm: number): bigint =>
  toSettlementAmount(
    amountMinor,
    CURRENCY_DECIMALS[currency as Currency] ?? 2,
    USDC_DECIMALS,
    scalePpm,
    /*
     * Up, unlike the payment leg. This is the amount capital has to REACH, so a remainder
     * rounded away is backing the venue asked for and did not get. At 1 ppm the granularity
     * is a dollar, so rounding down would require zero USDC for anything under $1.00 and an
     * empty vault would back it — the exact overclaim this check exists to refuse.
     */
    'up',
  );

/**
 * What the vault may pay back when that same amount is withdrawn from the book.
 *
 * **The same conversion and the opposite rounding, and the direction is the whole point.**
 * The invariant a funded mandate keeps is `vaultBalance >= usdcRequiredFor(committed)`, and a
 * withdrawal has to leave it standing over the smaller book that remains. Rounding the
 * release DOWN does: `ceil(a) - floor(b) >= ceil(a - b)` for every remainder, so whatever dust
 * the scaling leaves behind stays in the vault, backing capital the book still counts.
 *
 * Rounding it up breaks that outright, and not by a hair. Release `ceil` of a $0.10 withdrawal
 * at 1 ppm and a whole USDC minor unit leaves the vault against a book that decremented by a
 * tenth of one — repeat it and a mandate quoting real capital is standing on an empty vault,
 * which is the overclaim the funding check exists to refuse arriving through the back door.
 *
 * It is also the payment rule from {@link toSettlementAmount} seen from the other side: money
 * moving out rounds down, so the venue never hands over more than the ledger authorised.
 */
export const usdcReleasableFor = (
  amountMinor: bigint,
  currency: string,
  scalePpm: number,
): bigint =>
  toSettlementAmount(
    amountMinor,
    CURRENCY_DECIMALS[currency as Currency] ?? 2,
    USDC_DECIMALS,
    scalePpm,
    'down',
  );

/**
 * No vault configured.
 *
 * Reads answer "nothing is escrowed" rather than throwing, because the funding route has to
 * be able to ask without a vault present — this deployment's honest answer is that it does
 * not know, and `enabled` is how the route tells the two apart. Writing still refuses,
 * naming the variable, in the same shape as issuance with no ATS factory.
 */
export function createDisabledArcEscrow(scalePpm = 1): ArcEscrow {
  return {
    enabled: false,
    requiredFor: (amountMinor, currency) => usdcRequiredFor(amountMinor, currency, scalePpm),
    releasableFor: (amountMinor, currency) => usdcReleasableFor(amountMinor, currency, scalePpm),
    depositedFor: () => Promise.resolve(0n),
    buyerOf: () => Promise.resolve(null),
    registerMandate: () => Promise.reject(noVault('Registering a mandate')),
    executeRelease: () => Promise.reject(noVault('Releasing mandate capital')),
    payoutFor: () => Promise.resolve(null),
    lockOf: () => Promise.resolve(null),
    escrowAddress: () => Promise.reject(noVault('Reading the payout escrow')),
    registerMatch: () => Promise.reject(noVault('Binding a payout')),
    executePayout: () => Promise.reject(noVault('Paying a seller on Arc')),
  };
}

const noVault = (what: string) =>
  badRequest(
    `${what} needs the Arc vault. ARC_MANDATE_VAULT_ADDRESS is not set, so mandate capital ` +
      'is not escrowed on this deployment and the cash leg settles over x402 instead.',
  );

export function createArcEscrow(config: ArcEscrowConfig): ArcEscrow {
  if (config.vaultAddress === undefined) return createDisabledArcEscrow(config.settlementScalePpm);

  const address = config.vaultAddress as `0x${string}`;
  const log = (config.logger ?? rootLogger).child({ svc: 'arc' });
  const reader = createPublicClient({ chain: arcChain, transport: http() });

  const read = <T>(fn: 'balanceOf' | 'buyerOf', mandateUuid: string): Promise<T> =>
    reader.readContract({
      address,
      abi: VAULT_ABI,
      functionName: fn,
      args: [vaultMandateId(mandateUuid)],
    }) as Promise<T>;

  const isZeroAddress = (value: string): boolean => /^0x0{40}$/i.test(value);

  /**
   * Where the payout lands, asked of the vault rather than configured.
   *
   * `MandateVault._paymentEscrow` is `immutable` and set at construction — capital can leave
   * toward that one address and nowhere else, which is the binding the vault's header calls
   * bound (4). A second environment variable naming the escrow could therefore only ever
   * disagree with the contract, and a reader trusting the wrong one would be checking the
   * wrong ledger for their money. Cached because an immutable cannot change.
   */
  let escrowAddress: `0x${string}` | undefined;
  const paymentEscrow = async (): Promise<`0x${string}`> => {
    /*
     * The VALUE is cached, not the promise. `??=` over a promise caches a rejection exactly
     * as durably as a success, so a single RPC blip on the first call would make every later
     * read of every lock answer "unreadable" for the life of the process — an immutable that
     * can never be re-read because it failed once.
     */
    escrowAddress ??= (await reader.readContract({
      address,
      abi: VAULT_ABI,
      functionName: 'paymentEscrow',
    })) as `0x${string}`;
    return escrowAddress;
  };

  /**
   * Every write on this path, and the receipt check none of them may skip.
   *
   * `writeContract` resolves when a transaction is ACCEPTED, not when it succeeded — the
   * revert lands later, in the receipt. This service already shipped that bug once:
   * `registerMandate` returned its hash without ever looking, so a rejected registration
   * would have been reported as a mandate registered. It is the mistake the uniqueness
   * registry made, and the one `deployBond` made before that, which is why this is a helper
   * rather than a rule to remember at four call sites.
   */
  const send = async (
    functionName: 'registerMandate' | 'registerMatch' | 'executeRelease' | 'executePayout',
    args: readonly unknown[],
    context: Record<string, unknown>,
  ): Promise<`0x${string}`> => {
    const account = privateKeyToAccount(config.settlementPrivateKey as `0x${string}`);
    const wallet = createWalletClient({ account, chain: arcChain, transport: http() });

    /*
     * Arc rejects anything under its floor as "underpriced", so the fee is set explicitly
     * rather than left to estimation. `env.ts` validates the configured value against the
     * same floor, so this cannot be configured below it.
     */
    const maxFeePerGas = BigInt(config.maxFeePerGasGwei) * 1_000_000_000n;

    const hash = await wallet.writeContract({
      address,
      abi: VAULT_ABI,
      functionName,
      args: args as never,
      maxFeePerGas,
      maxPriorityFeePerGas: 0n,
    });

    /*
     * A TIMEOUT IS NOT A REVERT, and conflating them is how money goes missing.
     *
     * viem gives up waiting after its own default and throws — but the transaction is still
     * live in the mempool and may mine seconds later. Reporting that as "nothing was written"
     * would be a specific, false claim: on `executePayout` it means the venue tells the
     * caller the trade failed, releases the capital, and then the payout lands, putting USDC
     * in a lock nobody recorded and nobody can find.
     *
     * So the two are distinguished, and the timeout case names the transaction and says the
     * outcome is unknown rather than negative. It is deliberately NOT retried here: a second
     * `executePayout` for the same match would revert on the first one's success, and a
     * second `registerMatch` reverts unconditionally.
     */
    let receipt;
    try {
      receipt = await reader.waitForTransactionReceipt({ hash });
    } catch (err) {
      log.error(`${functionName} receipt not seen on Arc`, { ...context, hash, err });
      throw upstreamUnavailable(
        'Arc',
        `Arc did not confirm ${functionName} in time. The transaction is ${hash} and it may ` +
          'still succeed, so its outcome is unknown rather than failed — check it before ' +
          'assuming nothing moved.',
      );
    }

    if (receipt.status !== 'success') {
      /*
       * Deliberately not decoded into a specific custom error. Reverts reaching here belong
       * to two different ABIs — the vault's and, through it, the escrow's — and guessing
       * which one a selector came from is how a squatted lock id gets reported as a vault
       * fault. The transaction hash is the thing a reader can actually check.
       */
      throw upstreamUnavailable(
        'Arc',
        functionName +
          ' reverted on Arc. The transaction is ' +
          hash +
          '; nothing it would have written was written.',
      );
    }

    log.info(functionName + ' on Arc', {
      ...context,
      hash,
      gasUsed: receipt.gasUsed.toString(10),
    });
    return hash;
  };

  return {
    enabled: true,

    requiredFor(amountMinor, currency) {
      return usdcRequiredFor(amountMinor, currency, config.settlementScalePpm);
    },

    releasableFor(amountMinor, currency) {
      return usdcReleasableFor(amountMinor, currency, config.settlementScalePpm);
    },

    async depositedFor(mandateUuid) {
      return read<bigint>('balanceOf', mandateUuid);
    },

    async buyerOf(mandateUuid) {
      const buyer = await read<string>('buyerOf', mandateUuid);
      // The vault returns the zero address for a mandate it has never seen.
      return isZeroAddress(buyer) ? null : buyer;
    },

    async registerMandate(mandateUuid, buyer) {
      const hash = await send('registerMandate', [vaultMandateId(mandateUuid), buyer], {
        mandateUuid,
        buyer,
      });
      return { transactionHash: hash };
    },

    async executeRelease({ mandateUuid, amountUsdcMinor }) {
      const authId = releaseAuthId();
      const hash = await send(
        'executeRelease',
        [authId, vaultMandateId(mandateUuid), amountUsdcMinor],
        {
          mandateUuid,
          amountUsdcMinor: amountUsdcMinor.toString(10),
          authId,
        },
      );
      return { transactionHash: hash, authId };
    },

    async payoutFor(tradeId) {
      const matchId = matchIdFor(tradeId);
      const payout = (await reader.readContract({
        address,
        abi: VAULT_ABI,
        functionName: 'payoutOf',
        args: [matchId],
      })) as { mandateId: bigint; seller: string; executed: boolean; price: bigint };

      // An unregistered match reads back zero-filled, and the seller is what says so.
      if (isZeroAddress(payout.seller)) return null;
      return {
        matchId,
        mandateId: payout.mandateId,
        seller: payout.seller,
        executed: payout.executed,
        price: payout.price,
      };
    },

    async registerMatch({ tradeId, mandateUuid, seller, priceUsdcMinor }) {
      const matchId = matchIdFor(tradeId);
      const hash = await send(
        'registerMatch',
        [matchId, vaultMandateId(mandateUuid), seller, priceUsdcMinor],
        { tradeId, mandateUuid, seller, priceUsdcMinor: priceUsdcMinor.toString(10) },
      );
      return { transactionHash: hash, matchId };
    },

    async executePayout({ tradeId, secretHash }) {
      const authId = authIdFor(tradeId);
      const lockId = lockIdFor(tradeId);
      const hash = await send('executePayout', [authId, matchIdFor(tradeId), lockId, secretHash], {
        tradeId,
        lockId,
      });
      return { transactionHash: hash, lockId, authId };
    },

    async escrowAddress() {
      return paymentEscrow();
    },

    async lockOf(lockId) {
      const lock = (await reader.readContract({
        address: await paymentEscrow(),
        abi: ESCROW_ABI,
        functionName: 'getLock',
        args: [lockId as `0x${string}`],
      })) as {
        secretHash: string;
        tradeRef: string;
        depositor: string;
        timeout: bigint;
        kind: number;
        status: number;
        beneficiary: string;
        asset: string;
        amount: bigint;
      };

      // An unknown id reads back zero-filled, which is `status: none` rather than an error.
      if (lock.status === 0) return null;
      return {
        status: LOCK_STATUS[lock.status] ?? 'none',
        beneficiary: lock.beneficiary,
        amount: lock.amount,
        timeout: Number(lock.timeout),
        secretHash: lock.secretHash,
        tradeRef: lock.tradeRef,
      };
    },
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const ZERO_ADDRESS = /^0x0{40}$/i;

/** An address this venue is willing to bind capital to, or the reason it will not. */
export type ArcAddressCheck = { ok: true; address: `0x${string}` } | { ok: false; reason: string };

/**
 * Whether an address may be bound as the only place a mandate's capital can ever return to.
 *
 * **Four of the seeded parties' addresses were invented**, and `seed.ts` says so: plausible hex
 * nobody holds a key for. `registerMandate` is one-shot with no update path, so binding one is
 * not a mistake anyone can correct afterwards — it is a mandate whose capital has a way in and
 * no way out. Refusing to register is strictly better: the vault then refuses the deposit too,
 * and the money never gets in to be stranded.
 *
 * EIP-55 is the tripwire, and it is the same one `scripts/demo-reset.mjs` uses so that the
 * provisioning script and the route cannot disagree about which addresses are real. It catches
 * all three invented buyer addresses because whoever wrote them typed mixed case without
 * computing a checksum, while the one real wallet is lowercase and passes. **That is a useful
 * accident and not a proof** — a fabricated address with a correct checksum sails through — so
 * this is a floor under carelessness, not a guarantee of custody.
 *
 * The zero address is refused separately and by name. `registerMandate` reverts on it anyway,
 * but a local refusal says which of the two problems it is instead of spending a transaction
 * to be told.
 */
export function payableArcAddress(value: string | null | undefined): ArcAddressCheck {
  if (value === null || value === undefined || value === '') {
    return { ok: false, reason: 'is missing, so there is no address a release could pay' };
  }
  if (ZERO_ADDRESS.test(value)) {
    return { ok: false, reason: 'is the zero address, which the vault refuses and nobody holds' };
  }
  if (!isAddress(value, { strict: true })) {
    return {
      ok: false,
      reason: 'fails its EIP-55 checksum, so it was typed rather than generated by a wallet',
    };
  }
  return { ok: true, address: value };
}

/**
 * What the vault knows about a mandate's cash leg after this call, and how it came to know it.
 *
 * Flat rather than a discriminated union because it is rendered on the wire, where a reader has
 * to be able to tell "registered" from "we could not ask" without inspecting which keys are
 * present — the same distinction `checked: false` draws in `services/uniqueness.ts`.
 */
export interface MandateRegistration {
  /**
   * - `disabled` — no vault on this deployment; funding is recorded rather than escrowed.
   * - `registered` — bound by this call, and the mandate can now be funded.
   * - `already-registered` — bound already, to the address on file. What every re-run should say.
   * - `bound-elsewhere` — bound to a DIFFERENT address. Permanent, and a release would pay it.
   * - `unpayable` — the address on file cannot be shown to belong to anyone. Nothing written.
   * - `unavailable` — the chain could not be reached, or the write failed. Nothing written.
   */
  state:
    | 'disabled'
    | 'registered'
    | 'already-registered'
    | 'bound-elsewhere'
    | 'unpayable'
    | 'unavailable';
  /** The address the vault will pay a release to, when it is bound and readable. */
  buyer: string | null;
  transactionHash: string | null;
  /** One sentence naming what happened and what it costs. */
  detail: string;
}

/**
 * Register a mandate's cash leg, once, and never on an address nobody can receive at.
 *
 * **`MandateVault.deposit` reverts `MandateNotRegistered` against an unregistered mandate**, so
 * until this has run the mandate cannot be funded at all — every quote it would have made is
 * unbacked and the funding route refuses it. That gap was real: `registerMandate` had no caller
 * anywhere in the backend, the one working mandate had been registered by hand, and every
 * mandate written through `POST /v1/mandates` was unescrowable until someone ran a provisioning
 * script. This is that caller.
 *
 * **It reads before it writes, because the write cannot be taken back.** A second
 * `registerMandate` reverts `MandateAlreadyRegistered` even with identical arguments, so a
 * blind retry after a lost receipt would report a failure where the binding is actually fine.
 * Asking `buyerOf` first costs a view call and tells a re-run from a first attempt.
 *
 * **It never throws.** Writing a mandate is a business act and a vault that is unreachable must
 * cost the registration, not the bid — the same trade `services/uniqueness.ts` makes when the
 * registry is down. What it must not do is stay quiet about it, because an unregistered mandate
 * fails later, at a deposit, in a contract revert nobody reads. Hence a state on every answer.
 */
export async function ensureMandateRegistered(
  vault: ArcEscrow,
  mandateUuid: string,
  buyerAddress: string | null,
): Promise<MandateRegistration> {
  if (!vault.enabled) {
    return {
      state: 'disabled',
      buyer: null,
      transactionHash: null,
      detail:
        'ARC_MANDATE_VAULT_ADDRESS is not set, so this mandate has no cash leg on Arc and its ' +
        'funding is recorded rather than escrowed.',
    };
  }

  let bound: string | null;
  try {
    bound = await vault.buyerOf(mandateUuid);
  } catch (err) {
    return {
      state: 'unavailable',
      buyer: null,
      transactionHash: null,
      detail:
        `The Arc vault could not be read (${messageOf(err)}), so this mandate's cash leg was ` +
        'not registered. A deposit against it reverts until it is.',
    };
  }

  if (bound !== null) {
    // Case-insensitively: hex from a chain call and hex from a database column differ in case
    // and mean the same twenty bytes.
    if (bound.toLowerCase() === (buyerAddress ?? '').toLowerCase()) {
      return {
        state: 'already-registered',
        buyer: bound,
        transactionHash: null,
        detail: `This mandate's cash leg is already bound to ${bound}, which is the buyer on file.`,
      };
    }
    return {
      state: 'bound-elsewhere',
      buyer: bound,
      transactionHash: null,
      detail:
        `This mandate's cash leg is bound to ${bound}, not the ${buyerAddress ?? 'nothing'} on ` +
        'file. `registerMandate` is one-shot with no update path, so the binding cannot be ' +
        'corrected and a release would pay that address.',
    };
  }

  const payable = payableArcAddress(buyerAddress);
  if (!payable.ok) {
    return {
      state: 'unpayable',
      buyer: null,
      transactionHash: null,
      detail:
        `This mandate was not registered on Arc: the buyer's address ${payable.reason}. The ` +
        'binding is permanent, so an address nobody can receive at is capital with no way back ' +
        'out — the vault refusing the deposit is the better failure.',
    };
  }

  try {
    const { transactionHash } = await vault.registerMandate(mandateUuid, payable.address);
    return {
      state: 'registered',
      buyer: payable.address,
      transactionHash,
      detail: `This mandate's cash leg is now bound to ${payable.address} and can be funded.`,
    };
  } catch (err) {
    return {
      state: 'unavailable',
      buyer: null,
      transactionHash: null,
      detail:
        `Registering this mandate on Arc failed (${messageOf(err)}). The mandate exists and a ` +
        'deposit against it reverts until the registration succeeds.',
    };
  }
}

/** What became of the real USDC behind a withdrawal from the book. */
export interface CapitalRelease {
  /**
   * - `disabled` — no vault on this deployment; the withdrawal is a ledger entry and no more.
   * - `unregistered` — the vault never knew this mandate, so no capital can have landed in it.
   * - `bound-elsewhere` — the vault pays an address that is not the buyer on file. Nothing sent.
   * - `dust` — the scaled amount is below one USDC minor unit; there is nothing to move.
   * - `insufficient` — the vault holds less than this release needs. Nothing sent.
   * - `released` — USDC returned to the registered buyer.
   * - `unavailable` — the chain could not be reached, or the write failed or timed out.
   */
  state:
    | 'disabled'
    | 'unregistered'
    | 'bound-elsewhere'
    | 'dust'
    | 'insufficient'
    | 'released'
    | 'unavailable';
  /** USDC ERC-20 minor units (6dp) the vault was asked to return. Never the book's own units. */
  amountUsdcMinor: bigint;
  /** The address the vault is bound to pay, when it could be read. */
  buyer: string | null;
  transactionHash: string | null;
  authId: string | null;
  detail: string;
}

/**
 * Move the money a withdrawal already took off the book.
 *
 * **The book is decremented first and this runs second**, which is the order `IMandateVault`
 * asks for rather than a convenience: the attested balance must never exceed the real one, so
 * the safe failure is a book that counts less capital than the vault holds. A release that
 * fails here leaves the buyer's USDC in the vault with the book no longer quoting against it —
 * recoverable by funding the mandate again. Reverse the two and a release that lands after the
 * book failed to decrement leaves a mandate quoting capital that has already left, which is a
 * price nobody can honour.
 *
 * **It never throws, for the same reason a scheduling failure cannot un-mature a receivable.**
 * The withdrawal happened; a rail that is down does not un-happen it. Every refusal below is a
 * separate fact with its own name, because "the vault holds nothing" and "the vault could not
 * be asked" want different actions from whoever reads them.
 */
export async function releaseMandateCapital(
  vault: ArcEscrow,
  input: {
    mandateUuid: string;
    /** The withdrawal, in the mandate's own currency's minor units (2dp for USD). */
    amountMinor: bigint;
    currency: string;
    /** The buyer this venue believes owns the mandate. Compared, never sent. */
    buyerAddress: string | null;
  },
): Promise<CapitalRelease> {
  const base = { buyer: null, transactionHash: null, authId: null };

  if (!vault.enabled) {
    return {
      ...base,
      state: 'disabled',
      amountUsdcMinor: 0n,
      detail:
        'ARC_MANDATE_VAULT_ADDRESS is not set, so no capital is escrowed on this deployment and ' +
        'the withdrawal moved nothing but the book.',
    };
  }

  /*
   * Converted before anything is compared or sent. The book is in the mandate's own currency at
   * 2 decimals and the vault is USDC at 6, and $50,000.00 and 5 USDC are both `5000000` — the
   * defect that made a mandate read as backed by a ten-thousandth of its capital.
   */
  const amountUsdcMinor = vault.releasableFor(input.amountMinor, input.currency);

  /*
   * Nothing to move, and asked before the vault is read at all so a no-op costs no round trip.
   * `executeRelease` reverts `ZeroValue` on a zero amount, and a remainder rounded away stays
   * in the vault backing capital the book still counts — which is the direction
   * {@link usdcReleasableFor} rounds for.
   */
  if (amountUsdcMinor === 0n) {
    return {
      ...base,
      state: 'dust',
      amountUsdcMinor,
      detail:
        `Withdrawing ${input.amountMinor} ${input.currency} minor units scales to less than one ` +
        'USDC minor unit, so nothing left the vault and the remainder stays as backing.',
    };
  }

  let bound: string | null;
  let deposited: bigint;
  try {
    // Both reads before any write, and both are views: they cost no key, no gas and no
    // signature, which is what makes a pre-flight cheaper than a reverted transaction.
    bound = await vault.buyerOf(input.mandateUuid);
    deposited = await vault.depositedFor(input.mandateUuid);
  } catch (err) {
    return {
      ...base,
      state: 'unavailable',
      amountUsdcMinor,
      detail:
        `The Arc vault could not be read (${messageOf(err)}), so no capital was returned. The ` +
        'withdrawal stands on the book and the USDC is still in the vault.',
    };
  }

  if (bound === null) {
    return {
      ...base,
      state: 'unregistered',
      amountUsdcMinor,
      detail:
        'This mandate has no cash leg on Arc, so no capital can ever have been escrowed against ' +
        'it and there is nothing to return.',
    };
  }

  /*
   * The vault pays `buyerOf` and takes no recipient, so a binding that disagrees with the buyer
   * on file is not something the venue can steer around — it can only decline to trigger it.
   * Sending anyway would move a buyer's money to an address this venue does not believe is
   * theirs, on that buyer's own instruction, which is worse than leaving it escrowed.
   */
  if (bound.toLowerCase() !== (input.buyerAddress ?? '').toLowerCase()) {
    return {
      ...base,
      state: 'bound-elsewhere',
      buyer: bound,
      amountUsdcMinor,
      detail:
        `The vault would pay ${bound}, which is not the ${input.buyerAddress ?? 'nothing'} on ` +
        'file for this buyer. No capital was returned; the binding is permanent and needs an ' +
        'operator.',
    };
  }

  if (amountUsdcMinor > deposited) {
    return {
      ...base,
      state: 'insufficient',
      buyer: bound,
      amountUsdcMinor,
      detail:
        `Returning this withdrawal needs ${amountUsdcMinor} USDC minor units and the vault holds ` +
        `${deposited}. Nothing was sent — the vault would have reverted \`InsufficientVaultBalance\`, ` +
        'and the book was funded against capital that never fully arrived.',
    };
  }

  try {
    const { transactionHash, authId } = await vault.executeRelease({
      mandateUuid: input.mandateUuid,
      amountUsdcMinor,
    });
    return {
      state: 'released',
      buyer: bound,
      amountUsdcMinor,
      transactionHash,
      authId,
      detail: `${amountUsdcMinor} USDC minor units returned to ${bound}.`,
    };
  } catch (err) {
    return {
      ...base,
      state: 'unavailable',
      buyer: bound,
      amountUsdcMinor,
      detail:
        `Returning this withdrawal on Arc did not complete (${messageOf(err)}). The withdrawal ` +
        'stands on the book; whether the USDC moved is what that message says and is not ' +
        'something this venue is claiming either way.',
    };
  }
}

let escrow: ArcEscrow | undefined;

export function initArcEscrow(config: ArcEscrowConfig): ArcEscrow {
  escrow = createArcEscrow(config);
  return escrow;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setArcEscrow(next: ArcEscrow | undefined): void {
  escrow = next;
}

export function getArcEscrow(): ArcEscrow {
  if (!escrow) throw new Error('Arc escrow accessed before initArcEscrow().');
  return escrow;
}
