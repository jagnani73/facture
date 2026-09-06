/**
 * The venue's on-chain record of what each listed receivable *is*.
 *
 * `InvoiceRegistry` has been deployed since day one and called by nothing, which left the
 * product's risk argument resting entirely on this database. That argument is specific:
 * debtor confirmation removes dispute risk, and removing dispute risk is what justifies
 * advancing the **full** face value with no holdback. Until now "the debtor confirmed this"
 * was a column only the venue could see, and a buyer had to take it on trust.
 *
 * `isConfirmed(invoiceId)` is a public view. That is the difference.
 *
 * ## Why it is a separate transition and not a flag on listing
 *
 * `list` always writes `Draft` and cannot express `Confirmed` — the contract makes the
 * shortcut unrepresentable rather than merely discouraged. Confirmation is a real-world event
 * that happens later, over a link, and collapsing the two would let the venue assert a
 * confirmation that never happened by writing one field.
 *
 * ## No new disclosure
 *
 * Listing publishes the face value and the due date. Both are **already public**: issuance
 * sets the bond's `maxSupply` to the face value and its maturity to the due date, on a Hedera
 * contract anyone can read. So this adds an index over facts the instrument already carries,
 * rather than exposing a seller's book. The identifiers are opaque — a UUID hashed to
 * `bytes32` — and no customer name, email or refusal reason goes on chain here.
 *
 * ## Listing depends on the uniqueness claim
 *
 * `list` verifies the hash against the venue's `UniquenessRegistry` rather than taking the
 * caller's word, so an invoice cannot be listed here before its receivable is claimed there.
 * That ordering is the contract's, not a convention this service invented, and it is why
 * listing happens after issuance: the claim needs an instrument, and so does this.
 */

import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hedera } from '../chain.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

/**
 * A venue UUID as the registry's `bytes32` key.
 *
 * Hashed rather than zero-padded, so the same derivation works for any venue identifier and
 * an id on chain reveals nothing about the row it points at. It is the same shape used for
 * the Arc vault's mandate key, and carries the same caveat: this id space is the venue's, and
 * anything that later wants to join it to another system's must reconcile rather than assume.
 */
export const registryId = (uuid: string): `0x${string}` => keccak256(toHex(uuid));

/** `FactureTypes.Rating`: D, Unrated, C, B, A. Not alphabetical — `D` is below `Unrated`. */
const RATING_ENUM: Record<string, number> = { D: 0, UNRATED: 1, C: 2, B: 3, A: 4 };

/** `FactureTypes.InvoiceStatus`. Only the transitions this venue drives are named. */
export const INVOICE_STATUS = {
  Unknown: 0,
  Draft: 1,
  Confirmed: 2,
  Matched: 3,
  Settled: 4,
  Repaid: 5,
  Defaulted: 6,
  Cancelled: 7,
} as const;

const REGISTRY_ABI = parseAbi([
  'function list(bytes32 invoiceId, address instrument, bytes32 debtorId, address seller, uint128 faceValue, uint64 dueDate, bytes32 uniquenessHash, uint8 rating)',
  'function setStatus(bytes32 invoiceId, uint8 newStatus)',
  'function isConfirmed(bytes32 invoiceId) view returns (bool)',
  'function isListed(bytes32 invoiceId) view returns (bool)',
]);

export interface ListInvoiceInput {
  invoiceId: string;
  instrument: string;
  debtorId: string;
  seller: string;
  faceValue: bigint;
  /** Invoice due date. The contract refuses one that is not in the future. */
  dueAt: Date;
  uniquenessHash: string;
  rating: string;
}

/**
 * What the chain says about an invoice.
 *
 * `checked: false` is not `listed: false`, for the same reason it is not in the uniqueness
 * registry: an unreachable node is a question unanswered, not a negative answer.
 */
export type RegistryAnswer =
  { checked: false } | { checked: true; listed: boolean; confirmed: boolean };

export interface InvoiceRegistry {
  readonly enabled: boolean;
  /**
   * The contract the answers below come from, so a reader can put the same question to it.
   *
   * Unlike the Arc escrow's address this is configuration rather than something read off a
   * chain, so it is a value and not a promise — there is nothing here to be unreachable and
   * nothing to cache. `null` when no registry is configured: a proof view that linked to an
   * address the venue does not hold would be offering a dead link as its evidence.
   */
  readonly address: string | null;
  /** Never throws. */
  lookup(invoiceId: string): Promise<RegistryAnswer>;
  list(input: ListInvoiceInput): Promise<{ transactionHash: string }>;
  setStatus(invoiceId: string, status: number): Promise<{ transactionHash: string }>;
}

export interface InvoiceRegistryConfig {
  readonly registryAddress: string | undefined;
  readonly operatorKey: string;
  readonly logger?: Logger | undefined;
}

/** `list` writes several slots and reads an external contract; `setStatus` writes one. */
const LIST_GAS = 500_000n;
const STATUS_GAS = 200_000n;

export function createDisabledInvoiceRegistry(): InvoiceRegistry {
  const refuse = (what: string): Promise<never> =>
    Promise.reject(
      badRequest(
        `${what} needs the invoice registry. HEDERA_INVOICE_REGISTRY_ADDRESS is not set, so a ` +
          "receivable's terms and its debtor confirmation live only in this database.",
      ),
    );

  return {
    enabled: false,
    address: null,
    lookup: () => Promise.resolve({ checked: false }),
    list: () => refuse('Listing a receivable on chain'),
    setStatus: () => refuse('Recording a status change on chain'),
  };
}

export function createInvoiceRegistry(config: InvoiceRegistryConfig): InvoiceRegistry {
  if (config.registryAddress === undefined) return createDisabledInvoiceRegistry();

  const address = config.registryAddress as `0x${string}`;
  const log = (config.logger ?? rootLogger).child({ svc: 'invoice-registry' });
  const reader = createPublicClient({ transport: http(hedera.jsonRpcUrl) });

  const wallet = () =>
    createWalletClient({
      account: privateKeyToAccount(
        (config.operatorKey.startsWith('0x')
          ? config.operatorKey
          : `0x${config.operatorKey}`) as `0x${string}`,
      ),
      transport: http(hedera.jsonRpcUrl),
    });

  /**
   * Submit and wait. `writeContract` returns once a transaction is accepted, so a revert
   * comes back as a perfectly good hash — the trap that made a second uniqueness claim look
   * like a success, and the one `deployBond` set before it.
   */
  const send = async (hash: `0x${string}`, what: string): Promise<{ transactionHash: string }> => {
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw badRequest(`${what} reverted on chain. Transaction ${hash}.`);
    }
    return { transactionHash: hash };
  };

  return {
    enabled: true,
    address,

    async lookup(invoiceId) {
      const id = registryId(invoiceId);
      try {
        const [listed, confirmed] = await Promise.all([
          reader.readContract({ address, abi: REGISTRY_ABI, functionName: 'isListed', args: [id] }),
          reader.readContract({
            address,
            abi: REGISTRY_ABI,
            functionName: 'isConfirmed',
            args: [id],
          }),
        ]);
        return { checked: true, listed, confirmed };
      } catch (err) {
        log.warn('invoice registry unreadable', { invoiceId, err });
        return { checked: false };
      }
    },

    async list(input) {
      const rating = RATING_ENUM[input.rating.toUpperCase()];
      if (rating === undefined) {
        throw badRequest(`No on-chain rating corresponds to "${input.rating}".`);
      }

      const hash = await wallet().writeContract({
        address,
        abi: REGISTRY_ABI,
        functionName: 'list',
        args: [
          registryId(input.invoiceId),
          input.instrument as `0x${string}`,
          registryId(input.debtorId),
          input.seller as `0x${string}`,
          input.faceValue,
          BigInt(Math.floor(input.dueAt.getTime() / 1000)),
          input.uniquenessHash as `0x${string}`,
          rating,
        ],
        chain: null,
        gas: LIST_GAS,
      });

      const result = await send(hash, `Listing invoice ${input.invoiceId}`);
      log.info('receivable listed on chain', { invoiceId: input.invoiceId, hash });
      return result;
    },

    async setStatus(invoiceId, status) {
      const hash = await wallet().writeContract({
        address,
        abi: REGISTRY_ABI,
        functionName: 'setStatus',
        args: [registryId(invoiceId), status],
        chain: null,
        gas: STATUS_GAS,
      });

      const result = await send(hash, `Setting status of ${invoiceId}`);
      log.info('invoice status recorded on chain', { invoiceId, status, hash });
      return result;
    },
  };
}

let registry: InvoiceRegistry | undefined;

export function initInvoiceRegistry(config: InvoiceRegistryConfig): InvoiceRegistry {
  registry = createInvoiceRegistry(config);
  return registry;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setInvoiceRegistry(next: InvoiceRegistry | undefined): void {
  registry = next;
}

export function getInvoiceRegistry(): InvoiceRegistry {
  if (!registry) throw new Error('Invoice registry accessed before initInvoiceRegistry().');
  return registry;
}
