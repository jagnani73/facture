import { configVariable, defineConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

/**
 * Hardhat 3 configuration for the Facture venue contracts.
 *
 * Hardhat 3 is ESM-only and requires plugins to be listed explicitly in `plugins` — the implicit
 * side-effect `require` of Hardhat 2 is gone. If a config key below fails to validate, the first
 * thing to check is that the toolbox is actually in that array.
 */
export default defineConfig({
  plugins: [hardhatToolboxViem],

  solidity: {
    profiles: {
      /**
       * The test-loop build. Optimiser settings deliberately IDENTICAL to `production` below.
       *
       * This profile used to be unoptimised, on the usual reasoning that a test loop wants fast
       * compiles. It does not any more, because `MandateBook` compiles to roughly 27KB unoptimised
       * against 15KB optimised, and 24,576 is a hard ceiling on both the simulated test chain and
       * Hedera. An unoptimised profile therefore either cannot deploy the venue's own book at all,
       * or has to be told to ignore the ceiling — and the second is worse than the first, because it
       * means the suite proves a contract works while saying nothing about whether it can be
       * deployed. Keeping the two profiles the same makes the test network's EIP-170 check a real
       * guard on the artifact that actually ships.
       *
       * The cost that reasoning was weighed against turned out to be nothing: a clean build of all
       * 18 files takes about two seconds either way.
       */
      default: {
        version: '0.8.28',
        settings: {
          // Hedera runs the Cancun opcode set, so the venue targets it directly rather than
          // compiling down to Shanghai and leaving performance on the table.
          //
          // If a Hedera JSON-RPC relay release ever rejects a Cancun-only opcode (MCOPY is the one
          // solc emits by default from 0.8.25 onward), the fix is to pin the compiler to 0.8.24
          // rather than to downgrade `evmVersion` — every contract's pragma is `^0.8.24`
          // specifically so that pin remains available without a source change.
          evmVersion: 'cancun',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      // What actually gets deployed. Deploy scripts must pass `--build-profile production`.
      production: {
        version: '0.8.28',
        settings: {
          evmVersion: 'cancun',
          // 200 runs suits contracts that are deployed once and called many times. MandateBook is
          // the hot path — matching runs per invoice — so runtime cost dominates deployment cost.
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },

  networks: {
    // Simulated chain for the test suite.
    hardhatMainnet: {
      type: 'edr-simulated',
      chainType: 'l1',
    },

    /**
     * Hedera testnet, over the Hashio JSON-RPC relay.
     *
     * `chainType: 'generic'` rather than `'l1'`: Hedera is not an Ethereum L1 and does not share its
     * fee-market or hardfork semantics, so the generic chain type is the honest description.
     *
     * ACCOUNTS MUST BE ECDSA. Hedera ED25519 accounts hold HBAR and HTS tokens fine but cannot sign
     * EVM transactions at all, and the failure surfaces late and unhelpfully as `INVALID_SIGNATURE`
     * rather than at key-load time. If a deployment fails that way, the key type is the first thing
     * to check, not the RPC.
     */
    hederaTestnet: {
      type: 'http',
      chainType: 'generic',
      url: 'https://testnet.hashio.io/api',
      chainId: 296,
      accounts: [configVariable('HEDERA_TESTNET_PRIVATE_KEY')],

      /**
       * Transaction gas limit — note the field is `gas` in Hardhat 3, not Hardhat 2's `gasLimit`.
       *
       * WHY 9,000,000 AND NOT HEDERA'S 15,000,000 CEILING.
       *
       * Hedera charges close to the gas limit a transaction DECLARES rather than to what it
       * actually consumes. On Ethereum an over-generous limit is free — unused gas is refunded — so
       * the habit is to set it high and forget. Here that habit is a direct and permanent overspend
       * on every single transaction, and the venue issues one bond per invoice.
       *
       * The number is sized off measurement, not guesswork. `Factory.deployBond` is the heaviest
       * call the venue makes and costs 6,978,091 gas in the repo's default configuration —
       * 8,158,081 in the heaviest configuration that could be constructed. 9,000,000 clears the
       * measured cost by ~29% and the worst constructed case by ~10%, which is enough headroom for
       * facet-count drift between ATS releases without paying for six million units of nothing on
       * every call.
       *
       * Everything else the venue does is far cheaper and does not need this ceiling: a role grant
       * is ~180k, a KYC grant ~190k, a mint ~465k, a warm transfer ~254k. Per-call overrides are
       * the right tool for those — see `scripts/deployHedera.ts`.
       *
       * Corroboration: the ATS repo's own deploy scripts ship `gasLimit: 10_000_000` for this call
       * on both hedera-testnet and hedera-mainnet.
       */
      gas: 9_000_000,
    },

    /**
     * Arc testnet — where the cash leg lives.
     *
     * The buyer's USDC is escrowed here in `MandateVault` and never bridges. Public Arc mainnet
     * lands after ETHOnline submissions close, so nothing may depend on it.
     *
     * The fee is pinned at 20 Gwei because anything below that is rejected outright as
     * "transaction underpriced" — it is a floor, not a tuning knob. The field is `gasPrice` and
     * NOT Hardhat 2's `maxFeePerGas`: Hardhat 3's `HttpNetworkUserConfig` exposes exactly one fee
     * knob (`gas`, `gasMultiplier`, `gasPrice`), and `maxFeePerGas` on it is a type error rather
     * than a silently ignored key.
     *
     * No `gas` override here. Arc has ordinary EVM refund semantics, so unlike Hedera an unused
     * limit costs nothing and estimation is the right default. Gas on Arc is natively USDC, which
     * is also why the Paymaster is redundant and is not wired up.
     */
    arcTestnet: {
      type: 'http',
      chainType: 'generic',
      url: 'https://rpc.testnet.arc.io',
      chainId: 5_042_002,
      accounts: [configVariable('ARC_TESTNET_PRIVATE_KEY')],
      gasPrice: 20_000_000_000n,
    },
  },
});
