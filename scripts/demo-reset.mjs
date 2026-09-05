// One-command demo PROVISIONING: the balances a rehearsal spends, and the vault
// registrations without which a mandate can never be escrowed at all. It does
// NOT touch `facture.db`, and it must not — the book is 29 invoices, 27 trades
// and two proven lifecycles, and it is re-seeded by `pnpm --filter
// @facture/backend db:seed` against an empty database. A reset that quietly
// rewrote settled history would destroy the only evidence this venue has.
//
// These numbers ARE the `// 1.` … `// 7.` markers below:
//   1. reports the RELAYER — the attester key, which is the supply for every
//      transfer under it, and which nothing here can refill (Arc testnet has no
//      faucet this script can call, so a dry relayer is a warning, not a fix)
//   2. tops the SELLER up on Arc — the one balance that blocks a live payout,
//      because `DvpEscrow.claim` requires `msg.sender == beneficiary` and Arc
//      gas is USDC, so a seller holding nothing can be paid and not collect
//   3. tops the BUYER's Circle wallet up — it pays Arc gas and it is the wallet
//      a vault deposit is drawn from
//   4. registers every active mandate on `MandateVault` that is not registered
//      yet — see the note on ordering below; this is the step that turns the
//      Arc rail from a rail with no on-ramp into one a buyer can use
//   5. reports each mandate's escrowed balance against what it would need
//   6. reports the HEDERA side: operator, collection account, and the mirror
//      node — none of which this script can top up, so all three are read-only
//   7. prints the cheat sheet
//
// ORDERING, and it runs opposite to how the steps read in one place:
//   * The relayer is the SUPPLY and steps 2 and 3 are consumers of it. Reporting
//     it afterwards would "discover" an empty key one step too late and the
//     rehearsal would run underfunded anyway. Relayer first, always.
//   * `registerMandate` (4) must precede any deposit, because `MandateVault`
//     reverts `MandateNotRegistered` on a deposit against an unregistered
//     mandate — capital with no way out is capital it refuses. It is also
//     one-shot, so this step reads `buyerOf` first and is a no-op on every run
//     but the first.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not deposit into the vault on the
// buyer's behalf. `deposit` pulls from `msg.sender`, so a relayer-funded deposit
// would credit the mandate with the VENUE's money while `docs/deployments.md`
// records that capital as the buyer's own — a claim worth more than the
// convenience. `--deposit <usdc>` overrides that, and says so in the output,
// because a rehearsal on a fresh vault has to get capital in somehow.
//
// Usage: pnpm demo:reset [--deposit <usdc>]
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const envFile of [
  resolve(repoRoot, 'packages/backend/.env'),
  resolve(repoRoot, 'packages/web/.env.local'),
  resolve(repoRoot, 'packages/agent/.env'),
]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/*
 * viem and better-sqlite3, borrowed from the backend's dependency tree rather
 * than added to the root package.json. `scripts/` is not a workspace package, so
 * a bare `import 'viem'` does not resolve from here — and resolving what the
 * backend already pins is the smallest way to be sure this script and the
 * service agree about ABI encoding and about how the database reads.
 */
const require = createRequire(resolve(repoRoot, 'packages/backend/package.json'));
const {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseAbi,
  formatUnits,
  parseUnits,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const Database = require('better-sqlite3');

/*
 * Chain constants come from `@facture/shared`, not from literals here. The USDC
 * address and its SIX decimals are the numbers this repo has already been bitten
 * by twice — Arc's native gas accounting is 18 for the same balance — so a
 * second copy in a provisioning script is exactly the divergence to avoid.
 */
const { ARC_TESTNET } = await import('../packages/shared/src/chains/arc.ts');

const USDC = ARC_TESTNET.tokens.USDC.address;
const USDC_DECIMALS = ARC_TESTNET.tokens.USDC.decimals;

/** Target balances, as desired state rather than a sequence of transfers. */
const TARGETS = {
  /*
   * The seller only ever pays gas here: it receives its proceeds into the escrow
   * and spends a transaction to claim them. Half a USDC is many claims.
   */
  seller: parseUnits('0.5', USDC_DECIMALS),
  /* The buyer pays Arc gas and funds vault deposits out of the same balance. */
  buyer: parseUnits('2', USDC_DECIMALS),
  /* Below this the relayer cannot cover a rehearsal, and says so. */
  relayerFloor: parseUnits('20', USDC_DECIMALS),
};

const args = process.argv.slice(2);
const depositIndex = args.indexOf('--deposit');
const depositUsdc = depositIndex === -1 ? null : args[depositIndex + 1];

function requireEnv(name, where) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set (expected in ${where})`);
    process.exit(1);
  }
  return value;
}

const relayer = privateKeyToAccount(
  (() => {
    const key = requireEnv('ARC_SETTLEMENT_PRIVATE_KEY', 'packages/backend/.env');
    return key.startsWith('0x') ? key : `0x${key}`;
  })(),
);
const vaultAddress = requireEnv('ARC_MANDATE_VAULT_ADDRESS', 'packages/backend/.env');

const arcChain = {
  id: ARC_TESTNET.chainId,
  name: ARC_TESTNET.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET.rpcUrl] } },
};
const publicClient = createPublicClient({ chain: arcChain, transport: http() });
const relayerClient = createWalletClient({
  chain: arcChain,
  account: relayer,
  transport: http(),
});

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const VAULT = parseAbi([
  'function balanceOf(uint256 mandateId) view returns (uint128)',
  'function buyerOf(uint256 mandateId) view returns (address)',
  'function registerMandate(uint256 mandateId, address buyer)',
  'function deposit(uint256 mandateId, uint128 amount) returns (bytes32)',
]);

/*
 * Arc rejects anything under its own floor as "transaction underpriced", and
 * `minMaxFeePerGasWei` in shared is that floor. Read rather than typed, for the
 * same reason the decimals are.
 */
const FEE = {
  maxFeePerGas: ARC_TESTNET.minMaxFeePerGasWei,
  maxPriorityFeePerGas: 0n,
};

let degraded = false;
const usdc = (amount) => `${Number(formatUnits(amount, USDC_DECIMALS)).toFixed(6)} USDC`;

/**
 * Every write here, and the receipt check none of them may skip.
 *
 * `writeContract` resolves when a transaction is ACCEPTED, not when it
 * succeeded. This repo has shipped that bug twice — a `deployBond` selector and
 * a uniqueness claim both reported a revert as success — so the check is in the
 * helper rather than at each call site.
 */
async function send(params, what) {
  const hash = await relayerClient.writeContract({ ...params, ...FEE });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${what} reverted on Arc in ${hash}`);
  }
  return hash;
}

const balanceOf = (address) =>
  publicClient.readContract({
    address: USDC,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [address],
  });

/**
 * Whether this script is willing to send real money to an address.
 *
 * **Four of the seeded parties' addresses were invented**, and `seed.ts` says so:
 * they are plausible-looking hex that nobody holds a key for. A provisioning
 * script that topped them up would not fail — it would succeed, and quietly burn
 * testnet USDC into addresses no one can ever spend from. So the default is to
 * refuse, and an address has to earn its way past this.
 *
 * EIP-55 is the tripwire that catches them here: all three invented buyer
 * addresses fail their checksum, because whoever made them typed mixed case
 * without computing one, while both real addresses pass. That is a useful
 * accident and NOT a proof — a fabricated address with a correct checksum would
 * sail through — which is why the seller, the account this script most wants to
 * fund, is verified by derivation instead and not by its checksum.
 */
function spendableTo(address) {
  if (!isAddress(address, { strict: true })) {
    return { ok: false, why: 'fails its EIP-55 checksum, so it was typed rather than generated' };
  }
  return { ok: true };
}

/** Tops up toward a target. Never transfers downward — see the note below. */
async function topUp(label, address, target, verified) {
  /*
   * Lowercased for the READ. viem refuses a mixed-case address whose checksum is
   * wrong, and the whole point of the unfundable branch below is to report what
   * such an address holds rather than to crash on it — the balance is a fact even
   * when the address is a fiction.
   */
  const held = await balanceOf(address.toLowerCase());

  if (!verified.ok) {
    /*
     * Reported, never `degraded`. Four of the seeded parties carry invented
     * addresses and `seed.ts` says so — that is the permanent state of the demo
     * book, not a fault someone can fix before rehearsing. Degrading on it would
     * make every run red and teach the reader to ignore the colour, which costs
     * the warnings that DO mean something: a dry relayer, an unfundable seller,
     * an unregistered escrowed mandate.
     */
    return `· ${label.padEnd(20)} ${usdc(held).padStart(18)}  not funded: ${verified.why}`;
  }
  if (held >= target) return `${label.padEnd(22)} ${usdc(held).padStart(18)}  (at target)`;

  /*
   * Only ever upward. A script that pulled balances DOWN to a target could undo
   * a rehearsal someone is halfway through, and it would do it silently — the
   * account would simply be poorer than the demo expected at the moment it was
   * needed.
   */
  const shortfall = target - held;
  try {
    const hash = await send(
      { address: USDC, abi: ERC20, functionName: 'transfer', args: [address, shortfall] },
      `top-up of ${label}`,
    );
    return `${label.padEnd(22)} ${usdc(target).padStart(18)}  (+${usdc(shortfall)}, ${hash.slice(0, 10)}…)`;
  } catch (err) {
    degraded = true;
    return `⚠ ${label.padEnd(20)} ${usdc(held).padStart(18)}  top-up failed: ${err.message}`;
  }
}

const started = Date.now();

// ---------------------------------------------------------------------------
// 1. The relayer. First, because steps 2 and 3 spend what it holds.
// ---------------------------------------------------------------------------
let relayerLine;
{
  const held = await balanceOf(relayer.address);
  relayerLine = `relayer/attester       ${usdc(held).padStart(18)}  ${relayer.address}`;
  if (held < TARGETS.relayerFloor) {
    degraded = true;
    relayerLine =
      `⚠ relayer/attester     ${usdc(held).padStart(18)}  below the ${usdc(TARGETS.relayerFloor)} floor.\n` +
      `                       Nothing here can refill it — fund ${relayer.address} from the Circle faucet.`;
  }
}

// ---------------------------------------------------------------------------
// The demo's parties, read from the book rather than hardcoded, so this script
// cannot drift from whatever the venue actually has on file.
// ---------------------------------------------------------------------------
const dbPath = resolve(
  repoRoot,
  'packages/backend',
  process.env.DATABASE_URL ?? './data/facture.db',
);
const db = new Database(dbPath, { readonly: true });
const sellers = db
  .prepare('select name, arc_address from sellers where arc_address is not null')
  .all();
const buyers = db
  .prepare('select id, name, arc_address from buyers where arc_address is not null')
  .all();
const mandates = db
  .prepare(
    `select m.id, m.buyer_id, m.status, m.funded_minor, b.name as buyer, b.arc_address
     from mandates m join buyers b on b.id = m.buyer_id
     where m.status = 'active' and b.arc_address is not null`,
  )
  .all();
db.close();

// ---------------------------------------------------------------------------
// 2. The seller. THE balance that blocks a live Arc payout: `claim` is
//    beneficiary-only and Arc gas is USDC, so a seller with nothing can be paid
//    into the escrow and then be unable to collect.
// ---------------------------------------------------------------------------
const sellerLines = [];
{
  /*
   * The seller's address is verified by DERIVATION, not by its checksum. Operator
   * and seller are the same account in this build, so the address on file should
   * be exactly what `HEDERA_OPERATOR_KEY` produces — one ECDSA key, the same EVM
   * address on every chain. If they differ, the row was edited or the key was
   * rotated, and money sent there is money nobody can spend.
   */
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  const derived = operatorKey
    ? privateKeyToAccount(operatorKey.startsWith('0x') ? operatorKey : `0x${operatorKey}`).address
    : null;

  for (const s of sellers) {
    const verified =
      derived === null
        ? { ok: false, why: 'HEDERA_OPERATOR_KEY is not set, so this address cannot be verified' }
        : derived.toLowerCase() === s.arc_address.toLowerCase()
          ? { ok: true }
          : {
              ok: false,
              why: `does not match the operator key, which derives ${derived}`,
            };
    // The seller is the exception: this is the balance a live payout depends on,
    // and an address that cannot be verified is one the venue cannot pay.
    if (!verified.ok) degraded = true;
    sellerLines.push(
      await topUp(`seller ${s.name.slice(0, 14)}`, s.arc_address, TARGETS.seller, verified),
    );
  }
}

// ---------------------------------------------------------------------------
// 3. The buyers' wallets. Arc gas, and the balance a vault deposit is drawn
//    from — which is why this is a top-up rather than a deposit (see the header).
// ---------------------------------------------------------------------------
const buyerLines = [];
for (const b of buyers) {
  buyerLines.push(
    await topUp(
      `buyer ${b.name.slice(0, 15)}`,
      b.arc_address,
      TARGETS.buyer,
      spendableTo(b.arc_address),
    ),
  );
}

// ---------------------------------------------------------------------------
// 4. Mandate registration. Without this a mandate can never be escrowed at all:
//    `deposit` reverts `MandateNotRegistered`, so `depositedFor` stays zero, the
//    funding route refuses, and the Arc rail is never selected. One-shot, so it
//    reads `buyerOf` first and is a no-op after the first run.
// ---------------------------------------------------------------------------
const { keccak256, toHex } = require('viem');
const vaultMandateId = (uuid) => BigInt(keccak256(toHex(uuid)));

const mandateLines = [];
for (const m of mandates) {
  const id = vaultMandateId(m.id);
  let registered;
  try {
    registered = await publicClient.readContract({
      address: vaultAddress,
      abi: VAULT,
      functionName: 'buyerOf',
      args: [id],
    });
  } catch (err) {
    degraded = true;
    mandateLines.push(`⚠ ${m.id.slice(0, 8)}  could not read the vault: ${err.message}`);
    continue;
  }

  const isZero = /^0x0{40}$/i.test(registered);
  if (!isZero) {
    const held = await publicClient.readContract({
      address: vaultAddress,
      abi: VAULT,
      functionName: 'balanceOf',
      args: [id],
    });
    const mismatch = registered.toLowerCase() !== m.arc_address.toLowerCase();
    mandateLines.push(
      `${m.id.slice(0, 8)}  ${m.buyer.slice(0, 16).padEnd(16)} ${usdc(held).padStart(18)}  ` +
        (mismatch
          ? `⚠ registered to ${registered}, not the buyer on file — a release would pay the wrong address`
          : 'registered'),
    );
    if (mismatch) degraded = true;
    continue;
  }

  /*
   * `registerMandate` is ONE-SHOT and names the only address a release may ever
   * pay. Binding an invented one is not a mistake that can be corrected — it is a
   * mandate whose capital can never come back out. Refuse rather than register.
   */
  const payable = spendableTo(m.arc_address);
  if (!payable.ok) {
    /*
     * Not degrading, for the same reason the top-ups are not: these are the
     * seeded bids that were never going to be escrowed. What WOULD be worth
     * shouting about is a mandate that already holds capital and cannot be
     * registered — that is money with no way out — and the vault makes that
     * unreachable by refusing the deposit in the first place.
     */
    mandateLines.push(
      `· ${m.id.slice(0, 8)}  ${m.buyer.slice(0, 16).padEnd(16)} not registered: buyer address ${payable.why}`,
    );
    continue;
  }

  try {
    const hash = await send(
      {
        address: vaultAddress,
        abi: VAULT,
        functionName: 'registerMandate',
        args: [id, m.arc_address],
      },
      `registerMandate for ${m.id}`,
    );
    mandateLines.push(
      `${m.id.slice(0, 8)}  ${m.buyer.slice(0, 16).padEnd(16)} ${'—'.padStart(18)}  registered now (${hash.slice(0, 10)}…)`,
    );
  } catch (err) {
    degraded = true;
    mandateLines.push(`⚠ ${m.id.slice(0, 8)}  registerMandate failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Optional: put capital in, from the relayer. Off by default and loud when
//    on, because it credits the mandate with the VENUE's money and the
//    deployment record says that capital is the buyer's own.
// ---------------------------------------------------------------------------
let depositLine = null;
if (depositUsdc !== null) {
  const target = mandates[0];
  if (!target) {
    degraded = true;
    depositLine = '⚠ --deposit given but no active mandate has a buyer address on file';
  } else {
    const amount = parseUnits(depositUsdc, USDC_DECIMALS);
    const id = vaultMandateId(target.id);
    try {
      const { erc20Abi } = require('viem');
      await send(
        { address: USDC, abi: erc20Abi, functionName: 'approve', args: [vaultAddress, amount] },
        'approve for deposit',
      );
      const hash = await send(
        { address: vaultAddress, abi: VAULT, functionName: 'deposit', args: [id, amount] },
        'deposit',
      );
      depositLine =
        `deposited ${usdc(amount)} into ${target.id.slice(0, 8)} FROM THE RELAYER (${hash.slice(0, 10)}…)\n` +
        "           ⚠ this capital is the venue's, not the buyer's. docs/deployments.md records the\n" +
        "             original 5 USDC as deposited by the buyer's own wallet; do not conflate them.";
    } catch (err) {
      degraded = true;
      depositLine = `⚠ deposit failed: ${err.message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Hedera, read-only. Nothing here can mint HBAR, so these are reported and
//    warned on rather than topped up — an honest "go fund this" beats a step
//    that pretends to fix it.
// ---------------------------------------------------------------------------
const hederaLines = [];
{
  const accounts = [
    ['operator / seller', process.env.HEDERA_OPERATOR_ID],
    ['collection account', process.env.MATURITY_COLLECTION_ACCOUNT_ID],
  ].filter(([, id]) => Boolean(id));

  for (const [label, id] of accounts) {
    try {
      const res = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${id}`);
      if (!res.ok) throw new Error(`mirror node answered ${res.status}`);
      const body = await res.json();
      const hbar = Number(body.balance.balance) / 1e8;
      /*
       * One HBAR, not a round-looking five. The collection account's whole job is
       * signing a `ScheduleSign` per matured receivable, which costs a fraction of
       * a cent — it held 4.87 through both proven maturities. The operator is the
       * account that spends: an issuance is ~7.9 HBAR, so a low warning there
       * means something entirely different, and a single threshold for both would
       * either cry wolf on the collection account or stay silent on the operator.
       */
      const floor = label.startsWith('operator') ? 20 : 1;
      const low = hbar < floor;
      if (low) degraded = true;
      hederaLines.push(
        `${low ? '⚠ ' : ''}${label.padEnd(20)} ${hbar.toFixed(4).padStart(14)} HBAR  ${id}` +
          (low ? `  — below ${floor} HBAR; top up before rehearsing` : ''),
      );
    } catch (err) {
      degraded = true;
      hederaLines.push(`⚠ ${label.padEnd(18)} unreadable: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. The cheat sheet. Printed before the exit-code check, because a degraded run
//    still needs it — knowing which balance failed is the reason to run this.
// ---------------------------------------------------------------------------
console.log(`
arc (chain ${ARC_TESTNET.chainId})
  ${relayerLine}
${sellerLines.map((l) => `  ${l}`).join('\n')}
${buyerLines.map((l) => `  ${l}`).join('\n')}

mandates on MandateVault ${vaultAddress}
${mandateLines.length === 0 ? '  (no active mandate has a buyer address on file)' : mandateLines.map((l) => `  ${l}`).join('\n')}
${depositLine === null ? '' : `\n  ${depositLine}`}
hedera (testnet)
${hederaLines.map((l) => `  ${l}`).join('\n')}

next
  backend    cd packages/backend && npx tsx --env-file-if-exists=.env src/index.ts
  web        cd packages/web && pnpm dev
  agent      pnpm --filter @facture/agent start        (AGENT_DRY_RUN=true, AGENT_ONCE=true)
  reseed     pnpm --filter @facture/backend db:seed    ⚠ empty database only; see CLAUDE.md

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (degraded) {
  console.error('\n⚠ demo-reset finished DEGRADED. Fix the warnings above before rehearsing.');
  process.exit(1);
}
