/**
 * Deploy the BOOK, the GATE and the TWO REGISTRIES on Hedera testnet.
 *
 *   pnpm --filter @facture/contracts deploy:hedera
 *
 * Run `deploy:arc` FIRST and set `FACTURE_MANDATE_VAULT` from its output. The book records the
 * vault's chain id and address as immutables, and they cannot be corrected afterwards.
 *
 * Why these contracts are here and the capital is not: compliance has to be exactly right at the
 * instant of matching, so the book sits beside the ATS paper and `staticcall`s the instrument's own
 * facets. A funded balance does not have to be live — only the buyer can move it — so the USDC
 * stays on Arc and the book holds an attested view. See MandateBook.sol and MandateVault.sol.
 *
 * ---------------------------------------------------------------------------------------------
 * GAS ON HEDERA — why every call below carries an explicit limit
 * ---------------------------------------------------------------------------------------------
 *
 * Hedera bills close to the gas limit a transaction DECLARES, not the amount it consumes. On
 * Ethereum, unused gas is refunded, so the habit is to set a generous limit and stop thinking about
 * it. Here that habit is a straight overspend on every transaction, forever.
 *
 * So the network-level default in `hardhat.config.ts` is 9,000,000 — sized for the heaviest call
 * the venue makes, ATS's `Factory.deployBond` at a measured 6,978,091 gas — and every call in this
 * script that is NOT that heavy overrides it downward. Deploying `UniquenessRegistry` at a 9M limit
 * would cost roughly nine times what it should.
 *
 * The measured figures the numbers below are sized against: role grant ~180k, KYC grant ~190k, mint
 * ~465k, warm transfer ~254k, `deployBond` 6.98M.
 *
 * TODO(deployment): this script deploys and wires. It does not yet
 *   - verify contracts on HashScan,
 *   - write an addresses manifest for the other packages to import,
 *   - associate the deployer with HTS USDC, which every receiver must do before it can be paid.
 * The HTS association step is not optional on Hedera and is the failure that broke the reference
 * x402 proof of concept until it was added explicitly.
 */

import { network } from 'hardhat';
import { getAddress, type Address } from 'viem';

// --- gas limits, per call class ----------------------------------------------------------------
// Deliberately explicit rather than 'auto'. Estimation over the Hashio relay is not always reliable,
// and an underestimate on Hedera fails the transaction while still being billed.
const GAS = {
  /**
   * Small, storage-light constructors: UniquenessRegistry, InvoiceRegistry, AtsComplianceGate,
   * DvpEscrow. Sized off the class's largest runtime bytecode — InvoiceRegistry at 5,075 bytes, so
   * ~1.02M in code deposit alone at 200 gas/byte, against DvpEscrow's 4,412 — plus intrinsic,
   * calldata and a two-slot constructor. Roughly 20% headroom, which is the right side of a limit
   * Hedera bills whether it is used or not.
   */
  deploySmall: 1_500_000n,
  /**
   * MandateBook: six immutables, several mappings, the largest of the venue's own contracts.
   *
   * Sized off the **code deposit**, which dominates and is easy to forget: EVM charges 200
   * gas per byte of deployed bytecode, and MandateBook is 15,052 bytes — 3,010,400 gas
   * before the constructor executes a single opcode. A 3,000,000 limit therefore could not
   * deploy it under any circumstances, and failed on Hedera with INSUFFICIENT_GAS having
   * burned exactly its limit. 5,000,000 covers the deposit plus constructor with ~40%
   * headroom, and an unused limit is refunded on Hedera anyway — though note the *balance*
   * must still cover `gasLimit x gasPrice` up front.
   */
  deployBook: 5_000_000n,
  /** Role grants and setter calls. Measured at ~180k on ATS; 300k leaves comfortable headroom. */
  adminCall: 300_000n,
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

const requireAddress = (name: string): Address => getAddress(requireEnv(name));

function optionalAddress(name: string): Address | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : getAddress(value);
}

async function main(): Promise<void> {
  // `create()` rather than the deprecated `connect()`.
  const { viem } = await network.create();

  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  if (deployer === undefined) {
    throw new Error(
      'No wallet client. Check HEDERA_TESTNET_PRIVATE_KEY is set and is an ECDSA key.',
    );
  }

  const owner = requireAddress('FACTURE_OWNER');
  const attester = requireAddress('FACTURE_ATTESTER');
  /*
   * Every contract here can be reused rather than redeployed, and until 2026-09-06 only one could.
   *
   * That was not a missing convenience, it was a live hazard. `UniquenessRegistry` holds the
   * venue's claims permanently and the comment on step 1 has always said it must outlive a book
   * upgrade — while the code below redeployed it unconditionally. Any second run of this script
   * would have minted an empty registry, and the backend's `HEDERA_UNIQUENESS_REGISTRY_ADDRESS`
   * would either keep pointing at the old one (making the deploy a no-op nobody noticed) or be
   * updated to the new one, silently abandoning every receivable ever claimed.
   *
   * With these, a redeploy is per-contract. Correcting the compliance gate — which shipped probing
   * three ATS selectors that do not exist, and refused every buyer on every instrument — is a
   * one-contract deployment plus the `setComplianceGate` rewire in step 6, and nothing else moves.
   */
  const existingUniquenessRegistry = optionalAddress('FACTURE_UNIQUENESS_REGISTRY');
  const existingInvoiceRegistry = optionalAddress('FACTURE_INVOICE_REGISTRY');
  const existingComplianceGate = optionalAddress('FACTURE_COMPLIANCE_GATE');
  const existingDeliveryEscrow = optionalAddress('FACTURE_DELIVERY_ESCROW');
  const existingMandateBook = optionalAddress('FACTURE_MANDATE_BOOK');
  const cashLegVault = requireAddress('FACTURE_MANDATE_VAULT');
  const cashLegChainId = BigInt(process.env.FACTURE_CASH_LEG_CHAIN_ID ?? '5042002');
  const settlementWindow = BigInt(process.env.FACTURE_SETTLEMENT_WINDOW ?? '259200');

  console.log(`chain      ${await publicClient.getChainId()}`);
  console.log(`deployer   ${deployer.account.address}`);
  console.log(`owner      ${owner}`);
  console.log(`cash leg   ${cashLegVault} on chain ${cashLegChainId}`);

  // --- 1. UniquenessRegistry ---------------------------------------------------------------------
  // First, and independent of everything else. It is intended to outlive the rest of the venue, so
  // it is never redeployed alongside a book upgrade — set `FACTURE_UNIQUENESS_REGISTRY` on every run
  // after the first. A fresh one here is an empty one, and a receivable claimed against the old
  // registry is not claimed against this one.
  let uniquenessRegistry: Address;
  if (existingUniquenessRegistry === undefined) {
    const deployed = await viem.deployContract('UniquenessRegistry', [owner], {
      gas: GAS.deploySmall,
    });
    uniquenessRegistry = deployed.address;
    console.log(`UniquenessRegistry  ${uniquenessRegistry}`);
  } else {
    uniquenessRegistry = existingUniquenessRegistry;
    console.log(
      `UniquenessRegistry  ${uniquenessRegistry}  (reused, from FACTURE_UNIQUENESS_REGISTRY)`,
    );
  }

  // --- 2. InvoiceRegistry ------------------------------------------------------------------------
  // The source of invoice truth the book reads before it allows a match. It takes the uniqueness
  // registry as an immutable — listing verifies that the receivable was actually claimed against the
  // instrument being listed — so it deploys after it and before the book, which records it as an
  // immutable in turn.
  //
  // `FACTURE_INVOICE_REGISTRY` is an OPTIONAL override, for pointing a fresh book at a registry that
  // already holds a listed book of paper. Left unset, a new one is deployed here. It is never the
  // mock: `MockInvoiceRegistry.setInvoice` has no access control, so deploying it would let anyone
  // assert an `A` rating on a defaulted debtor and have the book price, match and settle it.
  let invoiceRegistry: Address;
  if (existingInvoiceRegistry === undefined) {
    const deployed = await viem.deployContract('InvoiceRegistry', [owner, uniquenessRegistry], {
      gas: GAS.deploySmall,
    });
    invoiceRegistry = deployed.address;
    console.log(`InvoiceRegistry     ${invoiceRegistry}`);

    // The attester relays invoice facts — listing, debtor confirmation, earned ratings. Nothing else
    // may write. Granted here only when the deployer owns the registry it just deployed; otherwise
    // it is printed with the rest of the wiring below.
    if (getAddress(deployer.account.address) === owner) {
      await deployed.write.setAttester([attester, true], { gas: GAS.adminCall });
      console.log(`attester granted    ${attester}`);
    }
  } else {
    invoiceRegistry = existingInvoiceRegistry;
    console.log(`InvoiceRegistry     ${invoiceRegistry}  (reused, from FACTURE_INVOICE_REGISTRY)`);
  }

  // --- 3. AtsComplianceGate ----------------------------------------------------------------------
  // Stateless and immutable; one instance serves every instrument the venue lists. Must be on this
  // chain, because it staticcalls into the securities' diamonds directly.
  //
  // It is also the one contract here most likely to need replacing on its own, because it is the
  // only one coupled to a third party's selectors. The book holds it as a MUTABLE reference for
  // exactly that reason, so a corrected gate is a deployment plus one owner call — see step 6.
  let complianceGate: Address;
  if (existingComplianceGate === undefined) {
    const deployed = await viem.deployContract('AtsComplianceGate', [], { gas: GAS.deploySmall });
    complianceGate = deployed.address;
    console.log(`AtsComplianceGate   ${complianceGate}`);
  } else {
    complianceGate = existingComplianceGate;
    console.log(`AtsComplianceGate   ${complianceGate}  (reused, from FACTURE_COMPLIANCE_GATE)`);
  }

  // --- 4. DvpEscrow (delivery leg) ---------------------------------------------------------------
  // Before the book, which records it as an IMMUTABLE and reads every settlement proof out of it.
  // The payment-leg twin is deployed on Arc by deployArc.ts. They never communicate.
  //
  // Because the book records it immutably, a fresh escrow beside a reused book is incoherent: the
  // book would still read proofs out of the old one. That combination is refused below rather than
  // deployed and left for someone to discover from a `DeliveryNotProven` they cannot explain.
  let deliveryEscrow: Address;
  if (existingDeliveryEscrow === undefined) {
    const deployed = await viem.deployContract('DvpEscrow', [], { gas: GAS.deploySmall });
    deliveryEscrow = deployed.address;
    console.log(`DvpEscrow           ${deliveryEscrow}`);
  } else {
    deliveryEscrow = existingDeliveryEscrow;
    console.log(`DvpEscrow           ${deliveryEscrow}  (reused, from FACTURE_DELIVERY_ESCROW)`);
  }

  // --- 5. MandateBook ----------------------------------------------------------------------------
  // `settlementWindow` MUST exceed DvpEscrow's MAX_LOCK_DURATION. If it did not, the book could
  // release an allocation while the delivery leg was still claimable — paying nobody and handing
  // the buyer the bond for free. The constructor enforces this too; the check is repeated here only
  // to fail with a message that names the environment variable rather than with `InvalidTerms`.
  const escrowContract = await viem.getContractAt('DvpEscrow', deliveryEscrow);
  const maxLockDuration = await escrowContract.read.MAX_LOCK_DURATION();
  if (settlementWindow <= BigInt(maxLockDuration)) {
    throw new Error(
      `FACTURE_SETTLEMENT_WINDOW (${settlementWindow}) must exceed ` +
        `DvpEscrow.MAX_LOCK_DURATION (${maxLockDuration}).`,
    );
  }

  let mandateBookAddress: Address;
  if (existingMandateBook !== undefined) {
    mandateBookAddress = existingMandateBook;
    console.log(`MandateBook         ${mandateBookAddress}  (reused, from FACTURE_MANDATE_BOOK)`);

    /*
     * The book's registry and escrow are immutables. Reusing a book while deploying a fresh one of
     * either produces a deployment whose parts do not refer to each other, and the failure would
     * arrive much later as an unexplainable `INVOICE_UNKNOWN` or `DeliveryNotProven`. Read what the
     * book actually points at and refuse the mismatch here.
     */
    const existing = await viem.getContractAt('MandateBook', mandateBookAddress);
    const [boundRegistry, boundEscrow] = await Promise.all([
      existing.read.invoiceRegistry(),
      existing.read.deliveryEscrow(),
    ]);
    if (getAddress(boundRegistry) !== getAddress(invoiceRegistry)) {
      throw new Error(
        `MandateBook ${mandateBookAddress} is bound to InvoiceRegistry ${boundRegistry}, not ` +
          `${invoiceRegistry}. That reference is immutable — set FACTURE_INVOICE_REGISTRY to the ` +
          `bound one, or drop FACTURE_MANDATE_BOOK to deploy a book against this registry.`,
      );
    }
    if (getAddress(boundEscrow) !== getAddress(deliveryEscrow)) {
      throw new Error(
        `MandateBook ${mandateBookAddress} is bound to DvpEscrow ${boundEscrow}, not ` +
          `${deliveryEscrow}. That reference is immutable — set FACTURE_DELIVERY_ESCROW to the ` +
          `bound one, or drop FACTURE_MANDATE_BOOK to deploy a book against this escrow.`,
      );
    }
  } else {
    const deployed = await viem.deployContract(
      'MandateBook',
      [
        invoiceRegistry,
        complianceGate,
        deliveryEscrow,
        owner,
        attester,
        cashLegChainId,
        cashLegVault,
        settlementWindow,
      ],
      { gas: GAS.deployBook },
    );
    mandateBookAddress = deployed.address;
    console.log(`MandateBook         ${mandateBookAddress}`);
  }

  const mandateBook = await viem.getContractAt('MandateBook', mandateBookAddress);
  const uniquenessContract = await viem.getContractAt('UniquenessRegistry', uniquenessRegistry);

  // --- 6. Wiring ---------------------------------------------------------------------------------
  //
  // Authority comes from the contract, not from `FACTURE_OWNER`.
  //
  // The env names who the owner was MEANT to be at the last deployment; the chain records who it
  // actually is. Those disagree on this deployment — the live book's `owner()` is the operator key
  // while `FACTURE_OWNER` names a different address — and comparing against the env skipped every
  // wiring call with a message saying to run them from a key that has no rights over the book.
  // A freshly deployed contract has the env's owner by construction, so reading the chain is
  // correct in both cases and only ever more correct in one.
  const bookOwner = await mandateBook.read.owner();
  const deployerAddress = getAddress(deployer.account.address);
  if (existingMandateBook !== undefined && getAddress(bookOwner) !== owner) {
    console.log(
      `\nNOTE: MandateBook.owner() is ${bookOwner}, not FACTURE_OWNER (${owner}). ` +
        `Wiring follows the chain.`,
    );
  }

  if (deployerAddress !== getAddress(bookOwner)) {
    console.log('\nDeployer does not own the book; skipping wiring. Run these from the owner key:');
    console.log(`  uniquenessRegistry.setIssuer(<issuer>, true)`);
    console.log(
      `  invoiceRegistry.setAttester(${attester}, true)   # nothing lists until this runs`,
    );
    console.log(`  mandateBook.setComplianceGate(${complianceGate})`);
    console.log(`  mandateBook.setMatcher(<matcher>, true)`);
    console.log(`  mandateBook.setSettler(<keeper>, true)   # early cancel only`);
    return;
  }

  /*
   * Point the book at the gate this run resolved, whether that gate is new or reused.
   *
   * This is the step that makes a gate-only redeploy mean anything. `_complianceGate` is the book's
   * one mutable dependency, and MandateBook.sol says why: a bad gate can approve ineligible buyers
   * but cannot touch escrowed capital, so it is the reference worth being able to correct. A fresh
   * gate the book was never told about is a deployment that changed nothing.
   *
   * Comparing what the book holds against what this run resolved — rather than tracking whether the
   * gate was freshly deployed — makes the call idempotent, so a rerun after a failed repoint fixes
   * it instead of deploying a third gate.
   */
  const boundGate = await mandateBook.read.complianceGate();
  if (getAddress(boundGate) === getAddress(complianceGate)) {
    console.log(`gate already bound  ${complianceGate}`);
  } else {
    await mandateBook.write.setComplianceGate([complianceGate], { gas: GAS.adminCall });
    console.log(`gate repointed      ${boundGate} -> ${complianceGate}`);
  }

  // NOTE: the escrow is NOT granted the settler role, and does not need one. Settlement is proven
  // rather than asserted — `confirmSettlement` reads a claimed lock out of the escrow and takes no
  // role at all — so the escrow is a contract the book reads, never a caller. The settler role that
  // remains is narrower than its name: it can only cancel an open match before its window elapses.
  const settler = optionalAddress('FACTURE_SETTLER');
  if (settler !== undefined) {
    await mandateBook.write.setSettler([settler, true], { gas: GAS.adminCall });
    console.log(`settler granted     ${settler}`);
  }

  const issuer = optionalAddress('FACTURE_ISSUER');
  if (issuer !== undefined) {
    await uniquenessContract.write.setIssuer([issuer, true], { gas: GAS.adminCall });
    console.log(`issuer granted      ${issuer}`);
  }

  const matcher = optionalAddress('FACTURE_MATCHER');
  if (matcher !== undefined) {
    await mandateBook.write.setMatcher([matcher, true], { gas: GAS.adminCall });
    console.log(`matcher granted     ${matcher}`);
  }

  // The attester must now be pointed at these contracts off-chain. It has two jobs here: it relays
  // invoice facts into InvoiceRegistry (listing, debtor confirmation, earned ratings), and it carries
  // the cash leg across — watching MandateVault.Deposited on Arc and calling MandateBook.creditFunding
  // here, then watching ReleaseAuthorised and PayoutAuthorised here and calling the vault's execute*
  // on Arc.
  console.log('\nDone. Start the attester relay against both addresses.');
}

await main();
