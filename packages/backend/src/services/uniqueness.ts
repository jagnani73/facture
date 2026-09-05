/**
 * One receivable, one instrument — enforced on chain rather than in this database.
 *
 * The product's sharpest risk claim is that selling the same receivable to three financiers
 * is the specific fraud factoring has always had, and roughly what broke Greensill. Until now
 * the answer to it was a `UNIQUE` index on `invoices.uniqueness_hash`, and the README had to
 * say so: *"the guarantee is currently the venue's rather than the chain's."*
 *
 * That distinction is the whole point. A unique index stops **this** venue listing a
 * receivable twice. It does nothing about the same invoice being financed here and somewhere
 * else, which is the fraud as it actually happens — the second financier is a different
 * company, not a second row in the first one's table. `UniquenessRegistry` is append-only and
 * has no `release`, so `instrumentOf(h)` answering a non-zero address is a permanent, public
 * statement that this receivable is spoken for, readable by anyone who has not agreed to
 * trust us.
 *
 * ## The venue's hash is what gets claimed
 *
 * The contract offers `computeHash(debtorId, invoiceRef, faceValue)`, and this service does
 * not use it. `claim` takes any `bytes32`, and what is registered is the hash the venue
 * already computed with `@facture/shared`'s `uniquenessHash` — the same value the ISIN is
 * derived from and the unique index is built on.
 *
 * Using the contract's own helper would mint a *second* hash for the same receivable, and the
 * two would agree only by coincidence of encoding. One receivable would then have one hash
 * for the ISIN and another for the registry, which is precisely the divergence that makes a
 * uniqueness guarantee worthless. `sameReceivable` in shared exists for comparing these
 * across the boundary and was written before anything crossed it.
 *
 * ## An unreadable registry does not block onboarding
 *
 * If the registry cannot be reached, the venue falls back to the guarantee it has always had:
 * its own unique index. That is a real reduction in strength and it is reported rather than
 * hidden — `checked: false` is not the same claim as `claimed: false`. Failing closed would
 * mean an RPC outage stops a business listing an invoice, which is a worse trade than
 * briefly relying on the protection that was the only one in place until today.
 */

import { sameReceivable } from '@facture/shared';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hedera } from '../chain.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

const REGISTRY_ABI = parseAbi([
  'function claim(bytes32 uniquenessHash, address instrument)',
  'function instrumentOf(bytes32 uniquenessHash) view returns (address)',
  'function isClaimed(bytes32 uniquenessHash) view returns (bool)',
  'function isIssuer(address account) view returns (bool)',
]);

const ZERO = /^0x0{40}$/i;

/**
 * What the registry says about a receivable.
 *
 * `checked: false` means the chain could not be asked, which is deliberately not the same
 * value as "nobody has claimed it". Collapsing the two would turn an outage into a clean bill
 * of health on the one question the product's fraud argument rests on.
 */
export type UniquenessAnswer = { checked: false } | { checked: true; instrument: string | null };

export interface UniquenessRegistry {
  readonly enabled: boolean;
  /** Never throws: an unreachable registry answers `{ checked: false }`. */
  lookup(uniquenessHash: string): Promise<UniquenessAnswer>;
  claim(uniquenessHash: string, instrument: string): Promise<{ transactionHash: string }>;
}

export interface UniquenessRegistryConfig {
  readonly registryAddress: string | undefined;
  readonly operatorKey: string;
  readonly logger?: Logger | undefined;
}

/** Gas for a `claim`: one SSTORE into an empty slot plus an event. ~50k measured; padded. */
const CLAIM_GAS = 200_000n;

export function createDisabledUniquenessRegistry(): UniquenessRegistry {
  return {
    enabled: false,
    lookup: () => Promise.resolve({ checked: false }),
    claim: () =>
      Promise.reject(
        badRequest(
          'Claiming a receivable needs the uniqueness registry. ' +
            'HEDERA_UNIQUENESS_REGISTRY_ADDRESS is not set, so one-receivable-one-instrument ' +
            'is enforced by this database alone on this deployment.',
        ),
      ),
  };
}

export function createUniquenessRegistry(config: UniquenessRegistryConfig): UniquenessRegistry {
  if (config.registryAddress === undefined) return createDisabledUniquenessRegistry();

  const address = config.registryAddress as `0x${string}`;
  const log = (config.logger ?? rootLogger).child({ svc: 'uniqueness' });
  const reader = createPublicClient({ transport: http(hedera.jsonRpcUrl) });

  return {
    enabled: true,

    async lookup(uniquenessHash) {
      try {
        const instrument = await reader.readContract({
          address,
          abi: REGISTRY_ABI,
          functionName: 'instrumentOf',
          args: [uniquenessHash as `0x${string}`],
        });
        return { checked: true, instrument: ZERO.test(instrument) ? null : instrument };
      } catch (err) {
        log.warn('uniqueness registry unreadable', { uniquenessHash, err });
        return { checked: false };
      }
    },

    async claim(uniquenessHash, instrument) {
      /*
       * The operator's ALIAS, which is what a secp256k1 key produces here and therefore who
       * the contract sees as `msg.sender`. Its long-zero form is a different address to a
       * Solidity mapping, so an issuer grant against that one would authorise nobody — the
       * same trap the ATS role grants hit.
       */
      const account = privateKeyToAccount(
        (config.operatorKey.startsWith('0x')
          ? config.operatorKey
          : `0x${config.operatorKey}`) as `0x${string}`,
      );
      const wallet = createWalletClient({ account, transport: http(hedera.jsonRpcUrl) });

      const hash = await wallet.writeContract({
        address,
        abi: REGISTRY_ABI,
        functionName: 'claim',
        args: [uniquenessHash as `0x${string}`, instrument as `0x${string}`],
        chain: null,
        // Explicit: Hedera reserves gasLimit x gasPrice up front, so an estimate that comes
        // back large is a solvency problem rather than only a cost one.
        gas: CLAIM_GAS,
      });

      /*
       * Wait for the receipt, and refuse to call a reverted transaction a claim.
       *
       * `writeContract` returns as soon as the transaction is accepted for submission, so a
       * `claim` that reverts with `AlreadyClaimed` comes back as a perfectly good hash. This
       * was not hypothetical: the first version of this service reported a second claim on an
       * already-bound receivable as a success, which is the exact failure the registry exists
       * to make impossible — and it would have been reported as "claimed" while the chain said
       * otherwise. It is the `deployBond` lesson in another costume: the call succeeded and
       * the transaction failed.
       */
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw badRequest(
          `Claiming ${uniquenessHash} reverted. The registry is append-only, so the usual ` +
            'cause is that this receivable is already bound to an instrument.',
        );
      }

      log.info('receivable claimed on chain', { uniquenessHash, instrument, hash });
      return { transactionHash: hash };
    },
  };
}

/**
 * Is this receivable already spoken for by an instrument that is not ours?
 *
 * The comparison is `sameReceivable` rather than `===` because hex from a chain call and hex
 * from `keccak256` differ in case and mean the same 32 bytes.
 */
export function claimedByAnother(answer: UniquenessAnswer, ourInstrument: string | null): boolean {
  if (!answer.checked || answer.instrument === null) return false;
  return ourInstrument === null || !sameReceivable(answer.instrument, ourInstrument);
}

let registry: UniquenessRegistry | undefined;

export function initUniquenessRegistry(config: UniquenessRegistryConfig): UniquenessRegistry {
  registry = createUniquenessRegistry(config);
  return registry;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setUniquenessRegistry(next: UniquenessRegistry | undefined): void {
  registry = next;
}

export function getUniquenessRegistry(): UniquenessRegistry {
  if (!registry) throw new Error('Uniqueness registry accessed before initUniquenessRegistry().');
  return registry;
}
