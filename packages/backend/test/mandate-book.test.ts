/**
 * The venue's match decision, asked of the chain.
 *
 * `MandateBook` was deployed on 2026-09-01 and called by nothing for five days. What makes wiring
 * it worth doing is narrow and worth stating: `previewMatch` reads the rating, the confirmation,
 * the due date and the face value out of `InvoiceRegistry` rather than from whoever is asking, so
 * it is the one verdict on the arm path the venue cannot have arranged.
 *
 * Everything here is about the three-state answer and about never letting a publication failure
 * cost a bid. The book decides nothing in this build — it is asked, and its answer is published
 * beside the venue's own — so the tests that matter are the ones proving it cannot do damage.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { call, createHarness, listInvoice, type Harness } from './helpers.js';
import {
  BOOK_MAX_TENOR_DAYS,
  BOOK_MAX_YIELD_BPS,
  createDisabledMandateBook,
  createMandateBook,
  creditFundingOnBook,
  decodeReason,
  depositRefFor,
  ensureMandatePosted,
  ratingOrdinal,
  type MandateBook,
  type MatchPreview,
} from '../src/services/mandate-book.js';

let h: Harness;

/** List, quote, arm. The seeded book is confirmed rather than listed, so listing comes first. */
async function armATrade() {
  const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
  await listInvoice(h.app, invoiceId);
  const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote`);
  return call(h.app, 'POST', '/v1/trades', {
    body: { invoiceId, quoteId: quote.body.quoteId },
  });
}

const MANDATE = {
  id: '8b879d02-4593-4d66-82bf-52d4833401b6',
  chainMandateId: null as bigint | null,
  ratingFloor: 'B' as const,
  maxTenorDays: 90,
  annualisedYieldBps: 850,
  exposureLimitMinor: 5_000_000n,
  perDebtorLimitMinor: 1_000_000n,
  fundedMinor: 5_000_000n,
};

/** A book that records what it was asked and can be told to fail. */
function fakeBook(
  overrides: Partial<MandateBook> & { failPost?: boolean; failCredit?: boolean } = {},
): { book: MandateBook; seen: { posted: unknown[]; credited: unknown[] } } {
  const seen = { posted: [] as unknown[], credited: [] as unknown[] };
  const book: MandateBook = {
    enabled: true,
    address: '0x361f9d4b1101898417b2b9148bc8aa522024a38f',
    operatorAddress: '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71',
    postMandate: (params) => {
      if (overrides.failPost === true) return Promise.reject(new Error('relay down'));
      seen.posted.push(params);
      return Promise.resolve({ chainMandateId: '7', transactionHash: '0xpost' });
    },
    creditFunding: (params) => {
      if (overrides.failCredit === true) return Promise.reject(new Error('relay down'));
      seen.credited.push(params);
      return Promise.resolve({ transactionHash: '0xcredit' });
    },
    isDepositCredited: () => Promise.resolve(false),
    previewMatch: () =>
      Promise.resolve({
        checked: true,
        ok: true,
        code: null,
        priceMinor: '1232534',
        tenorDays: 60,
        detail: 'ok',
      }),
    ...overrides,
  };
  return { book, seen };
}

const recordingStore = () => {
  const writes: { id: string; chainMandateId: bigint }[] = [];
  return {
    writes,
    setChainMandateId: (id: string, chainMandateId: bigint) => {
      writes.push({ id, chainMandateId });
      return Promise.resolve(undefined);
    },
  };
};

describe('ratingOrdinal', () => {
  /**
   * `FactureTypes.sol` says its `Rating` enum "is the on-chain mirror of `RATING_RANK` in
   * `@facture/shared`" and that the two must not drift, because the off-chain quote engine
   * decides what a seller is shown and the enum decides what actually matches. A disagreement is
   * a venue that quotes paper it will then refuse, so the ordinals are pinned here as literals
   * rather than derived from the same table they are checking.
   */
  it('matches the Solidity enum ordinals exactly', () => {
    expect(ratingOrdinal('D')).toBe(0);
    expect(ratingOrdinal('UNRATED')).toBe(1);
    expect(ratingOrdinal('C')).toBe(2);
    expect(ratingOrdinal('B')).toBe(3);
    expect(ratingOrdinal('A')).toBe(4);
  });

  /** D below UNRATED is deliberate: a default is information, an absence of history is not. */
  it('ranks a defaulted debtor below an unrated one', () => {
    expect(ratingOrdinal('D')).toBeLessThan(ratingOrdinal('UNRATED'));
  });
});

describe('decodeReason', () => {
  it('reads a reason code as the name it spells', () => {
    expect(decodeReason('0x524154494e475f42454c4f575f4d414e44415445000000000000000000000000')).toBe(
      'RATING_BELOW_MANDATE',
    );
  });
});

describe('depositRefFor', () => {
  it('is stable for one mandate at one committed total', () => {
    expect(depositRefFor(MANDATE.id, 5_000_000n)).toBe(depositRefFor(MANDATE.id, 5_000_000n));
  });

  /**
   * The book refuses a reference it has seen. Keying on the cumulative total means re-funding to
   * the same figure is refused by the chain while a genuine top-up is a new reference — which is
   * the guard doing something real, and is strictly weaker than the vault-minted reference it
   * stands in for. `depositRefFor`'s own comment says which claim it does not support.
   */
  it('differs per mandate and per committed total', () => {
    expect(depositRefFor(MANDATE.id, 5_000_000n)).not.toBe(depositRefFor(MANDATE.id, 5_000_001n));
    expect(depositRefFor(MANDATE.id, 5_000_000n)).not.toBe(depositRefFor('other', 5_000_000n));
  });
});

describe('ensureMandatePosted', () => {
  it('reports a disabled book rather than pretending to publish', async () => {
    const posting = await ensureMandatePosted(createDisabledMandateBook(), MANDATE);
    expect(posting.state).toBe('disabled');
    expect(posting.chainMandateId).toBeNull();
  });

  it('posts a mandate the book has never seen, with the rating as an ordinal', async () => {
    const { book, seen } = fakeBook();
    const posting = await ensureMandatePosted(book, MANDATE);

    expect(posting.state).toBe('posted');
    expect(posting.chainMandateId).toBe('7');
    expect(seen.posted[0]).toMatchObject({ minRating: 'B', maxTenorDays: 90 });
  });

  it('does not post twice', async () => {
    const { book, seen } = fakeBook();
    const posting = await ensureMandatePosted(book, { ...MANDATE, chainMandateId: 7n });

    expect(posting.state).toBe('already-posted');
    expect(seen.posted).toHaveLength(0);
  });

  /**
   * `postMandate` mints a fresh id on every call and there is no update path, so a second posting
   * would strand whatever was credited against the first. Not posting twice is a correctness
   * property, not a saving.
   */
  it('refuses terms the book would take but the buyer never wrote', async () => {
    const { book, seen } = fakeBook();
    const posting = await ensureMandatePosted(book, {
      ...MANDATE,
      annualisedYieldBps: BOOK_MAX_YIELD_BPS + 1,
    });

    expect(posting.state).toBe('out-of-range');
    expect(seen.posted).toHaveLength(0);
    expect(posting.detail).toContain(String(BOOK_MAX_YIELD_BPS));
  });

  it('refuses a tenor past the book ceiling', async () => {
    const { book } = fakeBook();
    const posting = await ensureMandatePosted(book, {
      ...MANDATE,
      maxTenorDays: BOOK_MAX_TENOR_DAYS + 1,
    });
    expect(posting.state).toBe('out-of-range');
  });

  /** A chain that is down costs the publication, never the bid. */
  it('never throws when the chain will not take the write', async () => {
    const { book } = fakeBook({ failPost: true });
    const posting = await ensureMandatePosted(book, MANDATE);

    expect(posting.state).toBe('unavailable');
    expect(posting.detail).toContain('relay down');
    expect(posting.detail).toContain('The bid stands');
  });
});

describe('creditFundingOnBook', () => {
  it('posts the mandate first when it has never been on the book', async () => {
    const { book, seen } = fakeBook();
    const store = recordingStore();

    const result = await creditFundingOnBook(book, MANDATE, store);

    expect(result.state).toBe('credited');
    expect(seen.posted).toHaveLength(1);
    // The join is stored, or the mandate is unaddressable the moment the transaction returns.
    expect(store.writes).toEqual([{ id: MANDATE.id, chainMandateId: 7n }]);
  });

  /**
   * Cents, never USDC. The book prices from `InvoiceRegistry.faceValue`, which is listed in the
   * invoice's own minor units, so `EXPOSURE_EXHAUSTED` has to compare like with like. Crediting a
   * 6-decimal USDC figure would put a ppm-scaled number beside a cents one on a contract that
   * cannot be patched — the `units.ts` defect, reproduced where it is permanent.
   */
  it('credits the committed capital in the mandate currency, not USDC', async () => {
    const { book, seen } = fakeBook();
    await creditFundingOnBook(book, { ...MANDATE, chainMandateId: 7n }, recordingStore());

    expect(seen.credited[0]).toMatchObject({ amountMinor: 5_000_000n, chainMandateId: 7n });
  });

  it('names the operator as funder, because that is the only address it can honestly name', async () => {
    const { book, seen } = fakeBook();
    await creditFundingOnBook(book, { ...MANDATE, chainMandateId: 7n }, recordingStore());

    expect(seen.credited[0]).toMatchObject({
      funder: '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71',
    });
  });

  it('does not credit the same committed total twice', async () => {
    const { book, seen } = fakeBook({ isDepositCredited: () => Promise.resolve(true) });
    const result = await creditFundingOnBook(
      book,
      { ...MANDATE, chainMandateId: 7n },
      recordingStore(),
    );

    expect(result.state).toBe('already-credited');
    expect(seen.credited).toHaveLength(0);
  });

  it('reports rather than throws when the write fails', async () => {
    const { book } = fakeBook({ failCredit: true });
    const result = await creditFundingOnBook(
      book,
      { ...MANDATE, chainMandateId: 7n },
      recordingStore(),
    );

    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('The commitment stands here');
  });

  it('says the commitment is not on the book when the posting failed', async () => {
    const { book } = fakeBook({ failPost: true });
    const result = await creditFundingOnBook(book, MANDATE, recordingStore());

    expect(result.state).toBe('not-posted');
    expect(result.chainMandateId).toBeNull();
  });
});

describe('previewMatch', () => {
  /**
   * THREE STATES, NEVER TWO.
   *
   * A book that is not configured and a mandate that was never posted are both "the chain was not
   * asked", and folding either into `ok: false` would print a refusal the chain never made. This
   * is the `/health` cursor, `ComplianceDecision.determinate` and the proof view's registry block
   * — each of which was a defect before it was a rule.
   */
  it('answers checked:false rather than a refusal when no book is configured', async () => {
    const preview = await createDisabledMandateBook().previewMatch('invoice', 1n);

    expect(preview.checked).toBe(false);
    expect(preview.ok).toBeNull();
    expect(preview.code).toBeNull();
  });

  /**
   * The commonest reason the chain has nothing to say, and the one most likely to be misread as a
   * refusal. Exercised against the real service rather than the fake, because the whole point is
   * that it short-circuits BEFORE any RPC — so a mandate that predates the book costs no call and
   * produces no verdict.
   */
  it('answers checked:false for a mandate that was never posted', async () => {
    const book = createMandateBook({
      bookAddress: '0x361f9d4b1101898417b2b9148bc8aa522024a38f',
      operatorKey: `0x${'11'.repeat(32)}`,
    });

    const preview = await book.previewMatch('4ec34f9d-cbac-4727-9cdb-88aaaa36625a', null);

    expect(preview.checked).toBe(false);
    expect(preview.ok).toBeNull();
    expect(preview.detail).toContain('That is not a refusal');
  });
});

describe('the book on the arm path', () => {
  /**
   * The route calls `previewMatch` and publishes the answer. These cover the seam rather than the
   * service, because the failure worth catching is the response quietly losing the field: nothing
   * downstream depends on `book`, so a decoder that stopped reading it would break no test and no
   * screen, and the claim that a buyer can check the venue against the chain would go with it.
   */
  afterEach(() => {
    h.restore();
  });

  const bookSaying = (preview: MatchPreview): MandateBook => ({
    ...createDisabledMandateBook(),
    enabled: true,
    address: '0x361f9d4b1101898417b2b9148bc8aa522024a38f',
    previewMatch: () => Promise.resolve(preview),
  });

  const agrees: MatchPreview = {
    checked: true,
    ok: true,
    code: null,
    priceMinor: '392094',
    tenorDays: 39,
    detail: 'the book would take this match',
  };

  it('publishes the chain answer on the challenge', async () => {
    h = await createHarness({ mandateBook: bookSaying(agrees) });
    const armed = await armATrade();

    expect(armed.status).toBe(402);
    expect(armed.body.book).toMatchObject({ checked: true, ok: true, tenorDays: 39 });
  });

  /**
   * The venue prices 392093 where the book prices 392094, because one ceils the discount and the
   * other floors it. Both numbers are published and neither is corrected — refusing on the
   * difference would reject a trade both parties would take, over a rounding rule.
   */
  it('arms the trade even when the book prices it a minor unit apart', async () => {
    h = await createHarness({ mandateBook: bookSaying(agrees) });
    const armed = await armATrade();

    expect(armed.status).toBe(402);
    expect(armed.body.book.priceMinor).toBe('392094');
  });

  /**
   * The one that decides whether wiring the book was safe. The chain refusing is published, and
   * the sale still happens, because the book is a second opinion on a decision the venue has
   * already made against its own ledger. If this ever starts returning 4xx, the book has quietly
   * become an authority nobody agreed to give it.
   */
  it('does not let a refusal from the chain block the sale', async () => {
    h = await createHarness({
      mandateBook: bookSaying({
        checked: true,
        ok: false,
        code: 'RATING_BELOW_MANDATE',
        priceMinor: '0',
        tenorDays: 39,
        detail: 'the book would refuse this match',
      }),
    });

    const armed = await armATrade();

    expect(armed.status).toBe(402);
    expect(armed.body.book).toMatchObject({ ok: false, code: 'RATING_BELOW_MANDATE' });
  });

  /** No book configured is the default, and it must read as "not asked" rather than as a no. */
  it('reports checked:false rather than a refusal when no book is configured', async () => {
    h = await createHarness();
    const armed = await armATrade();

    expect(armed.status).toBe(402);
    expect(armed.body.book).toMatchObject({ checked: false, ok: null, code: null });
  });
});
