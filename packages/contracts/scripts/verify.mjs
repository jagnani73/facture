// Publish the venue's source to Sourcify, which is where HashScan reads a
// contract's "verified" badge from.
//
// This is a qualification bullet, not a nicety: Hedera's Tokenization track asks
// for a "public GitHub repo with verified contracts on HashScan", and every one
// of these read `match: null` before this script existed — deployed, called, and
// unreadable by anyone who did not have the repo.
//
// WHY NOT `hardhat verify`. It would mean adding `@nomicfoundation/hardhat-verify`
// for one task, and a new dependency in this workspace brings an unapproved build
// script that breaks `pnpm -r` until `allowBuilds` is edited by hand. Sourcify's
// v2 API takes solc standard JSON directly and Hardhat already writes exactly
// that to `artifacts/build-info`, so the whole job is a POST and a poll.
//
// WHICH BUILD. The deploy scripts pass `--build-profile production`, so the
// bytecode on chain came from that profile — but `default` and `production` are
// deliberately identical in `hardhat.config.ts` (same 0.8.28, same cancun, same
// optimizer at 200 runs), and the config says so and explains why. One build-info
// therefore matches both. If those profiles ever diverge, this script starts
// verifying source that is not what was deployed, and Sourcify will say so by
// refusing the match rather than by matching the wrong thing.
//
// Runtime match rather than full match: a full one needs the creation
// transaction, and Hedera's mirror node reports contract creation under a
// transaction id (`0.0.x@seconds.nanos`) rather than the EVM hash Sourcify wants.
// A runtime match is what HashScan's badge reads, so that is the bar cleared here.
//
// Usage: pnpm --filter @facture/contracts verify
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCIFY = 'https://sourcify.dev/server';

/**
 * What is deployed, and where.
 *
 * Kept here rather than read from a deployment manifest because there is no
 * manifest — `docs/deployments.md` is the record, in prose, and these addresses
 * are copied from it. If one is wrong Sourcify refuses the match rather than
 * verifying the wrong source at the right address, so the failure is loud.
 */
const DEPLOYED = [
  // Hedera testnet. `hedera-testnet` is chain 296.
  {
    chainId: 296,
    name: 'UniquenessRegistry',
    address: '0x8eb9f00126bca50226e47b71a75f7b438e81d408',
  },
  { chainId: 296, name: 'InvoiceRegistry', address: '0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7' },
  { chainId: 296, name: 'MandateBook', address: '0x361f9d4b1101898417b2b9148bc8aa522024a38f' },
  { chainId: 296, name: 'DvpEscrow', address: '0x35a8a43d2d840f02887cd0427e78f6b0205ded87' },
  {
    chainId: 296,
    name: 'AtsComplianceGate',
    address: '0x9a2c848ab62e715d2b49a4710f6451395978abbb',
  },
  // Arc testnet. Sourcify may not index chain 5042002 at all; handled below.
  { chainId: 5042002, name: 'MandateVault', address: '0x217256d0fdf83ffd81bbc6884ad44f5c02501102' },
  { chainId: 5042002, name: 'DvpEscrow', address: '0x32e3511A2F3d941F776dF01f6bA66a73cAf10d69' },
];

const buildInfoDir = resolve(packageRoot, 'artifacts/build-info');
const inputFile = readdirSync(buildInfoDir).find(
  (f) => f.endsWith('.json') && !f.endsWith('.output.json'),
);
if (!inputFile) {
  console.error('No build-info found. Run `pnpm --filter @facture/contracts build` first.');
  process.exit(1);
}
const buildInfo = JSON.parse(readFileSync(resolve(buildInfoDir, inputFile), 'utf8'));

/*
 * Hardhat 3 prefixes every source name with `project/`, so the identifier
 * Sourcify is given has to carry that prefix — it must match a key in
 * `input.sources` exactly, and `contracts/Foo.sol:Foo` matches nothing.
 */
const identifierFor = (name) => `project/contracts/${name}.sol:${name}`;

let degraded = false;

/** Already verified? Then say so and send nothing — this is safe to re-run. */
async function currentMatch(chainId, address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${chainId}/${address}`);
  if (!res.ok) return { unsupported: res.status === 404, match: null };
  const body = await res.json();
  return { unsupported: false, match: body.match };
}

async function verify({ chainId, name, address }) {
  const before = await currentMatch(chainId, address);
  if (before.match) return `${name.padEnd(20)} ${address}  already ${before.match}`;

  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput: buildInfo.input,
      compilerVersion: buildInfo.solcLongVersion,
      contractIdentifier: identifierFor(name),
    }),
  });

  if (res.status === 404 || res.status === 400) {
    /*
     * Reported, not degraded. Sourcify indexes a fixed chain list and Arc testnet
     * is young; a chain it does not know is not a fault in this repo, and
     * treating it as one would make every run red for a reason nobody here can
     * fix. HashScan only reads Hedera anyway, which is the chain the track asks
     * about.
     */
    const detail = await res.text();
    return `· ${name.padEnd(18)} ${address}  chain ${chainId} not verifiable: ${detail.slice(0, 90)}`;
  }
  if (!res.ok) {
    degraded = true;
    return `⚠ ${name.padEnd(18)} ${address}  submit failed (${res.status}): ${(await res.text()).slice(0, 120)}`;
  }

  const { verificationId } = await res.json();

  // Compilation is server-side and takes a few seconds; poll rather than guess.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(2000);
    const job = await (await fetch(`${SOURCIFY}/v2/verify/${verificationId}`)).json();
    if (!job.isJobCompleted) continue;
    if (job.contract?.match) {
      return `${name.padEnd(20)} ${address}  ${job.contract.match} (${job.contract.runtimeMatch ?? 'runtime n/a'})`;
    }
    degraded = true;
    return `⚠ ${name.padEnd(18)} ${address}  ${job.error?.message ?? JSON.stringify(job).slice(0, 140)}`;
  }

  degraded = true;
  return `⚠ ${name.padEnd(18)} ${address}  still compiling after 60s; check ${verificationId}`;
}

const started = Date.now();
const lines = [];
for (const contract of DEPLOYED) {
  lines.push(await verify(contract));
}

console.log(`
sourcify (what HashScan reads for its verified badge)
${lines.map((l) => `  ${l}`).join('\n')}

  hedera   https://hashscan.io/testnet/contract/<address>
  sourcify https://repo.sourcify.dev/296/<address>

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (degraded) {
  console.error('\n⚠ verify finished DEGRADED — one or more contracts did not verify.');
  process.exit(1);
}
