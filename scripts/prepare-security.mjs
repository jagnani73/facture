// One-command CONFIGURATION of a deployed ATS security — the transactions that
// sit between `deployBond` and an instrument anything can actually trade.
//
// `deployBond` creates the security and NOTHING else: no supply, an empty
// allowlist and no KYC. A transfer against it reverts, and the revert names none
// of that. `packages/backend/src/services/compliance.ts` reads exactly the state
// this script writes — `getControlListType`, `isInControlList`,
// `getKycStatusFor`, `paused` — so an instrument that has not been through here
// is one the venue will correctly refuse to quote, over and over, for a reason
// no chain error ever states.
//
// These numbers ARE the `// 1.` … `// 8.` markers below:
//   1. reads the INSTRUMENT and refuses anything that is not an ALLOW list —
//      and refuses an UNREADABLE one separately, because "blocklist" and "the
//      relay did not answer" are different facts and only one is a fault
//   2. resolves the PARTIES to the addresses a Solidity mapping will actually
//      see: the seller by derivation from the operator key, each buyer to its
//      account ALIAS via the mirror node
//   3. grantRole × 4 — the deployer holds `DEFAULT_ADMIN_ROLE` and nothing else
//   4. addToControlList — seller and buyer, because the list is an ALLOW list
//   5. addIssuer — `grantKyc` reverts `AccountIsNotIssuer` until this exists
//   6. grantKyc — seller and buyer, five arguments including the issuer
//   7. issue — face-value-many units to the seller
//   8. prints the state and the cheat sheet
//
// ORDERING, and none of it is a preference — the contracts impose all of it:
//   * Roles first. The deployer is admin and holds no functional role, so every
//     later call reverts on authorisation before it reverts on anything else.
//   * `addIssuer` (5) must precede `grantKyc` (6): a KYC grant from an account
//     the security has not registered as an issuer reverts `AccountIsNotIssuer`.
//   * The control list (4) and KYC (6) must both precede `issue` (7). Holder and
//     receiver are BOTH checked, so an allowlisted seller with an unlisted buyer
//     mints fine and cannot then deliver.
//
// IDEMPOTENT BY READING FIRST. Every step reads the chain before it writes, so a
// re-run after a partial failure costs nothing and cannot double-issue. That is
// also why a failed step is a `degraded` line rather than a throw: finishing the
// run reports every remaining problem at once, and re-running is the fix.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not deploy — issuance is the
// backend's queue, and this configures what that queue produced. It does not
// touch `facture.db`; nothing here is a fact about the book. And it never grants
// against an account's LONG-ZERO address: to a Solidity mapping the long-zero
// form and the key-derived alias are unrelated addresses, so a grant against the
// wrong one succeeds and authorises nobody. Step 2 refuses rather than guesses.
//
// Role hashes come from `contracts/constants/roles.sol` in the ATS source, NOT
// from its README. The README lists a different set under similar names, and
// granting one of those succeeds while authorising nothing at all.
//
// Usage: pnpm prepare:security <0x-security> <units> [--send] [--buyer <id,…>]

/*
 * THE REDACTOR, AND WHY IT IS THE FIRST THING IN THE FILE.
 *
 * `PrivateKey.fromStringECDSA` throws on a malformed key, and the thrown value
 * has been seen to carry the input. That is the one path guaranteed to run while
 * holding the operator key, so the scrubber and both process-level handlers are
 * installed before anything reads `process.env`.
 *
 * The only static imports above this point are Node built-ins, on purpose: an ES
 * `import` is hoisted and executes before any module body, so a static import of
 * viem or the Hedera SDK here would run before the scrubber existed. Everything
 * else is pulled in with `createRequire` further down, where the call happens in
 * body order rather than at parse time.
 */
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const secrets = new Set();
const scrub = (text) => {
  let out = text;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join('<REDACTED>');
  return out;
};
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, enc, cb) => {
    if (typeof chunk === 'string') return original(scrub(chunk), enc, cb);
    if (Buffer.isBuffer(chunk)) {
      return original(Buffer.from(scrub(chunk.toString('utf8')), 'utf8'), enc, cb);
    }
    return original(chunk, enc, cb);
  };
}
/** Every spelling of a secret, because the SDK re-encodes what it is given. */
const addSecret = (value) => {
  if (!value) return;
  const bare = String(value).replace(/^0x/i, '');
  for (const form of [value, bare, bare.toLowerCase(), bare.toUpperCase(), `0x${bare}`]) {
    secrets.add(form);
  }
  secrets.add(`0x${bare.toLowerCase()}`);
};
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', scrub(String(err?.stack ?? err)));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED:', scrub(String(err?.stack ?? err)));
  process.exit(1);
});
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The same env chain `demo-reset.mjs` loads, and for the same reason: the
 * operator key lives in the backend's `.env` and the buyer's account id lives in
 * the agent's, so a script that spans both rails has to read both files.
 */
for (const envFile of [
  resolve(repoRoot, 'packages/backend/.env'),
  resolve(repoRoot, 'packages/web/.env.local'),
  resolve(repoRoot, 'packages/agent/.env'),
]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/*
 * viem and the Hedera SDK, borrowed from the backend's dependency tree rather
 * than added to the root `package.json`. `scripts/` is not a workspace package,
 * so a bare `import 'viem'` does not resolve from here — and resolving what the
 * backend already pins is the smallest way to be sure this script and the
 * service agree about ABI encoding and about how a transaction is built.
 */
const require = createRequire(resolve(repoRoot, 'packages/backend/package.json'));
const { createPublicClient, encodeFunctionData, http, parseAbi } = require('viem');

/*
 * Chain constants come from `@facture/shared`, not from literals here — the same
 * rule that file states about itself: nothing outside it should contain an RPC
 * URL as a literal.
 */
const { HEDERA_TESTNET } = await import('../packages/shared/src/chains/hedera.ts');

/** From `contracts/constants/roles.sol`. See the header. */
const ROLE_CONTROL_LIST = '0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d';
const ROLE_SSI_MANAGER = '0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1';
const ROLE_KYC = '0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc';
const ROLE_ISSUER = '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEDERA_ID = /^\d+\.\d+\.\d+$/;

const argv = process.argv.slice(2);
const send = argv.includes('--send');
const buyerIndex = argv.indexOf('--buyer');
const buyerArg = buyerIndex === -1 ? null : argv[buyerIndex + 1];
/** Flags and the one flag VALUE removed, so `--send` may appear anywhere. */
const buyerValueIndex = buyerIndex === -1 ? -1 : buyerIndex + 1;
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== buyerValueIndex);

const security = (positional[0] ?? '').toLowerCase();
const unitsArg = positional[1] ?? '';
if (!EVM_ADDRESS.test(security) || !/^\d+$/.test(unitsArg)) {
  console.error('usage: pnpm prepare:security <0x-security> <units> [--send] [--buyer <id,…>]');
  console.error('  units are minor units — the face value the instrument was deployed against');
  process.exit(1);
}
const units = BigInt(unitsArg);

function requireEnv(name, where) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set (expected in ${where})`);
    process.exit(1);
  }
  return value;
}

const operatorId = requireEnv('HEDERA_OPERATOR_ID', 'packages/backend/.env');
const operatorKeyRaw = requireEnv('HEDERA_OPERATOR_KEY', 'packages/backend/.env');
// Registered from `process.env` BEFORE the SDK parses it — see the redactor note.
addSecret(operatorKeyRaw);

const {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
} = require('@hiero-ledger/sdk');

const operatorKey = PrivateKey.fromStringECDSA(operatorKeyRaw);
addSecret(operatorKey.toStringRaw());
addSecret(operatorKey.toStringDer());

const reader = createPublicClient({ transport: http(HEDERA_TESTNET.jsonRpcUrl) });
const client = Client.forName(HEDERA_TESTNET.network).setOperator(
  AccountId.fromString(operatorId),
  operatorKey,
);
const contractId = ContractId.fromEvmAddress(0, 0, security);

const READ_ABI = parseAbi([
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function getControlListType() view returns (bool)',
  'function isInControlList(address) view returns (bool)',
  'function getKycStatusFor(address) view returns (uint8)',
  'function isIssuer(address) view returns (bool)',
  'function paused() view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const WRITE_ABI = parseAbi([
  'function grantRole(bytes32 role, address account)',
  'function addToControlList(address _account) returns (bool)',
  'function addIssuer(address _issuer) returns (bool)',
  'function grantKyc(address _account, string _vcId, uint256 _validFrom, uint256 _validTo, address _issuer) returns (bool)',
  'function issue(address _tokenHolder, uint256 _value, bytes _data)',
]);

/**
 * A read that answers `null` when it cannot answer.
 *
 * The whole script fails closed on an unreadable instrument at step 1, so a null
 * here is a transient relay hiccup rather than a silent path to a wrong write —
 * and a redundant grant on a re-read is the cheap side of that trade.
 */
const read = async (functionName, args = []) => {
  try {
    return await reader.readContract({ address: security, abi: READ_ABI, functionName, args });
  } catch {
    return null;
  }
};

let degraded = false;

/**
 * Every write here, and the receipt check none of them may skip.
 *
 * `execute` resolves when a transaction is SUBMITTED, not when it succeeded.
 * This repo has shipped that bug twice — a `deployBond` selector and a
 * uniqueness claim both reported a revert as success — so the check is in the
 * helper rather than at each call site.
 */
async function submit(label, functionName, args, gas) {
  const calldata = encodeFunctionData({ abi: WRITE_ABI, functionName, args });
  if (!send) return `would ${label}`;
  try {
    const response = await new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(gas)
      .setFunctionParameters(Buffer.from(calldata.slice(2), 'hex'))
      .execute(client);
    const receipt = await response.getReceipt(client);
    const status = receipt.status.toString();
    if (status !== 'SUCCESS') {
      degraded = true;
      return `⚠ ${label} -> ${status}`;
    }
    return `${label} -> SUCCESS  ${response.transactionId.toString()}`;
  } catch (err) {
    degraded = true;
    return `⚠ ${label} failed: ${err.message}`;
  }
}

const started = Date.now();

// ---------------------------------------------------------------------------
// 1. The instrument. Refuse a blocklist, and refuse an unreadable one
//    SEPARATELY: `isInControlList` means the opposite thing on each, so adding
//    a party to a blocklist is how you exclude exactly the party you meant to
//    admit — and an unreadable relay is not a fact about the security at all.
// ---------------------------------------------------------------------------
const listType = await read('getControlListType');
if (listType === null) {
  console.error(`${security} did not answer through ${HEDERA_TESTNET.jsonRpcUrl}.`);
  console.error('Either nothing is deployed there or the relay is down — and neither is a fact');
  console.error('about the control list, so nothing below may act on it. Refusing.');
  process.exit(1);
}
if (listType !== true) {
  console.error(`${security} carries a BLOCK list, not an allow list. Refusing.`);
  console.error('On a blocklist `addToControlList` excludes the account it names.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. The parties, resolved to the addresses a Solidity mapping actually sees.
//
//    The seller is the operator: `createHoldByPartition` acts on the CALLER's
//    own tokens, so in this build the venue holds the paper and the seller
//    signs nothing to sell. Its address is derived from the key rather than read
//    from anywhere, which is also how `demo-reset.mjs` verifies it.
//
//    A buyer is named as a Hedera account id and resolved through the mirror
//    node to its ALIAS. Passing an id rather than an address is the point: the
//    long-zero form derived from the account NUMBER is a different key to the
//    contract, and a grant against it authorises nobody.
// ---------------------------------------------------------------------------
const sellerEvm = `0x${operatorKey.publicKey.toEvmAddress().replace(/^0x/, '').toLowerCase()}`;

async function resolveBuyer(id) {
  if (EVM_ADDRESS.test(id)) return { id, address: id.toLowerCase() };
  if (!HEDERA_ID.test(id)) {
    return { id, why: 'is neither a 0x address nor a 0.0.x account id' };
  }
  let body;
  try {
    const res = await fetch(`${HEDERA_TESTNET.mirrorNodeUrl}/api/v1/accounts/${id}`);
    if (!res.ok) throw new Error(`mirror node answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    return { id, why: `could not be resolved: ${err.message}` };
  }
  const evm = String(body.evm_address ?? '').toLowerCase();
  if (!EVM_ADDRESS.test(evm)) return { id, why: 'has no EVM address on the mirror node' };
  /*
   * 24 leading zero nibbles is the long-zero shape — twelve zero bytes then the
   * entity number. A key-derived alias having them is a one-in-2^96 accident, so
   * this is a heuristic, and it is the right way round: it refuses rather than
   * grants when it cannot tell.
   */
  if (/^0x0{24}/.test(evm)) {
    return { id, why: `resolves to the LONG-ZERO address ${evm}, which authorises nobody` };
  }
  return { id, address: evm };
}

const buyerIds = (buyerArg ?? process.env.AGENT_HEDERA_ACCOUNT_ID ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const buyerSource = buyerArg ? '--buyer' : 'AGENT_HEDERA_ACCOUNT_ID';

const buyers = [];
const buyerLines = [];
for (const id of buyerIds) {
  const resolved = await resolveBuyer(id);
  if (resolved.address) {
    buyers.push(resolved);
    buyerLines.push(`buyer   ${id.padEnd(16)} ${resolved.address}  (${buyerSource})`);
  } else {
    /*
     * Degraded, unlike the unfundable addresses in `demo-reset.mjs`. There the
     * invented parties are the permanent state of the seeded book; here a buyer
     * that cannot be resolved means the instrument is about to be left tradeable
     * by nobody, which is the exact failure this script exists to prevent.
     */
    degraded = true;
    buyerLines.push(`⚠ buyer ${id.padEnd(16)} ${resolved.why}`);
  }
}
if (buyerIds.length === 0) {
  degraded = true;
  buyerLines.push(
    '⚠ no buyer named. Set AGENT_HEDERA_ACCOUNT_ID in packages/agent/.env or pass\n' +
      '          --buyer <0.0.x>. Without one the seller is prepared and the instrument\n' +
      '          still cannot be delivered to anybody.',
  );
}

/** Seller and buyers, in the order the control list and KYC steps walk them. */
const parties = [{ who: 'seller', address: sellerEvm }].concat(
  buyers.map((b) => ({ who: `buyer ${b.id}`, address: b.address, vc: 'buyer' })),
);

console.log(`security   ${security}`);
console.log(`operator   ${operatorId}  ${sellerEvm}`);
for (const line of buyerLines) console.log(`  ${line}`);
console.log(`units      ${units}`);
console.log(`mode       ${send ? 'SEND — this spends HBAR' : 'plan only (pass --send)'}`);
console.log('');

// ---------------------------------------------------------------------------
// 3. Roles. The deployer holds DEFAULT_ADMIN_ROLE and no functional role, so
//    without these every later call reverts on authorisation first.
// ---------------------------------------------------------------------------
const roleLines = [];
for (const [label, role] of [
  ['ROLE_CONTROL_LIST', ROLE_CONTROL_LIST],
  ['ROLE_SSI_MANAGER', ROLE_SSI_MANAGER],
  ['ROLE_KYC', ROLE_KYC],
  ['ROLE_ISSUER', ROLE_ISSUER],
]) {
  const held = await read('hasRole', [role, sellerEvm]);
  roleLines.push(
    held === true
      ? `have ${label}`
      : await submit(`grant ${label}`, 'grantRole', [role, sellerEvm], 800_000),
  );
}

// ---------------------------------------------------------------------------
// 4. The control list. An ALLOW list, checked at step 1 — holder AND receiver
//    are both tested on a transfer, so a listed seller with an unlisted buyer
//    is an instrument that mints and cannot deliver.
// ---------------------------------------------------------------------------
const listLines = [];
for (const { who, address } of parties) {
  const inList = await read('isInControlList', [address]);
  listLines.push(
    inList === true
      ? `${who} already allowed`
      : await submit(`allow ${who}`, 'addToControlList', [address], 800_000),
  );
}

// ---------------------------------------------------------------------------
// 5. The issuer. `grantKyc` reverts `AccountIsNotIssuer(address)` = 0xcd324f53
//    until the granting account is registered here, and `addIssuer` itself
//    needs ROLE_SSI_MANAGER from step 3.
// ---------------------------------------------------------------------------
const issuerLine =
  (await read('isIssuer', [sellerEvm])) === true
    ? 'operator already registered'
    : await submit('addIssuer(operator)', 'addIssuer', [sellerEvm], 800_000);

// ---------------------------------------------------------------------------
// 6. KYC. `getKycStatusFor` returns an ENUM — KycStatus { NOT_GRANTED, GRANTED }
//    — so the comparison is against 1 and not against a truthy value.
// ---------------------------------------------------------------------------
/*
 * A decade of validity from now. The window is metadata on the grant rather than
 * something the venue enforces — eligibility is decided by the control list and
 * the KYC status — but a grant that expires mid-demo would be a confusing way to
 * discover that.
 */
const validFrom = BigInt(Math.floor(Date.now() / 1000) - 60);
const validTo = validFrom + 10n * 365n * 24n * 60n * 60n;

const kycLines = [];
for (const { who, address, vc } of parties) {
  const status = await read('getKycStatusFor', [address]);
  kycLines.push(
    status === 1
      ? `${who} already granted`
      : await submit(
          `grantKyc(${who})`,
          'grantKyc',
          [address, `facture-${vc ?? who}`, validFrom, validTo, sellerEvm],
          1_200_000,
        ),
  );
}

// ---------------------------------------------------------------------------
// 7. Supply. `deployBond` mints nothing; `issue` does, and `maxSupply` is the
//    face value in minor units, so an instrument structurally cannot be
//    over-issued against the invoice behind it.
// ---------------------------------------------------------------------------
const supply = await read('totalSupply');
const supplyLine =
  typeof supply === 'bigint' && supply > 0n
    ? `already issued: totalSupply ${supply}`
    : // ~465k gas measured here; padded because solvency follows the LIMIT, not the use.
      await submit(`issue(seller, ${units})`, 'issue', [sellerEvm, units, '0x'], 1_500_000);

client.close();

// ---------------------------------------------------------------------------
// 8. The state, and the cheat sheet. Printed before the exit-code check, because
//    a degraded run still needs it — knowing which step failed is the reason to
//    run this at all. Read fresh rather than inferred from what was submitted: a
//    read straight after a write LAGS on this relay (`totalSupply` has answered
//    0 seconds after a successful issue), so a zero here is worth re-reading
//    before it is worth believing.
// ---------------------------------------------------------------------------
const stateLines = [];
for (const [label, fn, args] of [
  ['paused', 'paused', []],
  ['totalSupply', 'totalSupply', []],
  ['seller balance', 'balanceOf', [sellerEvm]],
  ['seller in list', 'isInControlList', [sellerEvm]],
  ['seller kyc', 'getKycStatusFor', [sellerEvm]],
  ...buyers.flatMap((b) => [
    [`${b.id} in list`, 'isInControlList', [b.address]],
    [`${b.id} kyc`, 'getKycStatusFor', [b.address]],
  ]),
]) {
  stateLines.push(`${label.padEnd(22)} ${String(await read(fn, args))}`);
}

console.log(`
roles
${roleLines.map((l) => `  ${l}`).join('\n')}

control list (ALLOW)
${listLines.map((l) => `  ${l}`).join('\n')}

issuer
  ${issuerLine}

kyc
${kycLines.map((l) => `  ${l}`).join('\n')}

supply
  ${supplyLine}

state ${send ? 'after' : 'now'}
${stateLines.map((l) => `  ${l}`).join('\n')}

next
  hashscan   ${HEDERA_TESTNET.explorerUrl}/contract/${security}
  quote      the book should now price it — mandatesBarredByInstrument falls to 0
  re-run     pnpm prepare:security ${security} ${units}   (idempotent; reads before every step)

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (degraded) {
  console.error('\n⚠ prepare-security finished DEGRADED. Fix the warnings above and re-run.');
  process.exit(1);
}
