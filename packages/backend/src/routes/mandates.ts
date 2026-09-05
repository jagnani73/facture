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
import { getArcEscrow } from '../services/arc.js';
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

  /*
   * Who runs these bids. One read, because the route is scoped to one buyer.
   *
   * The screen used to hardcode "desk-run" in API mode, which quietly presented an
   * agent-operated desk as a human one. That is the inverse of the overclaim the product
   * warns about and still the screen saying something the venue knows to be false — an agent
   * is never dressed up as a person here, and it must not be dressed down as one either.
   */
  const buyer = await store.getBuyer(query.buyerId);
  const operator = buyer?.agentPolicy ? 'agent' : 'desk';

  /*
   * What the Arc vault actually holds behind each of these bids.
   *
   * One chain read per mandate, and that is allowed **here and nowhere else**. This is the
   * buyer's own exposure screen — their handful of mandates, not the book — and the figure
   * it exists to show is whether their capital is really posted. `GET /v1/invoices` prices
   * the whole book in one pass precisely to avoid a read per row, and copying this into it
   * would reintroduce exactly the N+1 that design is built to prevent.
   *
   * A vault that cannot be read answers `null` rather than zero. "Nobody posted this" and
   * "we could not check" are different facts, and rendering the second as the first would
   * accuse a funded buyer of quoting on nothing.
   */
  const escrow = getArcEscrow();
  const deposits = new Map<string, bigint | null>();
  if (escrow.enabled) {
    await Promise.all(
      rows.map(async (row) => {
        try {
          deposits.set(row.id, await escrow.depositedFor(row.id));
        } catch {
          deposits.set(row.id, null);
        }
      }),
    );
  }

  return c.json({
    mandates: rows.map((row) => {
      const deposited = deposits.get(row.id);
      const required = escrow.requiredFor(row.fundedMinor, row.currency);
      return {
        ...wireMandate(row),
        /** Only an active mandate quotes; `funding` is not yet firm. */
        quoting: row.status === 'active',
        operator,
        debtorExposure: renderExposure(exposure.get(row.id) ?? {}),
        /**
         * Whether this bid is backed by capital anyone can verify, and how much.
         *
         * `backed` is deliberately not `deposited > 0`: a mandate counted as holding more
         * than the vault does is exactly the overclaim the funding check refuses, and a
         * partially-backed bid must not read as a funded one.
         *
         * Both figures are USDC ERC-20 minor units (6dp) and the field names say so, because
         * the defect this replaced was two scales sharing one name. `requiredUsdcMinor` is
         * what makes them comparable — it is the mandate's own committed capital put through
         * the same conversion the cash leg settles through, so the comparison is like with
         * like. Rendering either as the mandate's currency is off by four orders of
         * magnitude, which is what the screen was doing.
         */
        escrow: {
          checked: escrow.enabled && deposited !== undefined,
          depositedUsdcMinor:
            deposited === undefined || deposited === null ? null : money(deposited),
          requiredUsdcMinor: money(required),
          backed: deposited !== undefined && deposited !== null && deposited >= required,
        },
      };
    }),
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
   *
   * The escrow provider is `MandateVault` on Arc, and its `balanceOf` is a view — so this
   * costs no key, no gas and no signature, and the venue simply asks the chain how much is
   * actually there. Funding is refused when it would count capital the vault does not hold.
   * With no vault configured the read is unavailable rather than zero, `enabled` is how the
   * two are told apart, and the response says which happened so that "escrowed" is never an
   * assumption a reader has to make.
   */
  const escrow = getArcEscrow();
  if (escrow.enabled) {
    const deposited = await escrow.depositedFor(id);
    const wouldBeCommitted = existing.fundedMinor + body.amountMinor;
    /*
     * Converted before it is compared. The vault answers in USDC minor units at 6 decimals
     * and a mandate is written in its own currency's minor units at 2, so the two are not
     * the same number even when they read as one — $50,000.00 and 5 USDC are both
     * `5000000`, and comparing them directly is how a mandate came to be counted as backed
     * by ten-thousandth of its capital.
     */
    const required = escrow.requiredFor(wouldBeCommitted, existing.currency);

    if (required > deposited) {
      throw badRequest(
        `This mandate would be counted as holding ${wouldBeCommitted} ${existing.currency} ` +
          `minor units, which needs ${required} USDC minor units on Arc, but the vault holds ` +
          `${deposited}. Capital has to arrive on Arc before the book will quote against it — ` +
          'a bid backed by a request body is not a firm bid.',
      );
    }
  }

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
    /**
     * Whether the amount above was checked against capital that actually exists, or merely
     * recorded. A reader must not have to infer which, so it is stated rather than implied
     * by the presence of an escrow reference.
     */
    escrowVerified: escrow.enabled,
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
