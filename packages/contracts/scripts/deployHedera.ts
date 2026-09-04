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
  /** MandateBook: six immutables, several mappings, the largest of the venue's own contracts. */
  deployBook: 3_000_000n,
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
  const existingInvoiceRegistry = optionalAddress('FACTURE_INVOICE_REGISTRY');
  const cashLegVault = requireAddress('FACTURE_MANDATE_VAULT');
  const cashLegChainId = BigInt(process.env.FACTURE_CASH_LEG_CHAIN_ID ?? '5042002');
  const settlementWindow = BigInt(process.env.FACTURE_SETTLEMENT_WINDOW ?? '259200');

  console.log(`chain      ${await publicClient.getChainId()}`);
  console.log(`deployer   ${deployer.account.address}`);
  console.log(`owner      ${owner}`);
  console.log(`cash leg   ${cashLegVault} on chain ${cashLegChainId}`);

  // --- 1. UniquenessRegistry ---------------------------------------------------------------------
  // First, and independent of everything else. It is intended to outlive the rest of the venue, so
  // it is deployed on its own and never redeployed alongside a book upgrade.
  const uniquenessRegistry = await viem.deployContract('UniquenessRegistry', [owner], {
    gas: GAS.deploySmall,
  });
  console.log(`UniquenessRegistry  ${uniquenessRegistry.address}`);

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
    const deployed = await viem.deployContract(
      'InvoiceRegistry',
      [owner, uniquenessRegistry.address],
      { gas: GAS.deploySmall },
    );
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
  const complianceGate = await viem.deployContract('AtsComplianceGate', [], {
    gas: GAS.deploySmall,
  });
  console.log(`AtsComplianceGate   ${complianceGate.address}`);

  // --- 4. DvpEscrow (delivery leg) ---------------------------------------------------------------
  // Before the book, which records it as an immutable and reads every settlement proof out of it.
  // The payment-leg twin is deployed on Arc by deployArc.ts. They never communicate.
  const dvpEscrow = await viem.deployContract('DvpEscrow', [], { gas: GAS.deploySmall });
  console.log(`DvpEscrow           ${dvpEscrow.address}`);

  // --- 5. MandateBook ----------------------------------------------------------------------------
  // `settlementWindow` MUST exceed DvpEscrow's MAX_LOCK_DURATION. If it did not, the book could
  // release an allocation while the delivery leg was still claimable — paying nobody and handing
  // the buyer the bond for free. The constructor enforces this too; the check is repeated here only
  // to fail with a message that names the environment variable rather than with `InvalidTerms`.
  const maxLockDuration = await dvpEscrow.read.MAX_LOCK_DURATION();
  if (settlementWindow <= BigInt(maxLockDuration)) {
    throw new Error(
      `FACTURE_SETTLEMENT_WINDOW (${settlementWindow}) must exceed ` +
        `DvpEscrow.MAX_LOCK_DURATION (${maxLockDuration}).`,
    );
  }

  const mandateBook = await viem.deployContract(
    'MandateBook',
    [
      invoiceRegistry,
      complianceGate.address,
      dvpEscrow.address,
      owner,
      attester,
      cashLegChainId,
      cashLegVault,
      settlementWindow,
    ],
    { gas: GAS.deployBook },
  );
  console.log(`MandateBook         ${mandateBook.address}`);

  // --- 6. Wiring ---------------------------------------------------------------------------------
  // Only runs when the deployer is also the owner. On a real deployment the owner is a separate key
  // and these calls are made from it afterwards.
  if (getAddress(deployer.account.address) !== owner) {
    console.log('\nDeployer is not the owner; skipping wiring. Run these from the owner key:');
    console.log(`  uniquenessRegistry.setIssuer(<issuer>, true)`);
    console.log(
      `  invoiceRegistry.setAttester(${attester}, true)   # nothing lists until this runs`,
    );
    console.log(`  mandateBook.setMatcher(<matcher>, true)`);
    console.log(`  mandateBook.setSettler(<keeper>, true)   # early cancel only`);
    return;
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
    await uniquenessRegistry.write.setIssuer([issuer, true], { gas: GAS.adminCall });
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
