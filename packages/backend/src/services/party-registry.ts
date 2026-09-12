/**
 * Relaying what a party signed about itself onto Hedera, and reading it back.
 *
 * `PartyRegistry` is the only contract this venue writes to where **the venue is not the author**.
 * Everywhere else the operator key is the party of record: `MandateBook.postMandate` sets
 * `buyer = msg.sender` permanently, so every standing bid on the public book belongs to Facture
 * rather than to the funder whose capital backs it. That is a known and stated limitation, and it
 * is the one this service exists not to repeat.
 *
 * Here the venue pays and submits, and the EIP-712 signature decides whose record is written. A
 * relayer that alters a single byte produces a signature recovering to a different address, so the
 * forgery writes some stranger's profile instead of the one it was aimed at, and the mismatch
 * against `party` reverts before even that. The venue therefore cannot put words in a party's
 * mouth, and neither can anyone else who gets hold of a signed message.
 *
 * ## Why a relay at all
 *
 * The typical party here holds no gas on any chain. A wallet made from an email address at sign-in
 * has no HBAR on Hedera and no USDC on Arc, and topping up a stranger's wallet before they can
 * introduce themselves is both expensive and the wrong shape — `scripts/demo-reset.mjs` already
 * refuses to send money to addresses it cannot verify, for good reasons that apply here too. So
 * the venue carries the gas and carries none of the authority.
 *
 * ## The rule every chain write in this repo follows
 *
 * A chain write may never fail the user-facing operation. Signing in, writing a profile and
 * correcting one are business acts; an unreachable node costs the on-chain copy, not the act. The
 * orchestrators at the bottom of this file therefore return a `state` rather than throwing, in the
 * shape `services/arc.ts` established — and for the reason it gives: an unregistered mandate fails
 * later, in a contract revert nobody reads, so the answer has to say what happened.
 *
 * `nonceOf` and `relay` throw, because a route relaying an explicit profile update wants the
 * failure. `profileOf` does not — it catches, logs, and answers `{ checked: false }`, which is the
 * read-side half of the same rule. {@link recordProfile} is the never-throwing orchestrator over
 * `relay`. An earlier version of this paragraph said the service methods throw without
 * qualification, which contradicted `profileOf` two screens below it.
 *
 * ## `not-configured` is reachable through the test seam, and not by a deployment
 *
 * `index.ts` wires `HEDERA_DEPLOYMENTS.partyRegistry`, a pinned constant, so `registryAddress` is
 * never `undefined` in anything that boots: there is no backend environment variable for it. The
 * disabled client is therefore exercised by `setPartyRegistry` in tests and nowhere else today.
 *
 * It is kept because the alternative is a service that has to be rewritten the first time the
 * address becomes configurable, and because `GET /v1/parties/:address` is public — a boot order
 * that had not reached `initPartyRegistry` should answer "not checked" rather than 500. What it is
 * not is a description of a live deployment, and the comments around it should not accumulate
 * confidence as though it were.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  recoverTypedDataAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import {
  countryFromBytes2,
  partyRegistryDomain,
  PROFILE_UPDATE_PRIMARY_TYPE,
  PROFILE_UPDATE_TYPES,
  rolesFromBitmask,
  type PartyProfile,
  type ProfileUpdateMessage,
} from '@facture/shared';

import { hedera } from '../chain.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

/**
 * Only what this service calls. The structs are declared inline because viem needs them to encode
 * the tuple, and adding a function here is widening what this service can do rather than
 * documenting the contract.
 */
export const REGISTRY_ABI = parseAbi([
  'struct ProfileUpdate { address party; uint8 roles; string displayName; string legalName; bytes2 country; string websiteUri; bytes32 metadataHash; uint64 nonce; uint64 deadline; }',
  'struct Profile { uint8 roles; bytes2 country; uint64 updatedAt; uint64 nonce; bytes32 metadataHash; string displayName; string legalName; string websiteUri; }',
  'function updateProfileFor(ProfileUpdate update, bytes signature)',
  'function profileOf(address party) view returns (Profile)',
  'function nonceOf(address party) view returns (uint64)',
]);

/**
 * Gas for one relayed profile write.
 *
 * **Measured, not asserted.** A first write carrying all three strings cost **134,962** on Hedera
 * testnet — transaction `0x6e4781dd17dec6b4e27960cafad36fe5498e404fb1fefdee8370558344beeac9`. That
 * record's strings were short enough to pack into one slot each; at the contract's caps of
 * 64/128/128 bytes the dynamic data is about ten further cold slots, so roughly 350,000 is the
 * ceiling this can reach.
 *
 * 450,000 covers that with headroom, and the padding is the cheap direction: on Hedera the fee
 * follows gas *used*, while it is the *balance* that must cover `gasLimit x gasPrice` up front. The
 * estimate this replaced was 600,000, arrived at by counting slots — which is the same reasoning
 * `AtsComplianceGate`'s `PROBE_GAS` was corrected away from, and for the same reason.
 */
const UPDATE_GAS = 450_000n;

/**
 * The contract rejected the update, as a type rather than as a sentence.
 *
 * This was a substring match — `detail.includes('refused that profile update')` — against
 * user-facing prose thrown one function away. Two independent reviews called it the sharpest
 * defect in the service and they were right about why: rewording the sentence, which is exactly
 * the sort of string somebody edits for tone, would silently reclassify **every** contract
 * refusal as an outage, with the whole suite still green. A party with a stale nonce would then
 * be told "nothing was lost, try again in a moment" forever.
 *
 * It also missed half the refusals it was meant to catch. A revert surfaced by the relay at
 * `eth_sendRawTransaction` never reaches the receipt check, so it arrived carrying viem's text
 * and was classified as unreachable.
 *
 * The hash rides on the error rather than only inside the message, because a refusal is the one
 * state where a reader most wants to open the transaction — and it was the one state where the
 * field built for that was null.
 */
export class RegistryRefusal extends Error {
  readonly transactionHash: string | null;

  constructor(detail: string, transactionHash: string | null) {
    super(detail);
    this.name = 'RegistryRefusal';
    this.transactionHash = transactionHash;
  }
}

/** A relayed write, or why there was not one. Flat, because it is rendered on the wire. */
export interface ProfileRecording {
  /**
   * - `recorded` — the chain holds what the party signed.
   * - `not-configured` — no registry is wired on this deployment.
   * - `unavailable` — the node could not be reached, or the write did not confirm. The profile is
   *   still the venue's, and the party can try again; nothing is lost but the public copy.
   * - `refused` — the contract rejected it. A stale nonce and an expired deadline both land here,
   *   and both are the party's to fix by signing again.
   */
  readonly state: 'recorded' | 'not-configured' | 'unavailable' | 'refused';
  readonly transactionHash: string | null;
  /** One sentence naming what happened and what it costs. */
  readonly detail: string;
}

/** A profile read. `checked: false` is a question unanswered, never a party with no record. */
export type ProfileAnswer = { checked: false } | { checked: true; profile: PartyProfile | null };

export interface PartyRegistry {
  readonly enabled: boolean;
  readonly address: Address | null;
  /** The EIP-712 domain a client must sign against, or null when no registry is wired. */
  domain(): ReturnType<typeof partyRegistryDomain> | null;
  /** The nonce this party's next update must carry. Throws when it cannot be read. */
  nonceOf(party: Address): Promise<bigint>;
  profileOf(party: Address): Promise<ProfileAnswer>;
  /** Submits a signed update and waits for its receipt. Throws on anything but success. */
  relay(update: ProfileUpdateMessage, signature: Hex): Promise<{ transactionHash: string }>;
}

export interface PartyRegistryConfig {
  readonly registryAddress: Address | undefined;
  readonly operatorKey: string;
  readonly logger?: Logger | undefined;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The sentence a refusal carries, in one place so the two throw sites cannot drift.
 *
 * It is prose and it is meant to be edited — which is exactly why nothing branches on it any
 * more. {@link RegistryRefusal} is the discriminant now.
 */
const refusalDetail = (hash: string | null): string =>
  `The party registry refused that profile update.${hash === null ? '' : ` Transaction ${hash}.`} ` +
  'A nonce that has since been used, or a deadline that has passed, are the usual reasons — ' +
  'signing again resolves both.';

/**
 * Whether viem is telling us the chain rejected the call, as opposed to not answering.
 *
 * Deliberately a shallow check on viem's own error taxonomy rather than an attempt to decode
 * which custom error fired. `services/arc.ts` already records why the venue does not decode
 * reverts across two ABIs — guessing which contract a selector came from is how a squatted lock
 * id got reported as a vault fault — and the same restraint applies here. What matters to a
 * caller is refused versus unreachable; the transaction hash is the thing they can actually check.
 */
function isRevert(err: unknown): boolean {
  const text = messageOf(err).toLowerCase();
  return (
    text.includes('reverted') ||
    text.includes('execution reverted') ||
    text.includes('contractfunctionreverted')
  );
}

/**
 * Who signed this update, recovered locally, or `null` when the signature is unusable.
 *
 * **This is the venue's authorisation check, and it is the reason the route can write its own
 * rows without waiting to see whether Hedera accepted the transaction.**
 *
 * It did not exist. The contract was the only verifier, so a caller could present a signed-in
 * identity token, sixty-five bytes of nonsense, and any name they liked: the relay reverted,
 * `recordProfile` answered `refused`, and the venue renamed the business anyway and returned 200.
 * The route's own comment claimed the ordering prevented exactly that. It could not — ordering a
 * call that never throws buys nothing, and only a check or a branch does.
 *
 * Recovering here also means a doomed relay is never submitted, so a bad signature costs the
 * operator no gas at all.
 */
export async function recoverProfileSigner(
  update: ProfileUpdateMessage,
  signature: Hex,
  domain: ReturnType<typeof partyRegistryDomain>,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain,
      types: PROFILE_UPDATE_TYPES,
      primaryType: PROFILE_UPDATE_PRIMARY_TYPE,
      message: update,
      signature,
    });
  } catch {
    // A malformed signature is not an exception here, it is the answer: nobody signed this.
    return null;
  }
}

/**
 * The contract's tuple into the shape the rest of the venue reads.
 *
 * Done here, once, because every consumer would otherwise repeat the same three conversions — a
 * bitmask to a role set, `0x0000` to "unstated", a uint64 to an instant — and the third caller to
 * write them would get one wrong.
 */
function toProfile(party: Address, raw: RawProfile): PartyProfile | null {
  if (raw.updatedAt === 0n) return null;

  const { roles, unknownBits } = rolesFromBitmask(raw.roles);

  return {
    address: party,
    roles,
    unknownRoleBits: unknownBits,
    displayName: raw.displayName,
    // Empty is how the contract stores "not stated", and it must not reach a screen as an empty
    // cell that looks like a rendering fault.
    legalName: raw.legalName === '' ? null : raw.legalName,
    country: countryFromBytes2(raw.country),
    websiteUri: raw.websiteUri === '' ? null : raw.websiteUri,
    metadataHash:
      raw.metadataHash === '0x0000000000000000000000000000000000000000000000000000000000000000'
        ? null
        : raw.metadataHash,
    /*
     * `Number` on a `uint64`, deliberately and with a bound in mind. This is a per-party edit
     * counter incremented once per profile write, so 2^53 is not a ceiling anybody reaches; the
     * nonce that must NOT round is the one on the way out, and that one travels as a decimal
     * string from `nonceOf` and is never parsed.
     */
    nonce: Number(raw.nonce),
    updatedAt: instantFrom(raw.updatedAt),
  };
}

/**
 * A `uint64` second count as an ISO instant, refusing rather than producing `Invalid Date`.
 *
 * `new Date(NaN).toISOString()` throws, and this runs inside `profileOf`'s try — so a record with
 * an unreadable timestamp would have surfaced as `checked: false`, "the node would not answer".
 * That is the wrong state for the wrong reason: the node answered, and what it said is the
 * problem. Throwing a named error keeps the two apart.
 */
function instantFrom(seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) {
    throw new Error(`party registry returned an unreadable updatedAt: ${seconds.toString(10)}`);
  }
  return new Date(ms).toISOString();
}

interface RawProfile {
  roles: number;
  country: Hex;
  updatedAt: bigint;
  nonce: bigint;
  metadataHash: Hex;
  displayName: string;
  legalName: string;
  websiteUri: string;
}

export function createPartyRegistry(config: PartyRegistryConfig): PartyRegistry {
  if (config.registryAddress === undefined) return createDisabledPartyRegistry();

  const address = config.registryAddress;
  const log = (config.logger ?? rootLogger).child({ svc: 'party-registry' });
  const reader = createPublicClient({ transport: http(hedera.jsonRpcUrl) });

  const wallet = () =>
    createWalletClient({
      account: privateKeyToAccount(
        (config.operatorKey.startsWith('0x')
          ? config.operatorKey
          : `0x${config.operatorKey}`) as Hex,
      ),
      transport: http(hedera.jsonRpcUrl),
    });

  return {
    enabled: true,
    address,

    domain: () => partyRegistryDomain(hedera.chainId, address),

    async nonceOf(party) {
      return (await reader.readContract({
        address,
        abi: REGISTRY_ABI,
        functionName: 'nonceOf',
        args: [party],
      })) as bigint;
    },

    async profileOf(party) {
      try {
        const raw = (await reader.readContract({
          address,
          abi: REGISTRY_ABI,
          functionName: 'profileOf',
          args: [party],
        })) as RawProfile;
        return { checked: true, profile: toProfile(party, raw) };
      } catch (err) {
        log.warn('party registry unreadable', { party, err });
        return { checked: false };
      }
    },

    async relay(update, signature) {
      let hash: Hex;
      try {
        hash = await wallet().writeContract({
          address,
          abi: REGISTRY_ABI,
          functionName: 'updateProfileFor',
          args: [update, signature],
          chain: null,
          gas: UPDATE_GAS,
        });
      } catch (err) {
        /*
         * A revert can surface here rather than in the receipt — the relay simulates, or the node
         * rejects the call outright — and the previous version let that fall through to the
         * caller's generic handler, where it read as an unreachable node. A party with a stale
         * nonce was told to try again in a moment, which was never going to help.
         */
        if (isRevert(err)) throw new RegistryRefusal(refusalDetail(null), null);
        throw err;
      }

      /*
       * `writeContract` resolves when a transaction is ACCEPTED, not when it succeeded — the revert
       * lands in the receipt. This repo has shipped that bug twice, once on `deployBond` and once on
       * a second uniqueness claim that reported as a success.
       */
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new RegistryRefusal(refusalDetail(hash), hash);
      }

      log.info('party profile recorded on chain', {
        party: update.party,
        nonce: update.nonce.toString(10),
        hash,
      });
      return { transactionHash: hash };
    },
  };
}

export function createDisabledPartyRegistry(): PartyRegistry {
  return {
    enabled: false,
    address: null,
    domain: () => null,
    nonceOf: () =>
      Promise.reject(
        badRequest(
          'No party registry is wired on this deployment, so there is no nonce to sign against ' +
            'and a profile lives only in this database.',
        ),
      ),
    profileOf: () => Promise.resolve({ checked: false }),
    relay: () =>
      Promise.reject(
        badRequest(
          'Recording a profile on chain needs the party registry. None is wired, so what a ' +
            'business says about itself is visible here and nowhere a counterparty can check it.',
        ),
      ),
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Record a signed profile, and never let the chain cost the party their answer.
 *
 * The counterpart of `ensureMandateRegistered` in `services/arc.ts`, and the same reasoning: a
 * business updating its own name is an act that has effectively already happened by the time this
 * runs, and returning an error because a node was unreachable would be inexcusable. What it must
 * not do is stay quiet — a profile the venue believes is public and is not would be a claim on the
 * proof screen with nothing behind it. Hence a state on every answer.
 */
export async function recordProfile(
  registry: PartyRegistry,
  update: ProfileUpdateMessage,
  signature: Hex,
): Promise<ProfileRecording> {
  if (!registry.enabled) {
    return {
      state: 'not-configured',
      transactionHash: null,
      detail:
        'No party registry is wired on this deployment, so this profile is recorded here and ' +
        'cannot be checked against a chain.',
    };
  }

  try {
    const { transactionHash } = await registry.relay(update, signature);
    return {
      state: 'recorded',
      transactionHash,
      detail: 'Signed by this address and recorded on Hedera, where anyone can read it back.',
    };
  } catch (err) {
    /*
     * A revert and an unreachable node are different problems with different fixes, and the party
     * can only act on one of them. The discriminant is a TYPE — see {@link RegistryRefusal} — and
     * was a substring match on the refusal sentence until a review pointed out that rewording the
     * prose would reclassify every refusal as an outage with the suite still green.
     */
    if (err instanceof RegistryRefusal) {
      return {
        state: 'refused',
        // Present on a reverted receipt, absent when the node rejected the call outright. A
        // reader wants it most here, and it used to be null in exactly this case.
        transactionHash: err.transactionHash,
        detail: err.message,
      };
    }

    return {
      state: 'unavailable',
      transactionHash: null,
      detail:
        `The profile is saved here, but Hedera did not confirm the public copy (${messageOf(err)}). ` +
        'Signing again records it; nothing was lost.',
    };
  }
}

/**
 * A party's own description, as the venue reads it back.
 *
 * Three states, never two. "No registry configured", "the node would not answer" and "this address
 * has never written a profile" are different facts, and folding the first two into the third would
 * print a confident absence where there is only an unanswered question — the `/health` cursor
 * mistake, `ComplianceDecision.determinate`, and the proof view's registry block, all over again.
 */
export async function readProfile(
  registry: PartyRegistry,
  party: Address | null,
): Promise<ProfileAnswer> {
  if (party === null) return { checked: false };
  return registry.profileOf(party);
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                   */
/* -------------------------------------------------------------------------- */

let registry: PartyRegistry | undefined;

export function initPartyRegistry(config: PartyRegistryConfig): PartyRegistry {
  registry = createPartyRegistry(config);
  return registry;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setPartyRegistry(next: PartyRegistry | undefined): void {
  registry = next;
}

/**
 * Disabled by default rather than throwing, which is `getMandateBook`'s shape and not the one most
 * services here use.
 *
 * The difference is what an unconfigured deployment means for each. A venue with no ATS factory
 * cannot issue and should say so loudly; a venue with no party registry is simply one where a
 * profile lives in its own database, which is a supported state this module already has an answer
 * for. `GET /v1/parties/:address` is also **public** — no credential, no session — so a boot order
 * that had not reached `initPartyRegistry` would turn a question anyone may ask into a 500 that
 * describes an internal wiring mistake rather than anything about the party.
 *
 * The trade is real and is the reason most services here throw: a deployment that forgot to call
 * `initPartyRegistry` reports `checked: false` and looks like an unreachable node. That is
 * acceptable here precisely because the answer is the same either way — there is no record to
 * read — and it is not acceptable for a service that moves money.
 */
export function getPartyRegistry(): PartyRegistry {
  registry ??= createDisabledPartyRegistry();
  return registry;
}
