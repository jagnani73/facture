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
import { badRequest, conflict, notFound, upstreamUnavailable } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import {
  backingMakesBidFirm,
  backingWasRead,
  ensureMandateRegistered,
  executeCapitalRelease,
  getArcEscrow,
  planCapitalRelease,
  readMandateBacking,
  releaseClosesMandate,
  type MandateBacking,
} from '../services/arc.js';
import { settlementService } from '../services/settlement.js';
import { readJson, readParams, readQuery } from '../validate.js';
import { money, moneyString, moneyStringOrZero, wireMandate } from '../wire.js';

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
  /**
   * Additional capital to commit. **Zero is allowed here and nowhere else money is parsed.**
   *
   * A mandate parked in `funding` is promoted by calling this route again once the deposit
   * lands, and that re-check must not cost the buyer a second commitment — asking them to
   * add another cent to be told their existing capital is now backed would be an amount the
   * book then quotes and the vault never received.
   */
  amountMinor: moneyStringOrZero,
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

  /*
   * Open the cash leg on Arc, here, because a deposit cannot land before it exists.
   *
   * `MandateVault.deposit` reverts `MandateNotRegistered` against an unregistered mandate, so
   * without this a mandate written through this route can never be escrowed — its vault key is
   * `keccak256(uuid)` and nothing had ever registered one. That was the state of things: the
   * single working mandate had been registered by hand, and `pnpm demo:reset` picked up the
   * rest between rehearsals, so anything created in between stayed unescrowable and every quote
   * it would have made would have been unbacked.
   *
   * It runs at creation rather than at funding because the ordering is the contract's, not a
   * preference: registration → the buyer's own deposit → funding verified against the balance.
   * Registering at funding time would arrive one step after the deposit it exists to permit.
   *
   * **A chain that is down costs the registration, not the mandate.** Writing a bid is a
   * business act, and `ensureMandateRegistered` answers a state rather than throwing — the same
   * trade `services/uniqueness.ts` makes, where `checked: false` is deliberately not
   * `claimed: false`. The state is on the response because an unregistered mandate otherwise
   * fails much later, inside a contract revert nobody reads.
   */
  const registration = await ensureMandateRegistered(getArcEscrow(), row.id, buyer.arcAddress);

  return c.json(
    { mandate: wireMandate(row), quoting: false, escrowRegistration: registration },
    201,
  );
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
  // Paired with its row as it is read, so every mandate has a backing by construction. A
  // lookup that could miss would need an `escrow: null` meaning nothing that any client parses.
  const priced = await Promise.all(
    rows.map(async (row) => ({
      row,
      backing: await readMandateBacking(escrow, row.id, row.fundedMinor, row.currency),
    })),
  );

  return c.json({
    mandates: priced.map(({ row, backing }) => ({
      ...wireMandate(row),
      /** Only an active mandate quotes; `funding` is not yet firm. */
      quoting: row.status === 'active',
      operator,
      debtorExposure: renderExposure(exposure.get(row.id) ?? {}),
      escrow: wireBacking(backing),
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

/**
 * Escrow the capital. This is the moment the bid becomes firm — or starts trying to.
 *
 * **Funding is two states, not one write.** The mandate machine says so: `draft -> funding` is
 * where "escrow of `totalCommitted` begins", and `funding -> active` is where "escrow
 * confirmed. Only now is the quote firm." This route used to collapse both into a single
 * `status: 'active'`, performing an edge the machine refuses and leaving `funding` written by
 * nothing anywhere in the repo — the same defect as `listed`, in the other lifecycle.
 *
 * So an unbacked funding is now **recorded and parked**, not refused. The invariant it used to
 * protect — unbacked capital never quotes — is kept by the state instead of by the 400, and
 * kept better: the buyer's commitment is on file, and when their deposit lands a second call to
 * this route promotes the mandate rather than asking them to re-state an amount they already
 * gave. `listQuotableMandates` selects `active` alone, so a `funding` mandate prices nothing.
 *
 * **The one case still refused is a top-up of a bid that is already firm.** There is nowhere to
 * park that: the machine has no `active -> funding` on purpose — topping up a live bid raises
 * its capital in place and does not make it provisional again — so the only alternative to
 * refusing would be an `active` mandate quoting against capital the vault does not hold, which
 * is the overclaim this check has always existed to refuse.
 */
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
   * actually there. A commitment the vault does not cover is parked in `funding` and does not
   * quote; only a top-up of an already-firm bid is refused outright, for want of anywhere to
   * park it. With no vault configured the read is unavailable rather than zero, `state` is
   * how the two are told apart, and the response says which happened so that "escrowed" is
   * never an assumption a reader has to make.
   */
  const escrow = getArcEscrow();

  /*
   * Registration, repaired rather than assumed.
   *
   * `POST /v1/mandates` opens the cash leg, and this is the second attempt for the case where
   * that one could not reach the chain. It is a view call on every run after the first, so the
   * cost of asking is one `buyerOf`, and the alternative is a buyer whose deposit reverts with
   * a contract error and who is then told by the check below only that "the vault holds 0" —
   * true, and silent about the reason it could never have held anything else.
   *
   * It cannot put THIS bid on the curve: the deposit had to precede the funding call, and it
   * could not have. What it does is make the next one possible — and the commitment is
   * recorded meanwhile, so the buyer deposits and funds again rather than starting over.
   */
  const buyer = await store.getBuyer(existing.buyerId);
  const registration = await ensureMandateRegistered(escrow, id, buyer?.arcAddress ?? null);

  /*
   * Converted before it is compared, and in one place. The vault answers in USDC minor units
   * at 6 decimals and a mandate is written in its own currency's minor units at 2, so the two
   * are not the same number even when they read as one — $50,000.00 and 5 USDC are both
   * `5000000`, and comparing them directly is how a mandate came to be counted as backed by a
   * ten-thousandth of its capital. `readMandateBacking` is that comparison; this route and the
   * list screen used to each carry their own copy of it, facing opposite directions.
   */
  const wouldBeCommitted = existing.fundedMinor + body.amountMinor;
  const backing = await readMandateBacking(escrow, id, wouldBeCommitted, existing.currency);
  const firm = backingMakesBidFirm(backing);

  /*
   * A bid that is already firm has nowhere to be parked, so an unverifiable top-up is refused
   * rather than recorded — see the note on this route. `bad_request` for capital that is short
   * (the buyer can fix that by depositing) and `upstream_unavailable` for a vault that would
   * not answer (nobody can fix that by trying harder, only by trying again), because the two
   * ask for different things from the reader.
   */
  const alreadyFirm = existing.status === 'active' || existing.status === 'exhausted';
  if (!firm && alreadyFirm) {
    /*
     * Why the deposit could not have landed, when that is the reason. An empty vault against
     * an unregistered mandate is not a buyer who forgot to send money; it is a buyer whose
     * transaction reverted, and saying only "the vault holds 0" would send them to look at
     * their wallet instead of at the registration.
     */
    throw backing.state === 'unreadable'
      ? upstreamUnavailable('The Arc mandate vault', `${backing.detail} ${registration.detail}`)
      : badRequest(`${backing.detail} ${registration.detail}`);
  }

  const mandate = await store.fundMandate({
    mandateId: id,
    amount: body.amountMinor,
    escrowRef: body.escrowRef,
    at: new Date(),
    firm,
  });

  return c.json({
    mandate: wireMandate(mandate),
    /** The moment the bid became firm. Before this the mandate is not on the curve. */
    quoting: mandate.status === 'active',
    /**
     * Whether the amount above was checked against capital that actually exists, or merely
     * recorded. A reader must not have to infer which, so it is stated rather than implied
     * by the presence of an escrow reference.
     *
     * The narrow question, not `escrow.enabled`: a vault that is configured but would not
     * answer verified nothing, and saying otherwise is the overclaim in its quietest form.
     */
    escrowVerified: backingWasRead(backing),
    /** What stands behind the commitment, in the vault's own units. See `escrow` on `GET /`. */
    escrow: wireBacking(backing),
    /**
     * Why the bid is or is not on the curve, in words.
     *
     * A mandate left in `funding` is not a failure and does not come back as one, so the
     * status code cannot carry this — the buyer has to be told the difference between "your
     * bid is live" and "your bid is recorded and waiting for your deposit", and told what to
     * do about the second.
     */
    message:
      mandate.status === 'active'
        ? 'This bid is on the curve.'
        : `${backing.detail} This bid is recorded and is not quoting; fund it again once the ` +
          `deposit has landed and it will go live. ${registration.detail}`,
    /** Whether the mandate's cash leg exists on Arc, which is what makes a deposit possible. */
    escrowRegistration: registration,
  });
});

/**
 * Withdraw unallocated capital. Allocated capital is committed against trades in flight
 * and is not withdrawable — that is what "firm" means.
 *
 * **This used to decrement a SQLite row and stop there.** `MandateVault.executeRelease` was
 * not in the backend's ABI and had no caller anywhere, so real USDC in the vault had no path
 * out of it in this repo at all: a buyer could post capital, watch the book give the capacity
 * back, and never see the money. The book and the money move together now.
 *
 * **And moving them together took three steps rather than two, which is the second fix.** The
 * book decremented first — correctly, so the attested balance is never above the real one —
 * but it decremented for releases that were never going to happen: an unregistered mandate, a
 * binding to somebody else, a vault that was short, a vault that would not answer. The book hit
 * zero, the mandate was `withdrawn` on the spot, `fundMandate` refuses a withdrawn mandate, and
 * the buyer's USDC sat in the vault under `keccak256(uuid)` with nothing in this repo able to
 * move it — a replacement mandate is a new UUID and a new vault bucket. So:
 *
 * 1. **Ask first.** Every refusal is a view call, so a request that cannot succeed is refused
 *    with nothing moved. A 200 from here means the book and the money moved together, or the
 *    vault provably holds nothing to move — that last one being a commitment recorded against a
 *    deposit that never landed, which is the book's own fiction and has to stay retractable.
 * 2. **Then the book, then the chain**, in that order and for the reason above.
 * 3. **Close only against a known-empty vault.** An unknown outcome leaves the mandate open at
 *    a zero balance, because funding it again is the one route back to capital that is still
 *    in there.
 */
mandateRoutes.post('/:id/withdraw', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readJson(c, withdrawBody);
  const store = getStore();
  const at = new Date();

  // A buyer withdrawing "everything unallocated" must not be short-changed by capital
  // reserved for a trade whose challenge window has already run out.
  await settlementService.reclaimExpired();

  const existing = await store.getMandate(id);
  if (!existing) throw notFound(`Mandate ${id}`);

  /*
   * What this withdrawal intends to take, resolved here so the vault can be asked about it
   * before anything moves. **The store remains the authority**: it re-reads under its own lock
   * and refuses a figure that no longer fits, which is what makes a withdrawal racing a match
   * lose to the match. Naming the amount rather than passing "everything" is what turns that
   * race into a 409 with nothing moved, instead of a release planned for one amount and a book
   * decremented by another.
   */
  const unallocated =
    existing.fundedMinor > existing.allocatedMinor
      ? existing.fundedMinor - existing.allocatedMinor
      : 0n;
  const wanted = body.amountMinor ?? unallocated;

  /*
   * The buyer on file, read only to be COMPARED against the vault's own binding. It is never
   * sent: `executeRelease` takes no recipient and always pays `buyerOf`, which is the bound
   * that stops a compromised relay redirecting a buyer's capital. What the comparison catches
   * is the other half — a vault bound to an address this venue does not believe is the
   * buyer's, where triggering the release would move their money to a stranger.
   */
  const buyer = await store.getBuyer(existing.buyerId);

  const vault = getArcEscrow();
  const plan = await planCapitalRelease(vault, {
    mandateUuid: id,
    committedMinor: existing.fundedMinor,
    amountMinor: wanted,
    currency: existing.currency,
    buyerAddress: buyer?.arcAddress ?? null,
  });

  /*
   * Refused with nothing moved, rather than reported after the fact.
   *
   * `upstream_unavailable` for a vault that would not answer and `conflict` for one that
   * answered something this venue will not act on, the same split the funding route draws: a
   * reader can fix the second and can only retry the first.
   */
  if (!plan.ok) {
    throw plan.refusal.state === 'unavailable'
      ? upstreamUnavailable('The Arc mandate vault', plan.refusal.detail)
      : conflict('conflict', plan.refusal.detail);
  }

  /*
   * **The book moves first and the chain second, and the order is chosen rather than
   * incidental.** `IMandateVault` states the invariant the whole split rests on: the attested
   * balance must be a lower bound on real Arc capital at every instant, so the book decrements
   * at the moment it authorises, before the tokens move. Reversed, a release that lands after
   * the decrement failed leaves a mandate quoting capital that has already left, and every
   * price it wins is one nobody can honour.
   */
  const { mandate, withdrawn } = await store.withdrawFromMandate({
    mandateId: id,
    amount: wanted,
    at,
  });

  const release = await executeCapitalRelease(vault, id, plan);

  /*
   * Closed last, and only against a vault known to hold nothing more for this mandate.
   *
   * `withdrawn` is terminal and a withdrawn mandate cannot be funded, so this is the write that
   * decides whether capital left behind is recoverable. A release whose receipt never arrived
   * says `remainingUsdcMinor: null` — a timeout is not a revert, the USDC may still be sitting
   * there — and the mandate then stays open at a zero balance so it can be funded and withdrawn
   * again. So does a vault that returned less than it holds, which is how a buyer who
   * overfunded their own mandate gets the excess back.
   */
  const closed =
    mandate.fundedMinor === 0n && releaseClosesMandate(release)
      ? await store.closeEmptiedMandate(id, at)
      : mandate;

  return c.json({
    mandate: wireMandate(closed),
    withdrawn: money(withdrawn),
    quoting: closed.status === 'active',
    /**
     * What became of the real USDC, in the vault's own units.
     *
     * `withdrawn` above is the mandate's currency at 2 decimals and `amountUsdcMinor` is USDC
     * at 6 — the pair is published for the same reason the funding route publishes both sides
     * of its comparison, because the defect being guarded against is two scales sharing one
     * name.
     *
     * `remainingUsdcMinor` is what says whether anything is left in the vault behind this
     * mandate, and `null` there means nobody knows rather than nothing is left. It is the
     * figure the mandate's closure turns on, so a buyer reading a mandate that stayed open at a
     * zero balance can see why.
     */
    release: {
      ...release,
      amountUsdcMinor: money(release.amountUsdcMinor),
      remainingUsdcMinor:
        release.remainingUsdcMinor === null ? null : money(release.remainingUsdcMinor),
    },
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

/**
 * Whether a bid is backed by capital anyone can verify, and how much.
 *
 * `backed` is deliberately not `deposited > 0`: a mandate counted as holding more than the
 * vault does is exactly the overclaim the funding check refuses, and a partially-backed bid
 * must not read as a funded one.
 *
 * Both figures are USDC ERC-20 minor units (6dp) and the field names say so, because the defect
 * this replaced was two scales sharing one name. `requiredUsdcMinor` is what makes them
 * comparable — it is the mandate's own committed capital put through the same conversion the
 * cash leg settles through, so the comparison is like with like. Rendering either as the
 * mandate's currency is off by four orders of magnitude, which is what the screen was doing.
 *
 * `state` is the field a reader should use for anything other than "is it backed": it tells an
 * empty vault from an unreadable one from a deployment that has no vault at all, and those
 * three used to be one `false`.
 */
const wireBacking = (backing: MandateBacking) => ({
  state: backing.state,
  checked: backing.checked,
  depositedUsdcMinor:
    backing.depositedUsdcMinor === null ? null : money(backing.depositedUsdcMinor),
  requiredUsdcMinor: money(backing.requiredUsdcMinor),
  backed: backing.backed,
});

/** Exposure maps carry `bigint` values, which `JSON.stringify` throws on. */
const renderExposure = (exposure: Readonly<Record<string, bigint>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(exposure).map(([debtorId, amount]) => [debtorId, money(amount)]),
  );
