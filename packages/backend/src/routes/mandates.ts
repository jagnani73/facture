/**
 * Buyer-facing routes.
 *
 * A funder never scrolls through invoices deciding one at a time. They write a mandate —
 * any invoice, customer rated A or better, ninety days or less, at 8.0% annualised, up to
 * $200,000 total and $50,000 per customer — fund it, and walk away.
 *
 * Funding is what makes a quote firm. A mandate matches only up to its unallocated
 * balance, so overcommitment has a structural answer rather than a patch, and two invoices
 * arriving against one mandate resolve without a race.
 */

import { MANDATE_STATUSES } from '@facture/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getStore } from '../db/store.js';
import { badRequest, notFound } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { settlementService } from '../services/settlement.js';
import { readJson, readParams, readQuery } from '../validate.js';
import { money, moneyString, wireMandate } from '../wire.js';

const uuidParam = z.object({ id: z.uuid() });

const createMandateBody = z.object({
  buyerId: z.uuid(),
  /**
   * Lowest customer grade this mandate will take. `UNRATED` is the widest floor on offer:
   * it accepts cold starts and still refuses `D`, because on shared's scale a default
   * ranks below no history at all. `D` is deliberately not selectable — a floor that
   * accepts a customer already known to default is not a bid anyone means to write.
   */
  ratingFloor: z.enum(['UNRATED', 'C', 'B', 'A']),
  maxTenorDays: z.number().int().min(1).max(365),
  annualisedYieldBps: z.number().int().min(1).max(10_000),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  exposureLimitMinor: moneyString,
  /** Concentration cap. Absent means the total limit is the only cap. */
  perDebtorLimitMinor: moneyString.optional(),
});

const fundMandateBody = z.object({
  amountMinor: moneyString,
  /** Escrow reference for the deposit, so funding is provable in the proof view. */
  escrowRef: z.string().min(1).max(200),
});

const withdrawBody = z.object({
  /** Absent withdraws the whole unallocated balance. Allocated capital never moves. */
  amountMinor: moneyString.optional(),
});

const listMandatesQuery = z.object({
  buyerId: z.uuid(),
  status: z.enum(MANDATE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const mandateRoutes = new Hono<AppEnv>();

mandateRoutes.post('/', async (c) => {
  const body = await readJson(c, createMandateBody);
  const store = getStore();

  const buyer = await store.getBuyer(body.buyerId);
  if (!buyer) throw notFound(`Buyer ${body.buyerId}`);

  if (
    body.perDebtorLimitMinor !== undefined &&
    body.perDebtorLimitMinor > body.exposureLimitMinor
  ) {
    throw badRequest(
      'The per-customer cap cannot exceed the total exposure limit — a concentration cap ' +
        'above the pool it sits under is not a cap.',
    );
  }

  /*
   * Inserted as `draft`. A mandate is not on the curve until it is funded: an unfunded bid
   * would make every quote it appears in soft, and a soft quote is the one thing this
   * product cannot afford — the whole claim is that the price a seller sees is firm.
   */
  const row = await store.insertMandate({
    buyerId: buyer.id,
    ratingFloor: body.ratingFloor,
    maxTenorDays: body.maxTenorDays,
    annualisedYieldBps: body.annualisedYieldBps,
    currency: body.currency,
    exposureLimitMinor: body.exposureLimitMinor,
    perDebtorLimitMinor: body.perDebtorLimitMinor ?? null,
    status: 'draft',
  });

  return c.json({ mandate: wireMandate(row), quoting: false }, 201);
});

mandateRoutes.get('/', async (c) => {
  const query = readQuery(c, listMandatesQuery);
  const store = getStore();

  // Allocated capital is a real column, so a trade that expired without paying keeps
  // consuming this mandate until something gives it back. See
  // `settlementService.reclaimExpired` for why that happens here rather than on a timer.
  await settlementService.reclaimExpired();

  const rows = await store.listMandates({
    buyerId: query.buyerId,
    ...(query.status === undefined ? {} : { status: query.status }),
    limit: query.limit,
  });
  const exposure = await store.debtorExposure(rows.map((row) => row.id));

  return c.json({
    mandates: rows.map((row) => ({
      ...wireMandate(row),
      /** Only an active mandate quotes; `funding` is not yet firm. */
      quoting: row.status === 'active',
      debtorExposure: renderExposure(exposure.get(row.id) ?? {}),
    })),
  });
});

/**
 * Exposure across the buyer's whole book: committed, allocated, unallocated, and the
 * concentration per debtor. This is the screen a credit desk actually watches.
 *
 * Registered before `/:id/...` so the static segment cannot be swallowed by a param.
 */
mandateRoutes.get('/exposure', async (c) => {
  const query = readQuery(c, z.object({ buyerId: z.uuid() }));
  const store = getStore();

  // Utilisation is the number this screen exists for, and an expired trade nobody paid
  // for inflates it. Reclaimed first so the figure is true when it is read.
  await settlementService.reclaimExpired();

  const rows = await store.listMandates({ buyerId: query.buyerId, limit: 200 });
  const exposure = await store.debtorExposure(rows.map((row) => row.id));

  // Rolled up across the buyer's whole book, then broken out by customer and by rating
  // bucket — the two cuts a credit desk actually watches.
  let committed = 0n;
  let allocated = 0n;
  const perDebtor = new Map<string, bigint>();
  const perBucket = new Map<string, { committed: bigint; allocated: bigint; mandates: number }>();

  for (const row of rows) {
    if (row.status === 'withdrawn') continue;
    committed += row.fundedMinor;
    allocated += row.allocatedMinor;

    for (const [debtorId, amount] of Object.entries(exposure.get(row.id) ?? {})) {
      perDebtor.set(debtorId, (perDebtor.get(debtorId) ?? 0n) + amount);
    }

    const bucket = `${row.ratingFloor}/${row.maxTenorDays}d`;
    const current = perBucket.get(bucket) ?? { committed: 0n, allocated: 0n, mandates: 0 };
    perBucket.set(bucket, {
      committed: current.committed + row.fundedMinor,
      allocated: current.allocated + row.allocatedMinor,
      mandates: current.mandates + 1,
    });
  }

  const debtors = await store.getDebtors([...perDebtor.keys()]);
  const nameOf = new Map(debtors.map((row) => [row.id, row.name]));

  return c.json({
    buyerId: query.buyerId,
    committed: money(committed),
    allocated: money(allocated),
    unallocated: money(committed > allocated ? committed - allocated : 0n),
    /** Percent of committed capital actually working, to two decimal places. */
    utilisationBps: committed === 0n ? 0 : Number((allocated * 10_000n) / committed),
    byDebtor: [...perDebtor.entries()]
      .map(([debtorId, amount]) => ({
        debtorId,
        debtorName: nameOf.get(debtorId) ?? null,
        committed: money(amount),
      }))
      .sort((a, b) => (BigInt(a.committed) < BigInt(b.committed) ? 1 : -1)),
    byBucket: [...perBucket.entries()].map(([bucket, totals]) => ({
      bucket,
      mandates: totals.mandates,
      committed: money(totals.committed),
      allocated: money(totals.allocated),
    })),
  });
});

/** Escrow the capital. This is the moment the bid becomes firm. */
mandateRoutes.post('/:id/fund', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readJson(c, fundMandateBody);
  const store = getStore();

  const existing = await store.getMandate(id);
  if (!existing) throw notFound(`Mandate ${id}`);

  /*
   * The escrow record is the authority on how much landed, never the request body. A
   * client-supplied amount is a claim about someone else's ledger, and believing it would
   * put unbacked capital on the curve — which makes every quote that mandate appears in a
   * quote nobody can honour.
   *
   * `escrowRef` is the reference to that record, and it is what the proof view shows.
   * There is no escrow provider wired into this build, so the reference is recorded and
   * carried; when one exists, its confirmed amount is read here and the body's amount is
   * used only to detect a mismatch.
   */
  const mandate = await store.fundMandate({
    mandateId: id,
    amount: body.amountMinor,
    escrowRef: body.escrowRef,
    at: new Date(),
  });

  return c.json({
    mandate: wireMandate(mandate),
    /** The moment the bid became firm. Before this the mandate is not on the curve. */
    quoting: mandate.status === 'active',
  });
});

/**
 * Withdraw unallocated capital. Allocated capital is committed against trades in flight
 * and is not withdrawable — that is what "firm" means.
 */
mandateRoutes.post('/:id/withdraw', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readJson(c, withdrawBody);

  // A buyer withdrawing "everything unallocated" must not be short-changed by capital
  // reserved for a trade whose challenge window has already run out.
  await settlementService.reclaimExpired();

  /*
   * The row lock lives in the store, and it is what makes a withdrawal racing a match lose
   * to the match: the allocation is taken under the same lock, so by the time this reads
   * `funded - allocated` the match has either happened or has not. Capital a buyer has
   * already been matched against is not theirs to pull — that is what "firm" means.
   */
  const { mandate, withdrawn } = await getStore().withdrawFromMandate({
    mandateId: id,
    ...(body.amountMinor === undefined ? {} : { amount: body.amountMinor }),
    at: new Date(),
  });

  return c.json({
    mandate: wireMandate(mandate),
    withdrawn: money(withdrawn),
    quoting: mandate.status === 'active',
  });
});

/** Per-mandate exposure detail: allocations by customer, against this mandate's own caps. */
mandateRoutes.get('/:id/exposure', async (c) => {
  const { id } = readParams(c, uuidParam);
  const store = getStore();

  const mandate = await store.getMandate(id);
  if (!mandate) throw notFound(`Mandate ${id}`);

  const exposure = (await store.debtorExposure([id])).get(id) ?? {};
  const debtors = await store.getDebtors(Object.keys(exposure));
  const nameOf = new Map(debtors.map((row) => [row.id, row.name]));

  const cap = mandate.perDebtorLimitMinor ?? mandate.exposureLimitMinor;

  return c.json({
    mandate: wireMandate(mandate),
    perDebtorLimit: money(cap),
    byDebtor: Object.entries(exposure)
      .map(([debtorId, amount]) => ({
        debtorId,
        debtorName: nameOf.get(debtorId) ?? null,
        committed: money(amount),
        /** What this mandate could still take on this customer, clamped at zero. */
        remaining: money(cap > amount ? cap - amount : 0n),
      }))
      .sort((a, b) => (BigInt(a.committed) < BigInt(b.committed) ? 1 : -1)),
  });
});

/** Exposure maps carry `bigint` values, which `JSON.stringify` throws on. */
const renderExposure = (exposure: Readonly<Record<string, bigint>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(exposure).map(([debtorId, amount]) => [debtorId, money(amount)]),
  );
