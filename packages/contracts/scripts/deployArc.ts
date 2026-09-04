/**
 * Deploy the CASH LEG on Arc testnet.
 *
 *   pnpm --filter @facture/contracts deploy:arc
 *
 * Run this FIRST. `deploy:hedera` needs the vault address this prints, because the book records it
 * as an immutable at construction.
 *
 * What lands here: an Arc-side `DvpEscrow` (the payment leg of the cross-chain swap) and then
 * `MandateVault` (the buyer's escrowed USDC, which never bridges). The book, the gate, the registry
 * and the paper all live on Hedera — see `deployHedera.ts`.
 *
 * ORDER WITHIN THIS SCRIPT MATTERS TOO. The escrow deploys before the vault, because the vault takes
 * it as an immutable and pays every settled trade into it. The whole chain of dependencies runs one
 * way and never doubles back: escrow, then vault, then the Hedera book that records the vault.
 *
 * GAS. Nothing special. Arc has ordinary EVM refund semantics, so an unused limit costs nothing and
 * estimation is the right default — the opposite of Hedera, where the declared limit is close to
 * what you pay. The one Arc-specific constraint is `maxFeePerGas`, pinned at 20 Gwei in
 * `hardhat.config.ts` because anything lower is rejected as "transaction underpriced".
 */

import { network } from 'hardhat';
import { getAddress, type Address } from 'viem';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

// `getAddress` throws on anything malformed, which is the right moment to fail: both values below
// become immutables that can never be corrected.
const requireAddress = (name: string): Address => getAddress(requireEnv(name));

async function main(): Promise<void> {
  // `create()` rather than the deprecated `connect()`. A script connects once, so there is nothing
  // to reuse and no reason for `getOrCreate()`.
  const { viem } = await network.create();

  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  if (deployer === undefined) {
    throw new Error('No wallet client. Check ARC_TESTNET_PRIVATE_KEY is set.');
  }

  const usdc = requireAddress('ARC_USDC_ADDRESS');
  const attester = requireAddress('FACTURE_ATTESTER');
  const owner = requireAddress('FACTURE_OWNER');

  const chainId = await publicClient.getChainId();
  if (chainId !== 5_042_002) {
    throw new Error(`Expected Arc testnet (5042002), connected to ${chainId}.`);
  }

  console.log(`chain     ${chainId}`);
  console.log(`deployer  ${deployer.account.address}`);

  // --- DvpEscrow (payment leg) -----------------------------------------------------------------
  // FIRST, because the vault records it as an immutable: every settled payout leaves the vault into
  // this escrow and nowhere else. The same contract is deployed on Hedera for the delivery leg. The
  // two never communicate; only a preimage crosses. See DvpEscrow.sol for the leg-ordering rule an
  // operator must honour.
  const escrow = await viem.deployContract('DvpEscrow', []);
  console.log(`DvpEscrow     ${escrow.address}`);

  // --- MandateVault ----------------------------------------------------------------------------
  // Holds every mandate's USDC. Its only exits require an authorisation minted by the Hedera book,
  // which is what makes the book's attested balance safe to match against.
  const vault = await viem.deployContract('MandateVault', [usdc, escrow.address, attester, owner]);
  console.log(`MandateVault  ${vault.address}`);

  console.log('\nNext: set FACTURE_MANDATE_VAULT and run deploy:hedera.');
  console.log(`  FACTURE_MANDATE_VAULT=${vault.address}`);
}

await main();
