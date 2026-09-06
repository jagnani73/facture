/**
 * `MandateBook` on Hedera — the venue's match decision, checkable against the chain.
 *
 * The book was deployed on 2026-09-01 and called by nothing until now. What it offers that this
 * database cannot is that its refusals are measured against facts a third party can read: it takes
 * an invoice id and a mandate id and reads the rating, the confirmation status, the due date and
 * the face value **out of `InvoiceRegistry` itself** rather than from whoever is asking. As
 * `IInvoiceRegistry` puts it, "rating below floor" only means something if the rating is not
 * supplied by the party who wants the match to succeed.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS WIRED, AND WHAT IS DELIBERATELY NOT
 * ---------------------------------------------------------------------------------------------
 *
 * Three calls: `postMandate` when a mandate is created, `creditFunding` when it is funded, and
 * `previewMatch` — a free `eth_call` — when a trade is armed.
 *
 * `tryMatch`, `confirmSettlement`, `confirmMaturity` and `authoriseRelease` are NOT wired, and the
 * reason is not effort. `confirmSettlement` demands a **claimed `DvpEscrow` delivery lock** whose
 * depositor, beneficiary and asset equal the match's seller, buyer and instrument. This venue's
 * asset leg is an ATS hold, not a lock: the units never leave the seller's ledger entry. Producing
 * that proof would mean transferring the security into the escrow contract — which is allowlisted
 * and KYC-granted on no instrument the venue has issued — and then having the BUYER call `claim`,
 * which six of seven mandates have no Hedera key to do. Same wall as the declined secondary market
 * and seller self-custody, arriving from the settlement side. Without `confirmSettlement` a match
 * never leaves `Open`, so writing one would put the book permanently out of step with the venue.
 *
 * `previewMatch` is therefore the whole point of this file, and it is the cheapest thing here: one
 * `eth_call`, no state, nothing to reconcile afterwards.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO ID SPACES, JOINED HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------------------------
 *
 * `MandateBook` MINTS mandate ids — `mandateId = ++_mandateCount`, no way to supply one. The Arc
 * vault keys capital by `uint256(keccak256(uuid))`, chosen because to the vault an id is only a
 * mapping key. `services/arc.ts` has warned since it was written that "anything that later posts
 * these mandates to the book must reconcile them rather than assume they match".
 *
 * This is that reconciliation, and it is a database column: `mandates.chain_mandate_id`. Nothing on
 * chain joins the two — the book cannot read Arc and the vault never looks at the book — so the
 * join is the venue's and has to be stored. Without it a mandate is unaddressable on the book after
 * the transaction that created it, because the id is not derivable from the UUID.
 *
 * ---------------------------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------------------------
 *
 * Everything here is INVOICE-CURRENCY MINOR UNITS — cents — and never USDC. The book prices from
 * the registry's `faceValue`, which `services/issuance.ts` lists in cents, so `EXPOSURE_EXHAUSTED`
 * compares the price it computed against the capital credited here. Crediting a USDC figure would
 * put a ppm-scaled number beside a cents one, which is the defect `src/units.ts` exists to end,
 * reproduced on chain where it cannot be patched.
 */

import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RATING_RANK, type Rating } from '@facture/shared';
import { hedera } from '../chain.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';
import { registryId } from './invoice-registry.js';

/**
 * The book's `Rating` enum is `RATING_RANK` — `A:4, B:3, C:2, UNRATED:1, D:0`.
 *
 * Deliberately not a second table. `FactureTypes.sol` says these ordinals "are the on-chain mirror
 * of `RATING_RANK` in `@facture/shared`" and that the two must not drift, because the off-chain
 * quote engine decides what a seller is shown and the enum decides what actually matches. Writing
 * the mapping out again here is exactly how they would come to disagree.
 */
export const ratingOrdinal = (rating: Rating): number => RATING_RANK[rating];

/** `MandateBook`'s caps, which are narrower than this venue's own inputs. See `postMandate`. */
export const BOOK_MAX_YIELD_BPS = 5000;
export const BOOK_MAX_TENOR_DAYS = 365;

const ABI = parseAbi([
  'function postMandate(uint8 minRating, uint32 maxTenorDays, uint16 annualisedYieldBps, uint128 maxPerDebtor) returns (uint256)',
  'function creditFunding(uint256 mandateId, address funder, uint128 amount, bytes32 depositRef)',
  'function previewMatch(bytes32 invoiceId, uint256 mandateId) view returns (bool ok, bytes32 reasonCode, uint128 price, uint32 tenorDays)',
  'function isDepositCredited(bytes32 depositRef) view returns (bool)',
  'function mandateCount() view returns (uint256)',
  'event MandatePosted(uint256 indexed mandateId, address indexed buyer, uint8 minRating, uint32 maxTenorDays, uint16 annualisedYieldBps, uint128 maxPerDebtor)',
]);

const POST_GAS = 400_000n;
const CREDIT_GAS = 250_000n;

/** `bytes32` reason codes are right-padded ASCII, so they read back as the name they spell. */
export function decodeReason(raw: `0x${string}`): string {
  const bytes = Buffer.from(raw.slice(2), 'hex');
  const end = bytes.indexOf(0);
  const text = bytes.subarray(0, end === -1 ? bytes.length : end).toString('ascii');
  return text === '' ? 'NONE' : text;
}

/**
 * The reference `creditFunding` refuses to accept twice.
 *
 * **It is the venue's, not the vault's, and the difference matters.** The book's replay guard was
 * designed around a `depositRef` minted inside `MandateVault.deposit`; the buyer deposits from
 * their own wallet and this service only ever reads `balanceOf`, so that reference is never
 * observed here. Deriving one from the mandate and its new cumulative total keeps the guard doing
 * something real — this venue cannot credit the same funding state twice — while establishing
 * nothing about the vault having minted a deposit. Reading it as the stronger claim would be
 * replay protection removed while it still looks present.
 */
export const depositRefFor = (mandateUuid: string, totalCommittedMinor: bigint): `0x${string}` =>
  keccak256(toHex(`facture.funding.v1:${mandateUuid}:${totalCommittedMinor.toString(10)}`));

export interface MatchPreview {
  /** False when no book is configured, the mandate was never posted, or the node did not answer. */
  readonly checked: boolean;
  /** The chain's verdict. `null` when `checked` is false — never folded into `false`. */
  readonly ok: boolean | null;
  /** The chain's refusal, from the same vocabulary the venue's own refusals use. */
  readonly code: string | null;
  /** The book's own price, in cents. It may differ from the venue's by rounding — see below. */
  readonly priceMinor: string | null;
  readonly tenorDays: number | null;
  readonly detail: string;
}

export interface PostedMandate {
  readonly chainMandateId: string;
  readonly transactionHash: string;
}

export interface MandateBook {
  readonly enabled: boolean;
  readonly address: string | null;
  /** The account this service signs with, and therefore the only `funder` it can honestly name. */
  readonly operatorAddress: string | null;
  postMandate(params: {
    minRating: Rating;
    maxTenorDays: number;
    annualisedYieldBps: number;
    maxPerDebtorMinor: bigint;
  }): Promise<PostedMandate>;
  creditFunding(params: {
    chainMandateId: bigint;
    funder: string;
    amountMinor: bigint;
    depositRef: `0x${string}`;
  }): Promise<{ transactionHash: string }>;
  isDepositCredited(depositRef: `0x${string}`): Promise<boolean>;
  /**
   * `chainMandateId` is nullable because most callers hold a mandate row, and a row that was
   * never posted is the commonest reason the chain has nothing to say. Answering `checked:
   * false` here keeps that decision in one place instead of at every call site, where the
   * temptation is to treat "not posted" as "would refuse".
   */
  previewMatch(invoiceUuid: string, chainMandateId: bigint | null): Promise<MatchPreview>;
}

export function createDisabledMandateBook(): MandateBook {
  const refuse = (what: string): Promise<never> =>
    Promise.reject(
      badRequest(
        `${what} needs the mandate book. HEDERA_MANDATE_BOOK_ADDRESS is not set, so this ` +
          "venue's match decisions are visible only inside this database.",
      ),
    );

  return {
    enabled: false,
    address: null,
    operatorAddress: null,
    postMandate: () => refuse('Posting a mandate on chain'),
    creditFunding: () => refuse('Crediting funding on chain'),
    isDepositCredited: () => Promise.resolve(false),
    previewMatch: () =>
      Promise.resolve({
        checked: false,
        ok: null,
        code: null,
        priceMinor: null,
        tenorDays: null,
        detail: 'No mandate book is configured, so the chain was not asked about this match.',
      }),
  };
}

export interface MandateBookConfig {
  readonly bookAddress?: string | undefined;
  readonly operatorKey: string;
  readonly logger?: Logger | undefined;
}

export function createMandateBook(config: MandateBookConfig): MandateBook {
  if (config.bookAddress === undefined) return createDisabledMandateBook();

  const address = config.bookAddress as `0x${string}`;
  const log = (config.logger ?? rootLogger).child({ svc: 'mandate-book' });
  const reader = createPublicClient({ transport: http(hedera.jsonRpcUrl) });

  const account = privateKeyToAccount(
    (config.operatorKey.startsWith('0x')
      ? config.operatorKey
      : `0x${config.operatorKey}`) as `0x${string}`,
  );
  const wallet = () => createWalletClient({ account, transport: http(hedera.jsonRpcUrl) });

  /**
   * Submit and wait. `writeContract` returns once a transaction is ACCEPTED, so a revert comes
   * back as a perfectly good hash — the trap that made a second uniqueness claim look like a
   * success, and the one `deployBond` set before it.
   */
  const send = async (hash: `0x${string}`, what: string) => {
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw badRequest(`${what} reverted on chain. Transaction ${hash}.`);
    }
    return receipt;
  };

  return {
    enabled: true,
    address,
    operatorAddress: account.address,

    async postMandate(params) {
      const hash = await wallet().writeContract({
        address,
        abi: ABI,
        functionName: 'postMandate',
        args: [
          ratingOrdinal(params.minRating),
          params.maxTenorDays,
          params.annualisedYieldBps,
          params.maxPerDebtorMinor,
        ],
        chain: null,
        gas: POST_GAS,
      });
      const receipt = await send(hash, 'Posting the mandate');

      /*
       * The id comes from the event, not from a `mandateCount()` read afterwards. The counter is
       * shared state and anyone may call `postMandate`, so reading it back could name a mandate
       * this venue did not create — the same class of mistake as taking a security id from
       * `contractFunctionResult.contractId`, which recorded the factory as the instrument for
       * every invoice.
       */
      const posted = receipt.logs
        .filter((entry) => entry.address.toLowerCase() === address.toLowerCase())
        .map((entry) => {
          try {
            return decodeMandatePosted(entry.topics, account.address);
          } catch {
            return null;
          }
        })
        .find((value): value is bigint => value !== null);

      if (posted === undefined) {
        throw badRequest(
          `The mandate was posted in ${hash} but no MandatePosted log names its id, so the ` +
            'venue cannot address it on the book afterwards.',
        );
      }

      return { chainMandateId: posted.toString(10), transactionHash: hash };
    },

    async creditFunding(params) {
      const hash = await wallet().writeContract({
        address,
        abi: ABI,
        functionName: 'creditFunding',
        args: [
          params.chainMandateId,
          params.funder as `0x${string}`,
          params.amountMinor,
          params.depositRef,
        ],
        chain: null,
        gas: CREDIT_GAS,
      });
      await send(hash, 'Crediting the funding');
      return { transactionHash: hash };
    },

    isDepositCredited(depositRef) {
      return reader.readContract({
        address,
        abi: ABI,
        functionName: 'isDepositCredited',
        args: [depositRef],
      }) as Promise<boolean>;
    },

    async previewMatch(invoiceUuid, chainMandateId) {
      if (chainMandateId === null) {
        return {
          checked: false,
          ok: null,
          code: null,
          priceMinor: null,
          tenorDays: null,
          detail:
            'This mandate has never been posted to the book, so there is nothing on chain to ' +
            'ask about. That is not a refusal.',
        };
      }

      try {
        const [ok, reasonCode, price, tenorDays] = (await reader.readContract({
          address,
          abi: ABI,
          functionName: 'previewMatch',
          args: [registryId(invoiceUuid), chainMandateId],
        })) as readonly [boolean, `0x${string}`, bigint, number];

        const code = decodeReason(reasonCode);
        return {
          checked: true,
          ok,
          code: ok ? null : code,
          priceMinor: price.toString(10),
          tenorDays: Number(tenorDays),
          detail: ok
            ? `The book would take this match at ${price.toString(10)} over ${tenorDays} days.`
            : `The book would refuse this match: ${code}.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('mandate book preview failed', { address, err });
        return {
          checked: false,
          ok: null,
          code: null,
          priceMinor: null,
          tenorDays: null,
          detail: `The mandate book could not be read (${message}), so the chain was not asked.`,
        };
      }
    },
  };
}

/**
 * `MandatePosted(uint256 indexed mandateId, address indexed buyer, ...)`.
 *
 * Both interesting fields are indexed, so the id is topic 1 and the buyer topic 2 — no data decode
 * needed, and the buyer check is what makes this a log about a mandate THIS venue posted rather
 * than any mandate posted in the same block.
 */
const MANDATE_POSTED_TOPIC = keccak256(
  toHex('MandatePosted(uint256,address,uint8,uint32,uint16,uint128)'),
);

function decodeMandatePosted(topics: readonly `0x${string}`[], expectedBuyer: string): bigint {
  const [signature, idTopic, buyerTopic] = topics;
  if (signature !== MANDATE_POSTED_TOPIC || idTopic === undefined || buyerTopic === undefined) {
    throw new Error('not a MandatePosted log');
  }
  const buyer = `0x${buyerTopic.slice(-40)}`.toLowerCase();
  if (buyer !== expectedBuyer.toLowerCase()) {
    throw new Error('MandatePosted names a different buyer');
  }
  return BigInt(idTopic);
}

export interface MandatePosting {
  readonly state:
    | 'disabled'
    | 'already-posted'
    | 'posted'
    | 'out-of-range'
    | 'unavailable'
    | 'not-posted';
  readonly chainMandateId: string | null;
  readonly transactionHash: string | null;
  readonly detail: string;
}

/**
 * Post a mandate to the book if it is not there already, and never throw.
 *
 * Modelled on `ensureMandateRegistered`, for the same reason: writing a mandate is a business act,
 * and a chain that is unreachable must cost the publication rather than the bid. It also has to
 * say so, because an unposted mandate does not fail loudly — `previewMatch` simply has nothing to
 * answer about, and a cross-check that quietly checks nothing is worse than none.
 *
 * **Two honesty notes that belong on the record rather than in a comment nobody reads.**
 *
 * `postMandate` sets `buyer = msg.sender` permanently and offers no transfer path, so the venue is
 * the on-chain buyer of every mandate it posts. The real buyer's Circle wallet transacts on Arc and
 * has no Hedera identity, and Privy has Hedera deliberately undeclared. What the book therefore
 * records is the venue's standing bid on the buyer's behalf, which is what `authoriseRelease` being
 * buyer-only makes unusable here — and is why that call is not wired.
 *
 * The book caps yield at 5000 bps and tenor at 365 days, both narrower than this venue accepts. A
 * mandate outside them is reported `out-of-range` rather than clamped: a clamped mandate would be
 * published on a public book quoting terms its buyer never wrote.
 */
export async function ensureMandatePosted(
  book: MandateBook,
  mandate: {
    id: string;
    chainMandateId: bigint | null;
    ratingFloor: Rating;
    maxTenorDays: number;
    annualisedYieldBps: number;
    exposureLimitMinor: bigint;
    perDebtorLimitMinor: bigint | null;
  },
): Promise<MandatePosting> {
  if (!book.enabled) {
    return {
      state: 'disabled',
      chainMandateId: null,
      transactionHash: null,
      detail:
        'HEDERA_MANDATE_BOOK_ADDRESS is not set, so this mandate is not published on chain and ' +
        'its matches are checkable only against this database.',
    };
  }

  if (mandate.chainMandateId !== null) {
    return {
      state: 'already-posted',
      chainMandateId: mandate.chainMandateId.toString(10),
      transactionHash: null,
      detail: `This mandate is already on the book as ${mandate.chainMandateId.toString(10)}.`,
    };
  }

  const maxPerDebtorMinor = mandate.perDebtorLimitMinor ?? mandate.exposureLimitMinor;
  if (
    mandate.annualisedYieldBps < 1 ||
    mandate.annualisedYieldBps > BOOK_MAX_YIELD_BPS ||
    mandate.maxTenorDays < 1 ||
    mandate.maxTenorDays > BOOK_MAX_TENOR_DAYS ||
    maxPerDebtorMinor <= 0n
  ) {
    return {
      state: 'out-of-range',
      chainMandateId: null,
      transactionHash: null,
      detail:
        `The book accepts 1-${BOOK_MAX_YIELD_BPS} bps over 1-${BOOK_MAX_TENOR_DAYS} days with a ` +
        `non-zero per-debtor cap; this mandate is ${mandate.annualisedYieldBps} bps over ` +
        `${mandate.maxTenorDays} days capped at ${maxPerDebtorMinor.toString(10)}. It is not ` +
        'published rather than published on terms its buyer did not write.',
    };
  }

  try {
    const posted = await book.postMandate({
      minRating: mandate.ratingFloor,
      maxTenorDays: mandate.maxTenorDays,
      annualisedYieldBps: mandate.annualisedYieldBps,
      maxPerDebtorMinor,
    });
    return {
      state: 'posted',
      chainMandateId: posted.chainMandateId,
      transactionHash: posted.transactionHash,
      detail: `Posted to the book as mandate ${posted.chainMandateId}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: 'unavailable',
      chainMandateId: null,
      transactionHash: null,
      detail:
        `The mandate book could not be written (${message}), so this mandate is not published ` +
        'on chain. The bid stands; only the public record of it is missing.',
    };
  }
}

export interface BookFunding {
  readonly state:
    | 'disabled'
    | 'not-posted'
    | 'credited'
    | 'already-credited'
    | 'unavailable'
    | 'nothing-to-credit';
  readonly chainMandateId: string | null;
  readonly transactionHash: string | null;
  readonly detail: string;
}

/**
 * Credit a mandate's committed capital on the book, posting it first if it is not there.
 *
 * Never throws, for the reason funding never throws: the commitment is real whether or not a
 * second record of it landed. Every failure comes back as a state.
 *
 * The book refuses a `depositRef` it has already seen, and `depositRefFor` derives that reference
 * from the mandate and its NEW cumulative total — so re-funding to the same total is refused by
 * the chain rather than double-counted, and a genuine top-up is a different reference. Read
 * `depositRefFor` before trusting that guard for more than it claims.
 */
export async function creditFundingOnBook(
  book: MandateBook,
  mandate: {
    id: string;
    chainMandateId: bigint | null;
    fundedMinor: bigint;
    ratingFloor: Rating;
    maxTenorDays: number;
    annualisedYieldBps: number;
    exposureLimitMinor: bigint;
    perDebtorLimitMinor: bigint | null;
  },
  store: { setChainMandateId(id: string, chainMandateId: bigint, at: Date): Promise<unknown> },
): Promise<BookFunding> {
  if (!book.enabled) {
    return {
      state: 'disabled',
      chainMandateId: null,
      transactionHash: null,
      detail: 'No mandate book is configured, so this commitment is recorded here only.',
    };
  }

  let chainMandateId = mandate.chainMandateId;
  if (chainMandateId === null) {
    const posting = await ensureMandatePosted(book, mandate);
    if (posting.chainMandateId === null) {
      return {
        state: 'not-posted',
        chainMandateId: null,
        transactionHash: null,
        detail: `The commitment is not on the book because the mandate is not. ${posting.detail}`,
      };
    }
    chainMandateId = BigInt(posting.chainMandateId);
    await store.setChainMandateId(mandate.id, chainMandateId, new Date());
  }

  if (mandate.fundedMinor <= 0n) {
    return {
      state: 'nothing-to-credit',
      chainMandateId: chainMandateId.toString(10),
      transactionHash: null,
      detail: 'This mandate commits nothing, so there is nothing to credit on the book.',
    };
  }

  const depositRef = depositRefFor(mandate.id, mandate.fundedMinor);
  try {
    if (await book.isDepositCredited(depositRef)) {
      return {
        state: 'already-credited',
        chainMandateId: chainMandateId.toString(10),
        transactionHash: null,
        detail: 'The book already carries this mandate at exactly this committed total.',
      };
    }

    /*
     * `funder` is the operator, and the book's own event calls that field "who supplied the
     * capital, which need not be the buyer". It is honest here and it is also the only address
     * available: the buyer deposits into the Arc vault from their own wallet, and this service
     * observes a balance rather than a deposit, so there is no Hedera identity for them to
     * name. `depositRefFor` says what that costs the replay guard.
     */
    const { transactionHash } = await book.creditFunding({
      chainMandateId,
      funder: (book.operatorAddress ??
        '0x0000000000000000000000000000000000000000') as `0x${string}`,
      amountMinor: mandate.fundedMinor,
      depositRef,
    });
    return {
      state: 'credited',
      chainMandateId: chainMandateId.toString(10),
      transactionHash,
      detail: `Credited ${mandate.fundedMinor.toString(10)} to mandate ${chainMandateId.toString(10)} on the book.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: 'unavailable',
      chainMandateId: chainMandateId.toString(10),
      transactionHash: null,
      detail:
        `The book could not be credited (${message}). The commitment stands here; only the ` +
        'public record of it is behind.',
    };
  }
}

let book: MandateBook | undefined;

export function setMandateBook(next: MandateBook | undefined): void {
  book = next;
}

export function getMandateBook(): MandateBook {
  book ??= createDisabledMandateBook();
  return book;
}
