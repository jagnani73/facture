// Signs a scheduled maturity payout — the venue's statement that the debtor's
// money has landed in the collection account.
//
// This is deliberately a separate act from the receivable maturing.
// `POST /v1/invoices/:id/mature` puts the obligation on the ledger as an
// unsigned Hedera Scheduled Transaction; this is what turns it into a payment.
// Nothing in the backend does it automatically, because "the debtor paid" is not
// something the venue can infer from a calendar.
//
// WHY THE KEY IS NOT IN THE BACKEND'S ENV. A schedule executes the moment its
// required signatures are present, which is why the collection account must not
// be the operator. The same reasoning applies one level up: if the service
// process held this key, the only thing standing between a matured receivable
// and a payment would be the absence of a code path. So it lives in `.env.ops`,
// which scripts read and no service loads.
//
// Usage: pnpm sign:payout <0.0.x> [--sign]

/*
 * THE REDACTOR, AND WHY IT IS THE FIRST THING IN THE FILE.
 *
 * `PrivateKey.fromStringECDSA` throws on a malformed key, and the thrown value
 * has been seen to carry the input. That is the one path guaranteed to run while
 * holding the collection key, so the scrubber and both process-level handlers go
 * in before anything reads `process.env`. Only Node built-ins are imported above
 * this point: an ES `import` is hoisted and would run before the scrubber exists.
 */
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
 * `.env.ops` first and the backend's `.env` second. The account id is service
 * configuration and the key is not, so the two halves of one credential live in
 * different files by design — see the header.
 */
for (const envFile of [resolve(repoRoot, '.env.ops'), resolve(repoRoot, 'packages/backend/.env')]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const require = createRequire(resolve(repoRoot, 'packages/backend/package.json'));
const { HEDERA_TESTNET } = await import('../packages/shared/src/chains/hedera.ts');

const HEDERA_ID = /^\d+\.\d+\.\d+$/;

const argv = process.argv.slice(2);
const send = argv.includes('--sign');
const scheduleId = argv.find((a) => !a.startsWith('--')) ?? '';
if (!HEDERA_ID.test(scheduleId)) {
  console.error('usage: pnpm sign:payout <0.0.x> [--sign]');
  console.error('  the schedule id is on the holding trade — trades.maturity_schedule_id');
  process.exit(1);
}

function requireEnv(name, where) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set (expected in ${where})`);
    process.exit(1);
  }
  return value;
}

const collectionId = requireEnv('MATURITY_COLLECTION_ACCOUNT_ID', 'packages/backend/.env');
const collectionKeyRaw = requireEnv('MATURITY_COLLECTION_PRIVATE_KEY', '.env.ops');
// Registered from `process.env` BEFORE the SDK parses it — see the redactor note.
addSecret(collectionKeyRaw);

/*
 * The same refusal `services/schedule.ts` makes, for the same reason. A payout
 * drawn on the operator executes the instant it is created, reporting the debtor
 * as having paid at the moment the receivable matured.
 */
const operatorId = process.env.HEDERA_OPERATOR_ID;
if (operatorId && operatorId === collectionId) {
  console.error(`MATURITY_COLLECTION_ACCOUNT_ID is the operator (${operatorId}) — refusing.`);
  console.error('A schedule drawn on the operator signs itself at creation.');
  process.exit(1);
}

const {
  AccountId,
  Client,
  PrivateKey,
  ScheduleId,
  ScheduleSignTransaction,
} = require('@hiero-ledger/sdk');

const collectionKey = PrivateKey.fromStringECDSA(collectionKeyRaw);
addSecret(collectionKey.toStringRaw());
addSecret(collectionKey.toStringDer());

/*
 * No `process.exit()` past this point. The SDK opens libuv handles when it
 * loads, and forcing an exit while they are closing aborts the process on
 * Windows — a clean inspect run reported 127 before this was a function.
 */
async function main() {
  const mirror = async (path) => {
    const res = await fetch(`${HEDERA_TESTNET.mirrorNodeUrl}/api/v1/${path}`);
    if (!res.ok) return null;
    return res.json();
  };

  const balanceOf = async (id) => (await mirror(`accounts/${id}`))?.balance?.balance ?? null;

  const schedule = await mirror(`schedules/${scheduleId}`);
  if (!schedule) {
    console.error(`schedule ${scheduleId} not found on the mirror node`);
    return 1;
  }

  /*
   * That the key controls the account is checked against the ledger rather than
   * assumed from the file it came out of. A wrong key otherwise costs a submitted
   * transaction to discover, and the failure reads as a schedule problem.
   */
  const account = await mirror(`accounts/${collectionId}`);
  const onLedger = account?.key?.key?.toLowerCase().replace(/^0x/, '') ?? null;
  const derived = collectionKey.publicKey.toStringRaw().toLowerCase().replace(/^0x/, '');
  const keyMatches = onLedger === null ? null : onLedger === derived;

  console.log('schedule        ', scheduleId);
  console.log('memo            ', schedule.memo || '(none)');
  console.log('creator         ', schedule.creator_account_id);
  console.log('payer           ', schedule.payer_account_id);
  console.log('executed        ', schedule.executed_timestamp ?? 'NOT YET');
  console.log('collection acct ', collectionId);
  console.log(
    'key controls it ',
    keyMatches === null ? 'UNREADABLE — mirror node did not answer' : keyMatches ? 'yes' : 'NO',
  );
  console.log('mode            ', send ? 'SIGN' : 'inspect only (pass --sign)');

  if (keyMatches === false) {
    console.error('\nthe key in .env.ops does not control the collection account — refusing.');
    return 1;
  }
  if (!send) return 0;
  if (schedule.executed_timestamp) {
    console.error('\nalready executed — refusing to sign again.');
    return 1;
  }
  if (keyMatches === null) {
    console.error('\ncannot confirm the key against the ledger — refusing to sign blind.');
    return 1;
  }

  /*
   * The collection account is its own fee payer. It is the account being debited
   * so it has to sign anyway, and paying its own fee keeps the operator out of a
   * transaction that represents the venue disbursing money it has collected.
   */
  const client = Client.forName(HEDERA_TESTNET.network).setOperator(
    AccountId.fromString(collectionId),
    collectionKey,
  );

  const balanceBefore = await balanceOf(collectionId);

  const response = await new ScheduleSignTransaction()
    .setScheduleId(ScheduleId.fromString(scheduleId))
    .execute(client);
  const record = await response.getRecord(client);

  console.log('');
  console.log('sign tx         ', record.transactionId.toString());
  console.log('consensus       ', record.consensusTimestamp.toDate().toISOString());
  console.log('status          ', record.receipt.status.toString());

  client.close();

  // The mirror node trails consensus by a second or two.
  await sleep(6000);

  const after = await mirror(`schedules/${scheduleId}`);
  console.log('');
  console.log('executed_ts     ', after?.executed_timestamp ?? 'still not executed');

  /*
   * Both sides of the payout are read off the executed transaction, never from
   * configuration or a buyer row — the holder is whoever the schedule pays, and a
   * Hedera account is on file in either of its two forms.
   */
  if (after?.executed_timestamp) {
    const executed = await mirror(`transactions?timestamp=${after.executed_timestamp}`);
    const transfers = executed?.transactions?.[0]?.transfers ?? [];
    const moved = transfers.filter((t) => Math.abs(t.amount) > 0);
    if (moved.length) {
      console.log('');
      console.log('transfers (tinybars)');
      for (const t of moved.sort((a, b) => a.amount - b.amount)) {
        console.log(`  ${t.account.padEnd(16)} ${String(t.amount).padStart(14)}`);
      }
    }
  }

  console.log('');
  console.log('collection balance', balanceBefore, '→', await balanceOf(collectionId));

  return 0;
}

process.exitCode = await main();
