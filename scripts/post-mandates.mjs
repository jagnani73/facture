#!/usr/bin/env node
/**
 * Put the mandates already in the book onto Hedera's `MandateBook`.
 *
 *   node scripts/post-mandates.mjs            # dry run, spends nothing
 *   node scripts/post-mandates.mjs --execute  # posts and credits
 *
 * `POST /v1/mandates` posts a mandate as it is created and `POST /v1/mandates/:id/fund` repairs a
 * missing posting before it credits — so every mandate written from now on reaches the book on its
 * own. This script exists for the ones that do not: seven mandates predate the wiring, and without
 * them the cross-check at arm time would answer `checked: false` on every trade the demo makes.
 * A mechanism with nothing to check is the failure this whole wiring exists to end.
 *
 * WHAT IT WRITES, AND IN WHICH UNITS
 *
 * `postMandate(minRating, maxTenorDays, annualisedYieldBps, maxPerDebtor)` then
 * `creditFunding(id, funder, amount, depositRef)`. Amounts are the mandate's own currency minor
 * units — cents — and never USDC, because the book prices from `InvoiceRegistry.faceValue` which
 * is listed in cents. Crediting the vault's 6-decimal figure would put a ppm-scaled number beside
 * a cents one on a contract nobody can patch.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not deposit, allocate, match or settle. `postMandate` sets `buyer = msg.sender`
 * permanently, so the venue becomes the on-chain buyer of every mandate it posts — the real
 * buyers hold no Hedera key, which is also why `authoriseRelease` is not wired anywhere. What the
 * book records is the venue's standing bid on their behalf, and that is what the reader should
 * take it for.
 *
 * Modelled on `demo-reset.mjs`: numbered steps, a `degraded` flag rather than throws, and a
 * summary printed before the exit code.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* Resolved from the backend, which owns these dependencies. The root workspace has none. */
const require = createRequire(resolve(repoRoot, 'packages/backend/package.json'));
const { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const Database = require('better-sqlite3');

const EXECUTE = process.argv.includes('--execute');
const RPC = 'https://testnet.hashio.io/api';

/** `MandateBook`'s own caps, narrower than this venue accepts. Outside them, do not publish. */
const MAX_YIELD_BPS = 5000;
const MAX_TENOR_DAYS = 365;

/** `Rating` in FactureTypes.sol — the on-chain mirror of RATING_RANK in @facture/shared. */
const RATING_ORDINAL = { D: 0, UNRATED: 1, C: 2, B: 3, A: 4 };

const ABI = parseAbi([
  'function postMandate(uint8 minRating, uint32 maxTenorDays, uint16 annualisedYieldBps, uint128 maxPerDebtor) returns (uint256)',
  'function creditFunding(uint256 mandateId, address funder, uint128 amount, bytes32 depositRef)',
  'function isDepositCredited(bytes32 depositRef) view returns (bool)',
  'function getMandate(uint256 mandateId) view returns (address buyer, uint8 minRating, uint32 maxTenorDays, uint16 annualisedYieldBps, uint128 maxPerDebtor, uint128 totalCommitted, uint128 allocated, uint8 status)',
  'function mandateCount() view returns (uint256)',
]);

const MANDATE_POSTED_TOPIC = keccak256(
  toHex('MandatePosted(uint256,address,uint8,uint32,uint16,uint128)'),
);

function env(name) {
  const file = resolve(repoRoot, 'packages/backend/.env');
  const text = readFileSync(file, 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set in packages/backend/.env`);
  return line.slice(name.length + 1).trim();
}

let degraded = false;
const rows = [];

const bookAddress = env('HEDERA_MANDATE_BOOK_ADDRESS');
const operatorKey = env('HEDERA_OPERATOR_KEY');
const dbPath = env('DATABASE_URL');

const account = privateKeyToAccount(
  operatorKey.startsWith('0x') ? operatorKey : `0x${operatorKey}`,
);
const reader = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });

console.log(`\nMandateBook  ${bookAddress}`);
console.log(`operator     ${account.address}`);
console.log(`database     ${dbPath}`);
console.log(`mode         ${EXECUTE ? 'EXECUTE — this spends HBAR' : 'dry run'}\n`);

const db = new Database(resolve(repoRoot, 'packages/backend', dbPath));
const mandates = db
  .prepare(
    `select m.id, m.rating_floor, m.max_tenor_days, m.annualised_yield_bps, m.currency,
            m.exposure_limit_minor, m.per_debtor_limit_minor, m.funded_minor,
            m.chain_mandate_id, m.status, b.name as buyer
       from mandates m join buyers b on b.id = m.buyer_id
      order by m.created_at`,
  )
  .all();

const before = await reader.readContract({
  address: bookAddress,
  abi: ABI,
  functionName: 'mandateCount',
});
console.log(`the book holds ${before} mandate(s) before this run\n`);

// --- 1. post and credit, one mandate at a time ---------------------------------------------------
for (const m of mandates) {
  const label = `${m.buyer} ${m.id.slice(0, 8)}`;
  const perDebtor = BigInt(m.per_debtor_limit_minor ?? m.exposure_limit_minor);
  const funded = BigInt(m.funded_minor);

  if (m.chain_mandate_id !== null) {
    rows.push([label, `already on the book as ${m.chain_mandate_id}`, 'skip']);
    continue;
  }
  if (
    m.annualised_yield_bps < 1 ||
    m.annualised_yield_bps > MAX_YIELD_BPS ||
    m.max_tenor_days < 1 ||
    m.max_tenor_days > MAX_TENOR_DAYS ||
    perDebtor <= 0n
  ) {
    // Not degraded. Publishing clamped terms would put a bid on a public book that its buyer
    // never wrote, which is worse than not publishing it.
    rows.push([label, `outside the book's caps (${m.annualised_yield_bps}bps/${m.max_tenor_days}d)`, 'skip']);
    continue;
  }

  if (!EXECUTE) {
    rows.push([
      label,
      `would post ${m.rating_floor}/${m.max_tenor_days}d/${m.annualised_yield_bps}bps, credit ${funded}`,
      'dry',
    ]);
    continue;
  }

  try {
    const postHash = await wallet.writeContract({
      address: bookAddress,
      abi: ABI,
      functionName: 'postMandate',
      args: [RATING_ORDINAL[m.rating_floor], m.max_tenor_days, m.annualised_yield_bps, perDebtor],
      chain: null,
      gas: 400_000n,
    });
    const receipt = await reader.waitForTransactionReceipt({ hash: postHash });
    if (receipt.status !== 'success') throw new Error(`postMandate reverted (${postHash})`);

    // The id comes from the event, never from reading `mandateCount()` back: the counter is
    // shared and anyone may post, so a read could name a mandate this venue did not create.
    const log = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === bookAddress.toLowerCase() &&
        l.topics[0] === MANDATE_POSTED_TOPIC &&
        `0x${(l.topics[2] ?? '').slice(-40)}`.toLowerCase() === account.address.toLowerCase(),
    );
    if (!log) throw new Error(`no MandatePosted log names this venue in ${postHash}`);
    const chainId = BigInt(log.topics[1]);

    db.prepare('update mandates set chain_mandate_id = ? where id = ?').run(
      chainId.toString(10),
      m.id,
    );

    let creditNote = 'nothing committed';
    if (funded > 0n) {
      const depositRef = keccak256(toHex(`facture.funding.v1:${m.id}:${funded.toString(10)}`));
      const already = await reader.readContract({
        address: bookAddress,
        abi: ABI,
        functionName: 'isDepositCredited',
        args: [depositRef],
      });
      if (already) {
        creditNote = 'already credited';
      } else {
        const creditHash = await wallet.writeContract({
          address: bookAddress,
          abi: ABI,
          functionName: 'creditFunding',
          args: [chainId, account.address, funded, depositRef],
          chain: null,
          gas: 250_000n,
        });
        const creditReceipt = await reader.waitForTransactionReceipt({ hash: creditHash });
        if (creditReceipt.status !== 'success') {
          throw new Error(`creditFunding reverted (${creditHash})`);
        }
        creditNote = `credited ${funded}`;
      }
    }

    rows.push([label, `posted as ${chainId}, ${creditNote}`, 'ok']);
  } catch (err) {
    degraded = true;
    rows.push([label, err instanceof Error ? err.message : String(err), 'FAILED']);
  }
}

// --- 2. read the book back -----------------------------------------------------------------------
const after = await reader.readContract({
  address: bookAddress,
  abi: ABI,
  functionName: 'mandateCount',
});

const width = Math.max(...rows.map((r) => r[0].length), 10);
console.log(rows.map(([a, b, c]) => `  ${c.padEnd(7)} ${a.padEnd(width)}  ${b}`).join('\n'));
console.log(`\nthe book holds ${after} mandate(s) after this run`);

if (!EXECUTE) console.log('\nDry run. Re-run with --execute to post and credit.');
if (degraded) {
  console.error('\n⚠ finished DEGRADED — one or more mandates did not reach the book.');
  db.close();
  process.exit(1);
}
db.close();
