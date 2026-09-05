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
 * ## What this does not do
 *
 * It does not move money. Depositing pulls USDC from `msg.sender`, so a deposit is the
 * buyer's own transaction from the buyer's own wallet — the venue holds the attester key, not
 * the buyer's. All the venue does is `registerMandate`, which names who a release may be paid
 * to, and then read what arrived.
 */

import type { Currency } from '@facture/shared';
import { ARC_TESTNET, CURRENCY_DECIMALS } from '@facture/shared';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } from 'viem';
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
const domainId = (domain: string, tradeId: string, attempt: number): `0x${string}` =>
  keccak256(toHex(`facture.${domain}.v1:${tradeId}:${attempt}`));

/** One match per trade. Fixed at attempt 0, because a match binding cannot be replaced. */
export const matchIdFor = (tradeId: string): `0x${string}` => domainId('match', tradeId, 0);

/**
 * Authorisation ids are single-use in the vault, shared across releases and payouts.
 *
 * Carries the attempt because a payout that reverted did NOT consume its authorisation — the
 * whole transaction rolls back — so reusing the id is safe, while a *succeeded* payout burns
 * it forever. Keeping them aligned with the lock id means one attempt number describes the
 * whole retry rather than two that can drift apart.
 */
export const authIdFor = (tradeId: string, attempt: number): `0x${string}` =>
  domainId('auth', tradeId, attempt);

/**
 * Lock ids are caller-supplied in a **permissionless, shared** escrow, so one can be squatted.
 *
 * `openLock` rejects any id it has ever seen — `Claimed` and `Refunded` included, since a lock
 * id is burned forever — and that revert propagates out of `executePayout` as
 * `DvpEscrow.LockExists`, decoded against the escrow's ABI rather than the vault's. The whole
 * call reverts, so nothing was consumed and the retry is free: bump the attempt.
 */
export const lockIdFor = (tradeId: string, attempt: number): `0x${string}` =>
  domainId('lock', tradeId, attempt);

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
  /** USDC actually held for this mandate, in ERC-20 minor units (6dp). */
  depositedFor(mandateUuid: string): Promise<bigint>;
  /** The address a release would pay, or `null` when the mandate was never registered. */
  buyerOf(mandateUuid: string): Promise<string | null>;
  /** Attester-only. Must happen before any deposit can land against the mandate. */
  registerMandate(mandateUuid: string, buyer: string): Promise<{ transactionHash: string }>;

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
    attempt: number;
    secretHash: `0x${string}`;
  }): Promise<{ transactionHash: string; lockId: string; authId: string }>;

  /** The escrow's own view of a lock. `null` for an id it has never seen. */
  lockOf(lockId: string): Promise<EscrowLock | null>;
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
    depositedFor: () => Promise.resolve(0n),
    buyerOf: () => Promise.resolve(null),
    registerMandate: () => Promise.reject(noVault('Registering a mandate')),
    payoutFor: () => Promise.resolve(null),
    lockOf: () => Promise.resolve(null),
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
  let escrowAddressPromise: Promise<`0x${string}`> | undefined;
  const paymentEscrow = async (): Promise<`0x${string}`> => {
    escrowAddressPromise ??= reader.readContract({
      address,
      abi: VAULT_ABI,
      functionName: 'paymentEscrow',
    }) as Promise<`0x${string}`>;
    return escrowAddressPromise;
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
    functionName: 'registerMandate' | 'registerMatch' | 'executePayout',
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

    const receipt = await reader.waitForTransactionReceipt({ hash });
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

    async executePayout({ tradeId, attempt, secretHash }) {
      const authId = authIdFor(tradeId, attempt);
      const lockId = lockIdFor(tradeId, attempt);
      const hash = await send('executePayout', [authId, matchIdFor(tradeId), lockId, secretHash], {
        tradeId,
        attempt,
        lockId,
      });
      return { transactionHash: hash, lockId, authId };
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
