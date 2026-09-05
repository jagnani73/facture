/**
 * Seller onboarding.
 *
 * The one route a business needs before it has a book: give an email address and the
 * wallet that was made from it, and get back the id every other seller-side route is
 * scoped by. Until this existed a seller could only arrive through `seed.ts`, which meant
 * the product's opening claim — *a seller connects a wallet, or has one made from an email
 * address* — was true of the argument and not of the build.
 *
 * ## Email is the identity, so this is idempotent on it
 *
 * `sellers.email` carries a unique index, and signing in with an email address is the only
 * way a seller is identified at all. So a repeat call is a sign-in, not a duplicate: the
 * existing row comes back with `200`, a new one is created with `201`, and a business
 * cannot end up with two books because it capitalised its own address differently.
 *
 * ## A wallet address is recorded once and never rebound
 *
 * Nothing authenticates this route. That is survivable for creating a row — the worst case
 * is a stranger reserving an email address they do not own — and it is *not* survivable for
 * overwriting a wallet, because a seller's recorded address is where their money is
 * expected to be. So an address is written only into a field that is currently null, and a
 * different address arriving for a seller who already has one is a `409` rather than a
 * silent rebind. Sending the same address again is a no-op, which is what a repeat sign-in
 * from the same wallet looks like.
 *
 * When this route gains real authentication that rule can be relaxed deliberately. It must
 * not be relaxed by accident, which is why the refusal is here rather than a comment.
 *
 * ## The two address fields are not the same kind of thing
 *
 * `arcAddress` is an ordinary EVM address: valid on Arc the moment it exists. A Hedera
 * `hederaAccountId` is a `0.0.x`, and a freshly made wallet does not have one — what it has
 * is an *alias* derived from its public key, and Hedera creates the account behind that
 * alias when it is first funded. Both are accepted, neither is required, and the absence of
 * an account id is a fact about Hedera rather than a gap in the record.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getStore } from '../db/store.js';
import { conflict, notFound } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { readJson, readParams } from '../validate.js';
import { wireSeller } from '../wire.js';

const uuidParam = z.object({ id: z.uuid() });

/** An EVM address. Checksum is not verified; the length and alphabet are. */
const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

/** A Hedera account id, `shard.realm.num`. Never an alias — see the module note. */
const hederaAccountId = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be a Hedera account id in shard.realm.num form');

const createSellerBody = z.object({
  name: z.string().trim().min(1).max(200),
  /*
   * Lowercased here rather than at the store, so that what the route decided to look up is
   * the same string it would have written. `upsertDebtor` normalises the same way.
   */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email())
    .refine((v) => v.length <= 320),
  arcAddress: evmAddress.optional(),
  hederaAccountId: hederaAccountId.optional(),
});

export const sellerRoutes = new Hono<AppEnv>();

sellerRoutes.post('/', async (c) => {
  const body = await readJson(c, createSellerBody);
  const store = getStore();

  const existing = await store.getSellerByEmail(body.email);
  if (!existing) {
    const created = await store.insertSeller({
      name: body.name,
      email: body.email,
      arcAddress: body.arcAddress ?? null,
      hederaAccountId: body.hederaAccountId ?? null,
    });
    return c.json({ seller: wireSeller(created), created: true }, 201);
  }

  /*
   * Fill what is missing, refuse what would move. `undefined` means the caller said
   * nothing about that field and is not an instruction to clear it.
   */
  const wallet: { arcAddress?: string; hederaAccountId?: string } = {};

  for (const field of ['arcAddress', 'hederaAccountId'] as const) {
    const offered = body[field];
    if (offered === undefined) continue;

    const held = existing[field];
    if (held === null) {
      wallet[field] = offered;
      continue;
    }
    if (held.toLowerCase() === offered.toLowerCase()) continue;

    throw conflict(
      'conflict',
      `This business already has a ${field === 'arcAddress' ? 'wallet address' : 'Hedera account'} on file, and it is not the one you sent. ` +
        'A recorded address is where a seller expects to be paid, so it is not changed by signing in again.',
    );
  }

  const seller =
    Object.keys(wallet).length > 0 ? await store.updateSellerWallet(existing.id, wallet) : existing;

  return c.json({ seller: wireSeller(seller), created: false }, 200);
});

sellerRoutes.get('/:id', async (c) => {
  const { id } = readParams(c, uuidParam);
  const seller = await getStore().getSeller(id);
  if (!seller) throw notFound(`Seller ${id}`);
  return c.json({ seller: wireSeller(seller) }, 200);
});
