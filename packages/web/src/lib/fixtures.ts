/**
 * Every number on every screen comes from here.
 *
 * This is the one file that stands in for the API. When the backend lands, this module
 * keeps its exported shape — `invoices`, `mandates`, `getInvoice(id)` and so on — and its
 * bodies become fetches. No component reaches past it.
 *
 * Three things are derived rather than typed in, so the book cannot drift out of
 * agreement with itself:
 *
 *   - every position's **outlay** is `priceInvoice(face, bid, tenor at purchase)`;
 *   - every mandate's **allocated** capital and per-debtor exposure are summed from its
 *     own open positions;
 *   - every **uniqueness hash and ISIN** is computed from the invoice, exactly as the
 *     registry and the issuance path would compute them.
 *
 * The clock is frozen at `MARKET_NOW`. Two reasons, both load-bearing: tenors, ladders and
 * prices are then identical on the server and in the browser, so nothing hydrates
 * differently to how it rendered; and the demo reads the same on any day of the week.
 */

import type { Currency, Debtor, Invoice, InvoiceStatus, Mandate, Rating, Trade } from './domain';
import { isinForInvoice, priceInvoice, tenorDays, uniquenessHash } from './domain';
import type { Position } from './pricing';
import { toMinor } from './format';

/** The market clock. Frozen so the book is reproducible. */
export const MARKET_NOW_ISO = '2026-09-01T09:32:00.000Z';

export function marketNow(): Date {
  return new Date(MARKET_NOW_ISO);
}

const USD: Currency = 'USD';

/** A day, as an instant. Fixtures are written as calendar dates. */
const at = (day: string): string => `${day}T00:00:00.000Z`;

/** Contract address, derived from the receivable's own hash so the two agree. */
const addressFromHash = (hash: string): `0x${string}` => `0x${hash.slice(26)}` as `0x${string}`;

/* -------------------------------------------------------------------------- */
/* The parties                                                                 */
/* -------------------------------------------------------------------------- */

export const seller = {
  id: 'SEL-MERIDIAN',
  name: 'Meridian Fabrication',
  contact: 'accounts@meridianfab.co',
  memberSince: '2026-05-12',
} as const;

/**
 * Whoever is looking at the buyer screens. Bids are public in this market; exposure is
 * not, so a mandate someone else funded shows its terms and nothing else.
 */
export const viewer = {
  buyerId: 'BUY-ASHGROVE',
  name: 'Ashgrove Treasury',
} as const;

/* -------------------------------------------------------------------------- */
/* Customers                                                                   */
/* -------------------------------------------------------------------------- */

export const debtors: readonly Debtor[] = [
  {
    id: 'DBT-LUMEN',
    name: 'Lumen Grid Utilities',
    rating: 'A',
    onTimeCount: 21,
    defaultCount: 0,
    confirmedCount: 23,
    createdAt: at('2025-11-04'),
  },
  {
    id: 'DBT-HALDEN',
    name: 'Halden Aerospace',
    rating: 'A',
    onTimeCount: 14,
    defaultCount: 0,
    confirmedCount: 16,
    createdAt: at('2026-01-19'),
  },
  {
    id: 'DBT-ASHFIELD',
    name: 'Ashfield Rail Group',
    rating: 'A',
    onTimeCount: 12,
    defaultCount: 0,
    confirmedCount: 13,
    createdAt: at('2026-02-02'),
  },
  {
    id: 'DBT-NORTHWIND',
    name: 'Northwind Logistics',
    rating: 'B',
    onTimeCount: 9,
    defaultCount: 0,
    confirmedCount: 11,
    createdAt: at('2026-02-27'),
  },
  {
    id: 'DBT-CALDER',
    name: 'Calder & Roe',
    rating: 'B',
    onTimeCount: 7,
    defaultCount: 0,
    confirmedCount: 9,
    createdAt: at('2026-03-15'),
  },
  {
    id: 'DBT-PETRA',
    name: 'Petra Foods Group',
    rating: 'C',
    onTimeCount: 5,
    defaultCount: 0,
    confirmedCount: 7,
    createdAt: at('2026-04-08'),
  },
  {
    id: 'DBT-VANTAGE',
    name: 'Vantage Clinical',
    rating: 'C',
    onTimeCount: 4,
    defaultCount: 0,
    confirmedCount: 5,
    createdAt: at('2026-04-30'),
  },
  {
    id: 'DBT-ORRIN',
    name: 'Orrin Metalworks',
    rating: 'D',
    onTimeCount: 3,
    defaultCount: 1,
    confirmedCount: 6,
    createdAt: at('2026-05-21'),
  },
  {
    id: 'DBT-SABLE',
    name: 'Sable Interiors',
    rating: 'UNRATED',
    onTimeCount: 0,
    defaultCount: 0,
    confirmedCount: 1,
    createdAt: at('2026-08-18'),
  },
];

const debtorsById = new Map(debtors.map((d) => [d.id, d]));

export function getDebtor(id: string): Debtor | undefined {
  return debtorsById.get(id);
}

export function getDebtorByName(name: string): Debtor | undefined {
  const wanted = name.trim().toLowerCase();
  return debtors.find((d) => d.name.toLowerCase() === wanted);
}

/* -------------------------------------------------------------------------- */
/* The book                                                                    */
/* -------------------------------------------------------------------------- */

interface InvoiceSpec {
  id: string;
  invoiceNumber: string;
  debtorId: string;
  face: number;
  issuedOn: string;
  dueOn: string;
  status: InvoiceStatus;
  /** False while the instrument is still being issued — the book shows "being added". */
  issued?: boolean;
}

const INVOICE_SPECS: readonly InvoiceSpec[] = [
  // Quotable, priced right now.
  {
    id: 'INV-2041',
    invoiceNumber: 'MF-2041',
    debtorId: 'DBT-HALDEN',
    face: 40_000,
    issuedOn: '2026-08-31',
    dueOn: '2026-10-31',
    status: 'confirmed',
  },
  {
    id: 'INV-2038',
    invoiceNumber: 'MF-2038',
    debtorId: 'DBT-LUMEN',
    face: 128_400,
    issuedOn: '2026-08-26',
    dueOn: '2026-09-25',
    status: 'listed',
  },
  {
    id: 'INV-2044',
    invoiceNumber: 'MF-2044',
    debtorId: 'DBT-NORTHWIND',
    face: 18_750,
    issuedOn: '2026-08-31',
    dueOn: '2026-11-15',
    status: 'confirmed',
  },
  {
    id: 'INV-2045',
    invoiceNumber: 'MF-2045',
    debtorId: 'DBT-CALDER',
    face: 9_600,
    issuedOn: '2026-08-17',
    dueOn: '2026-09-16',
    status: 'confirmed',
  },
  {
    id: 'INV-2046',
    invoiceNumber: 'MF-2046',
    debtorId: 'DBT-PETRA',
    face: 62_300,
    issuedOn: '2026-08-28',
    dueOn: '2026-12-04',
    status: 'confirmed',
  },
  {
    id: 'INV-2047',
    invoiceNumber: 'MF-2047',
    debtorId: 'DBT-ORRIN',
    face: 27_500,
    issuedOn: '2026-08-29',
    dueOn: '2026-10-16',
    status: 'confirmed',
  },
  {
    id: 'INV-2048',
    invoiceNumber: 'MF-2048',
    debtorId: 'DBT-SABLE',
    face: 6_400,
    issuedOn: '2026-08-30',
    dueOn: '2026-10-01',
    status: 'confirmed',
  },

  // Waiting on the customer.
  {
    id: 'INV-2049',
    invoiceNumber: 'MF-2049',
    debtorId: 'DBT-VANTAGE',
    face: 44_000,
    issuedOn: '2026-08-31',
    dueOn: '2026-11-30',
    status: 'awaiting_confirmation',
  },
  {
    id: 'INV-2050',
    invoiceNumber: 'MF-2050',
    debtorId: 'DBT-HALDEN',
    face: 21_900,
    issuedOn: '2026-08-31',
    dueOn: '2026-10-09',
    status: 'awaiting_confirmation',
  },

  // Added this morning; the instrument has not landed yet.
  {
    id: 'INV-2051',
    invoiceNumber: 'MF-2051',
    debtorId: 'DBT-NORTHWIND',
    face: 12_250,
    issuedOn: '2026-09-01',
    dueOn: '2026-09-30',
    status: 'draft',
    issued: false,
  },
  {
    id: 'INV-2052',
    invoiceNumber: 'MF-2052',
    debtorId: 'DBT-PETRA',
    face: 8_900,
    issuedOn: '2026-09-01',
    dueOn: '2026-10-20',
    status: 'draft',
    issued: false,
  },

  // Closed, one way or another.
  {
    id: 'INV-2033',
    invoiceNumber: 'MF-2033',
    debtorId: 'DBT-LUMEN',
    face: 95_000,
    issuedOn: '2026-08-12',
    dueOn: '2026-09-12',
    status: 'sold',
  },
  {
    id: 'INV-2029',
    invoiceNumber: 'MF-2029',
    debtorId: 'DBT-NORTHWIND',
    face: 33_400,
    issuedOn: '2026-07-14',
    dueOn: '2026-08-28',
    status: 'matured',
  },
  {
    id: 'INV-2043',
    invoiceNumber: 'MF-2043',
    debtorId: 'DBT-CALDER',
    face: 7_250,
    issuedOn: '2026-08-21',
    dueOn: '2026-10-05',
    status: 'disputed',
  },
  {
    id: 'INV-2031',
    invoiceNumber: 'MF-2031',
    debtorId: 'DBT-ORRIN',
    face: 15_800,
    issuedOn: '2026-07-06',
    dueOn: '2026-08-20',
    status: 'defaulted',
  },
];

function buildInvoice(spec: InvoiceSpec): Invoice {
  const faceValue = toMinor(spec.face);
  const hash = uniquenessHash(spec.debtorId, spec.invoiceNumber, faceValue);

  const base: Invoice = {
    id: spec.id,
    sellerId: seller.id,
    debtorId: spec.debtorId,
    faceValue,
    currency: USD,
    invoiceNumber: spec.invoiceNumber,
    issuedAt: at(spec.issuedOn),
    dueAt: at(spec.dueOn),
    status: spec.status,
    uniquenessHash: hash,
    createdAt: at(spec.issuedOn),
  };

  // Tokenisation happens at onboarding and is paced, so an invoice exists in the book
  // before its instrument does. Nothing on the quoting path may assume otherwise.
  if (spec.issued === false) return base;

  return { ...base, instrumentAddress: addressFromHash(hash), isin: isinForInvoice(hash) };
}

export const invoices: readonly Invoice[] = INVOICE_SPECS.map(buildInvoice);

const invoicesById = new Map(invoices.map((i) => [i.id, i]));

export function getInvoice(id: string): Invoice | undefined {
  return invoicesById.get(id);
}

/** The rating an invoice prices against is its customer's, never the seller's. */
export function ratingOf(invoice: Invoice): Rating {
  return getDebtor(invoice.debtorId)?.rating ?? 'UNRATED';
}

export function debtorNameOf(invoice: Invoice): string {
  return getDebtor(invoice.debtorId)?.name ?? 'Unknown customer';
}

/** The debtor record a quote has to be read against. */
export function debtorFor(invoice: Invoice): Debtor {
  return getDebtor(invoice.debtorId) ?? UNKNOWN_DEBTOR;
}

const UNKNOWN_DEBTOR: Debtor = {
  id: 'DBT-UNKNOWN',
  name: 'Unknown customer',
  rating: 'UNRATED',
  onTimeCount: 0,
  defaultCount: 0,
  confirmedCount: 0,
};

/**
 * Confirmation links. A debtor gets one of these by email and needs nothing else — no
 * account, no signature, no software.
 */
export const confirmationTokens: Readonly<Record<string, string>> = {
  kq7m2xhd: 'INV-2049',
  r4t8bdwp: 'INV-2050',
  n2v9slqe: 'INV-2043',
};

export function invoiceForToken(token: string): Invoice | undefined {
  const id = confirmationTokens[token];
  return id === undefined ? undefined : getInvoice(id);
}

export function tokenForInvoice(invoiceId: string): string | undefined {
  return Object.entries(confirmationTokens).find(([, id]) => id === invoiceId)?.[0];
}

/* -------------------------------------------------------------------------- */
/* Standing bids                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Display metadata for a mandate. A `Mandate` in the domain carries only policy and
 * capital — what it is called and who runs it are presentation, and belong here.
 */
export interface MandateMeta {
  name: string;
  ownerName: string;
  operator: 'desk' | 'agent';
}

export const mandateMeta: Readonly<Record<string, MandateMeta>> = {
  'MND-01': { name: 'Investment grade, 60 days', ownerName: 'Ashgrove Treasury', operator: 'desk' },
  'MND-05': { name: 'Prime 30', ownerName: 'Ashgrove Treasury', operator: 'desk' },
  'MND-04': { name: 'Unrated, short only', ownerName: 'Ashgrove Treasury', operator: 'agent' },
  'MND-02': { name: 'Short-dated A book', ownerName: 'Cordell Credit Partners', operator: 'desk' },
  'MND-03': { name: 'Broad yield ladder', ownerName: 'Tessellate Capital', operator: 'agent' },
  'MND-06': { name: 'Deep value, long tenor', ownerName: 'Harrow Point', operator: 'agent' },
};

const UNNAMED_MANDATE: MandateMeta = { name: 'A mandate', ownerName: 'A funder', operator: 'desk' };

export function metaOf(mandateId: string): MandateMeta {
  return mandateMeta[mandateId] ?? UNNAMED_MANDATE;
}

export const mandateName = (mandate: { id: string }): string => metaOf(mandate.id).name;

interface MandateSpec {
  id: string;
  buyerId: string;
  minRating: Rating;
  maxTenorDays: number;
  yieldBps: number;
  committed: number;
  perDebtor: number;
  fundedOn: string;
}

const MANDATE_SPECS: readonly MandateSpec[] = [
  {
    id: 'MND-01',
    buyerId: 'BUY-ASHGROVE',
    minRating: 'A',
    maxTenorDays: 60,
    yieldBps: 800,
    committed: 500_000,
    perDebtor: 120_000,
    fundedOn: '2026-06-02',
  },
  {
    id: 'MND-05',
    buyerId: 'BUY-ASHGROVE',
    minRating: 'A',
    maxTenorDays: 30,
    yieldBps: 675,
    committed: 400_000,
    perDebtor: 250_000,
    fundedOn: '2026-07-11',
  },
  {
    id: 'MND-02',
    buyerId: 'BUY-CORDELL',
    minRating: 'B',
    maxTenorDays: 90,
    yieldBps: 925,
    committed: 250_000,
    perDebtor: 50_000,
    fundedOn: '2026-06-19',
  },
  {
    id: 'MND-03',
    buyerId: 'BUY-TESSELLATE',
    minRating: 'C',
    maxTenorDays: 120,
    yieldBps: 1250,
    committed: 150_000,
    perDebtor: 40_000,
    fundedOn: '2026-07-28',
  },
  {
    id: 'MND-04',
    buyerId: 'BUY-ASHGROVE',
    minRating: 'UNRATED',
    maxTenorDays: 45,
    yieldBps: 1600,
    committed: 60_000,
    perDebtor: 15_000,
    fundedOn: '2026-08-14',
  },
  /*
   * The wide end of the book, and the reason INV-2046 has a price at all.
   *
   * Every other bid refuses that invoice: three sit above Petra Foods' `C`, the ladder that
   * does take `C` caps Petra at $40,000 against a $62,300 face, and the unrated book will not
   * go past 45 days. Without a bid down here the seller would be shown nothing, which is the
   * wrong answer. A market does not go silent on paper it dislikes — it quotes it worse. The
   * seller sees roughly 18.5% annualised against the 8% an A-rated name gets, decides whether
   * that is worth taking, and the price itself carries the information.
   *
   * The floor is `UNRATED` — the widest a buyer can actually write — and that is exactly why
   * INV-2047 still has no bid. On shared's scale `D` ranks BELOW `UNRATED`, so even a book
   * built to price cold starts and long tenors refuses a customer who has already defaulted.
   * One invoice with no price, for the one reason that no price is the honest answer.
   */
  {
    id: 'MND-06',
    buyerId: 'BUY-HARROW',
    minRating: 'UNRATED',
    maxTenorDays: 120,
    yieldBps: 1850,
    committed: 200_000,
    perDebtor: 75_000,
    fundedOn: '2026-08-24',
  },
];

/* -------------------------------------------------------------------------- */
/* Holdings                                                                    */
/* -------------------------------------------------------------------------- */

interface PositionSpec {
  id: string;
  mandateId: string;
  invoiceId: string;
  invoiceNumber: string;
  debtorId: string;
  face: number;
  boughtOn: string;
  dueOn: string;
}

/** Bought at the mandate's own bid, so every outlay below is the mandate's own price. */
const POSITION_SPECS: readonly PositionSpec[] = [
  // Ashgrove — Investment grade, 60 days
  {
    id: 'POS-01',
    mandateId: 'MND-01',
    invoiceId: 'INV-2033',
    invoiceNumber: 'MF-2033',
    debtorId: 'DBT-LUMEN',
    face: 95_000,
    boughtOn: '2026-08-14',
    dueOn: '2026-09-12',
  },
  {
    id: 'POS-02',
    mandateId: 'MND-01',
    invoiceId: 'INV-2018',
    invoiceNumber: 'MF-2018',
    debtorId: 'DBT-HALDEN',
    face: 56_000,
    boughtOn: '2026-08-06',
    dueOn: '2026-10-20',
  },
  {
    id: 'POS-03',
    mandateId: 'MND-01',
    invoiceId: 'INV-2027',
    invoiceNumber: 'MF-2027',
    debtorId: 'DBT-ASHFIELD',
    face: 71_500,
    boughtOn: '2026-08-20',
    dueOn: '2026-11-05',
  },

  // Ashgrove — Prime 30
  {
    id: 'POS-13',
    mandateId: 'MND-05',
    invoiceId: 'INV-2032',
    invoiceNumber: 'MF-2032',
    debtorId: 'DBT-LUMEN',
    face: 82_000,
    boughtOn: '2026-08-27',
    dueOn: '2026-09-19',
  },
  {
    id: 'POS-14',
    mandateId: 'MND-05',
    invoiceId: 'INV-2037',
    invoiceNumber: 'MF-2037',
    debtorId: 'DBT-LUMEN',
    face: 36_500,
    boughtOn: '2026-08-24',
    dueOn: '2026-09-08',
  },

  // Ashgrove — Unrated, short only (agent-run)
  {
    id: 'POS-10',
    mandateId: 'MND-04',
    invoiceId: 'INV-2036',
    invoiceNumber: 'MF-2036',
    debtorId: 'DBT-SABLE',
    face: 3_900,
    boughtOn: '2026-08-18',
    dueOn: '2026-09-14',
  },
  {
    id: 'POS-11',
    mandateId: 'MND-04',
    invoiceId: 'INV-2039',
    invoiceNumber: 'MF-2039',
    debtorId: 'DBT-ORRIN',
    face: 8_600,
    boughtOn: '2026-08-04',
    dueOn: '2026-09-05',
  },
  {
    id: 'POS-12',
    mandateId: 'MND-04',
    invoiceId: 'INV-2040',
    invoiceNumber: 'MF-2040',
    debtorId: 'DBT-PETRA',
    face: 14_000,
    boughtOn: '2026-08-26',
    dueOn: '2026-09-29',
  },

  // Cordell — Short-dated A book
  {
    id: 'POS-04',
    mandateId: 'MND-02',
    invoiceId: 'INV-2019',
    invoiceNumber: 'MF-2019',
    debtorId: 'DBT-NORTHWIND',
    face: 28_000,
    boughtOn: '2026-07-30',
    dueOn: '2026-09-18',
  },
  {
    id: 'POS-05',
    mandateId: 'MND-02',
    invoiceId: 'INV-2024',
    invoiceNumber: 'MF-2024',
    debtorId: 'DBT-CALDER',
    face: 42_000,
    boughtOn: '2026-08-11',
    dueOn: '2026-10-02',
  },
  {
    id: 'POS-06',
    mandateId: 'MND-02',
    invoiceId: 'INV-2030',
    invoiceNumber: 'MF-2030',
    debtorId: 'DBT-HALDEN',
    face: 8_000,
    boughtOn: '2026-08-01',
    dueOn: '2026-09-08',
  },

  // Tessellate — Broad yield ladder
  {
    id: 'POS-07',
    mandateId: 'MND-03',
    invoiceId: 'INV-2022',
    invoiceNumber: 'MF-2022',
    debtorId: 'DBT-PETRA',
    face: 36_000,
    boughtOn: '2026-08-05',
    dueOn: '2026-10-28',
  },
  {
    id: 'POS-08',
    mandateId: 'MND-03',
    invoiceId: 'INV-2026',
    invoiceNumber: 'MF-2026',
    debtorId: 'DBT-ORRIN',
    face: 9_400,
    boughtOn: '2026-08-09',
    dueOn: '2026-09-22',
  },
  {
    id: 'POS-09',
    mandateId: 'MND-03',
    invoiceId: 'INV-2034',
    invoiceNumber: 'MF-2034',
    debtorId: 'DBT-NORTHWIND',
    face: 25_000,
    boughtOn: '2026-08-25',
    dueOn: '2026-11-20',
  },
];

const yieldOf = new Map(MANDATE_SPECS.map((m) => [m.id, m.yieldBps]));

export const positions: readonly Position[] = POSITION_SPECS.map((spec) => {
  const bps = yieldOf.get(spec.mandateId) ?? 0;
  const faceValue = toMinor(spec.face);
  const held = tenorDays(at(spec.dueOn), at(spec.boughtOn));
  const debtor = getDebtor(spec.debtorId);

  return {
    id: spec.id,
    mandateId: spec.mandateId,
    invoiceId: spec.invoiceId,
    invoiceNumber: spec.invoiceNumber,
    debtorId: spec.debtorId,
    debtorName: debtor?.name ?? 'Unknown customer',
    rating: debtor?.rating ?? 'UNRATED',
    faceValue,
    outlay: priceInvoice(faceValue, bps, held).proceeds,
    annualisedYieldBps: bps,
    boughtAt: at(spec.boughtOn),
    dueAt: at(spec.dueOn),
    state: 'open',
  } satisfies Position;
});

export function positionsOf(mandateId: string): Position[] {
  return positions.filter((p) => p.mandateId === mandateId);
}

/* -------------------------------------------------------------------------- */
/* Mandates, with capital derived from what they actually hold                 */
/* -------------------------------------------------------------------------- */

export const mandates: readonly Mandate[] = MANDATE_SPECS.map((spec) => {
  const held = positions.filter((p) => p.mandateId === spec.id && p.state === 'open');
  const allocated = held.reduce((total, p) => total + p.outlay, 0n);

  const debtorExposure: Record<string, bigint> = {};
  for (const position of held) {
    debtorExposure[position.debtorId] = (debtorExposure[position.debtorId] ?? 0n) + position.outlay;
  }

  return {
    id: spec.id,
    buyerId: spec.buyerId,
    minRating: spec.minRating,
    maxTenorDays: spec.maxTenorDays,
    annualisedYieldBps: spec.yieldBps,
    totalCommitted: toMinor(spec.committed),
    allocated,
    maxPerDebtor: toMinor(spec.perDebtor),
    status: 'active',
    currency: USD,
    debtorExposure,
    fundedAt: at(spec.fundedOn),
  } satisfies Mandate;
});

const mandatesById = new Map(mandates.map((m) => [m.id, m]));

export function getMandate(id: string): Mandate | undefined {
  return mandatesById.get(id);
}

export function ownedMandates(): Mandate[] {
  return mandates.filter((m) => m.buyerId === viewer.buyerId);
}

export function otherMandates(): Mandate[] {
  return mandates.filter((m) => m.buyerId !== viewer.buyerId);
}

export function ownedPositions(): Position[] {
  const mine = new Set(ownedMandates().map((m) => m.id));
  return positions.filter((p) => mine.has(p.mandateId));
}

/* -------------------------------------------------------------------------- */
/* Settled trades                                                              */
/* -------------------------------------------------------------------------- */

function buildTrade(args: {
  id: string;
  invoiceId: string;
  mandateId: string;
  buyerId: string;
  face: number;
  bps: number;
  boughtOn: string;
  dueOn: string;
  executedAt: string;
  settledAt: string;
  assetRef: string;
  cashRef: string;
}): Trade {
  const faceValue = toMinor(args.face);
  const days = tenorDays(at(args.dueOn), at(args.boughtOn));
  const { discount, proceeds } = priceInvoice(faceValue, args.bps, days);

  return {
    id: args.id,
    invoiceId: args.invoiceId,
    mandateId: args.mandateId,
    sellerId: seller.id,
    buyerId: args.buyerId,
    faceValue,
    annualisedYieldBps: args.bps,
    tenorDays: days,
    discount,
    proceeds,
    currency: USD,
    assetLeg: {
      state: 'settled',
      chain: 'hedera-testnet',
      reference: args.assetRef,
      updatedAt: args.settledAt,
    },
    cashLeg: {
      state: 'settled',
      chain: 'arc-testnet',
      reference: args.cashRef,
      updatedAt: args.settledAt,
    },
    executedAt: args.executedAt,
    settledAt: args.settledAt,
  };
}

export const trades: readonly Trade[] = [
  buildTrade({
    id: 'TRD-4417',
    invoiceId: 'INV-2033',
    mandateId: 'MND-01',
    buyerId: 'BUY-ASHGROVE',
    face: 95_000,
    bps: 800,
    boughtOn: '2026-08-14',
    dueOn: '2026-09-12',
    executedAt: '2026-08-14T13:19:44.000Z',
    settledAt: '2026-08-14T13:20:22.000Z',
    assetRef: '0.0.5512@1755177641.902314772',
    cashRef: '0x7b41c9e2a6d5f38104bb27ce9a1d6f5c8e30b74a92f1c0d6e5a8b3c7d419f2e08',
  }),
  buildTrade({
    id: 'TRD-4402',
    invoiceId: 'INV-2027',
    mandateId: 'MND-01',
    buyerId: 'BUY-ASHGROVE',
    face: 71_500,
    bps: 800,
    boughtOn: '2026-08-20',
    dueOn: '2026-11-05',
    executedAt: '2026-08-20T10:02:11.000Z',
    settledAt: '2026-08-20T10:02:49.000Z',
    assetRef: '0.0.5512@1755684169.114820377',
    cashRef: '0x1d84fb06c39a72e5081cb4de7f2a9106b53c8ed4907f61a2b8c0d35e9427af16',
  }),
];

const tradesById = new Map(trades.map((t) => [t.id, t]));

export function getTrade(id: string): Trade | undefined {
  return tradesById.get(id);
}

export function tradeForInvoice(invoiceId: string): Trade | undefined {
  return trades.find((t) => t.invoiceId === invoiceId);
}

/* -------------------------------------------------------------------------- */
/* The audit record behind a trade                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the proof view shows on top of the `Trade` itself: the instrument, the compliance
 * decision and its receipt, the parties to each leg, and what binds the two legs
 * together. This is the only place in the product where any of it is named.
 */
export interface TradeProof {
  tradeId: string;
  instrument: {
    tokenId: string;
    isin: string;
    regulation: 'REG_D_506_C' | 'REG_D_506_B' | 'REG_S';
    maturity: string;
    issuedTxId: string;
    issuedAt: string;
  };
  compliance: {
    decision: 'allowed' | 'refused';
    checkedAt: string;
    checks: ReadonlyArray<{ name: string; detail: string; passed: boolean }>;
    receiptTopicId: string;
    receiptSequence: number;
    consensusTimestamp: string;
  };
  assetLeg: { from: string; to: string; quantity: string };
  cashLeg: { from: string; to: string; asset: 'USDC' };
  settlement: {
    protocol: string;
    facilitator: string;
    challengeNonce: string;
    boundAt: string;
    note: string;
  };
}

const STANDARD_CHECKS = (buyerAccount: string) => [
  {
    name: 'Control list',
    detail: `Buyer account ${buyerAccount} is not blocked on this security.`,
    passed: true,
  },
  {
    name: 'KYC status',
    detail:
      'Buyer holds a valid KYC grant on this security, issued 2026-06-02, expiring 2027-06-02.',
    passed: true,
  },
  {
    name: 'Regulation',
    detail: 'The security is Reg D 506(c). The buyer is an attested accredited investor.',
    passed: true,
  },
  {
    name: 'Uniqueness registry',
    detail: 'hash(debtor, invoice number, face value) resolves to exactly one instrument.',
    passed: true,
  },
];

const BUYER_HEDERA_ACCOUNT = '0.0.6098431';
const SELLER_HEDERA_ACCOUNT = '0.0.5512';
const BUYER_ARC_ADDRESS = '0x9C41f5A8B2e70dD3c1A4e88F6b0C25dE7a913F04';
const SELLER_ARC_ADDRESS = '0x2Ee0aB7c4915dF6b83C0a1E5d724Bf9068A3c17D';

export const tradeProofs: Readonly<Record<string, TradeProof>> = {
  'TRD-4417': {
    tradeId: 'TRD-4417',
    instrument: {
      tokenId: '0.0.6741228',
      isin: getInvoice('INV-2033')?.isin ?? '—',
      regulation: 'REG_D_506_C',
      maturity: at('2026-09-12'),
      issuedTxId: '0.0.5512@1755043211.442918331',
      issuedAt: '2026-08-12T08:40:11.000Z',
    },
    compliance: {
      decision: 'allowed',
      checkedAt: '2026-08-14T13:19:52.000Z',
      checks: STANDARD_CHECKS(BUYER_HEDERA_ACCOUNT),
      receiptTopicId: '0.0.6741301',
      receiptSequence: 4417,
      consensusTimestamp: '1755177592.118450017',
    },
    assetLeg: {
      from: SELLER_HEDERA_ACCOUNT,
      to: BUYER_HEDERA_ACCOUNT,
      quantity: '1 unit of 0.0.6741228',
    },
    cashLeg: { from: BUYER_ARC_ADDRESS, to: SELLER_ARC_ADDRESS, asset: 'USDC' },
    settlement: {
      protocol: 'x402 delivery versus payment',
      facilitator: 'blocky402.testnet',
      challengeNonce: '0x4f19a7c2b8e5d06371ac9f48',
      boundAt: '2026-08-14T13:20:04.000Z',
      note: 'Both legs carry the same challenge nonce. Neither settles unless both do, and nothing is wrapped or bridged.',
    },
  },
  'TRD-4402': {
    tradeId: 'TRD-4402',
    instrument: {
      tokenId: '0.0.6739904',
      isin: isinForInvoice(uniquenessHash('DBT-ASHFIELD', 'MF-2027', toMinor(71_500))),
      regulation: 'REG_D_506_C',
      maturity: at('2026-11-05'),
      issuedTxId: '0.0.5512@1754388006.771204118',
      issuedAt: '2026-08-05T09:20:06.000Z',
    },
    compliance: {
      decision: 'allowed',
      checkedAt: '2026-08-20T10:02:19.000Z',
      checks: STANDARD_CHECKS(BUYER_HEDERA_ACCOUNT),
      receiptTopicId: '0.0.6741301',
      receiptSequence: 4402,
      consensusTimestamp: '1755684139.550118904',
    },
    assetLeg: {
      from: SELLER_HEDERA_ACCOUNT,
      to: BUYER_HEDERA_ACCOUNT,
      quantity: '1 unit of 0.0.6739904',
    },
    cashLeg: { from: BUYER_ARC_ADDRESS, to: SELLER_ARC_ADDRESS, asset: 'USDC' },
    settlement: {
      protocol: 'x402 delivery versus payment',
      facilitator: 'blocky402.testnet',
      challengeNonce: '0xba207e94f13c6d80e5a71f22',
      boundAt: '2026-08-20T10:02:31.000Z',
      note: 'Both legs carry the same challenge nonce. Neither settles unless both do, and nothing is wrapped or bridged.',
    },
  },
};

export function getTradeProof(id: string): TradeProof | undefined {
  return tradeProofs[id];
}

/** Every customer this seller has ever invoiced, with their earned record. */
export function sellerCustomers(): Debtor[] {
  const seen = new Set(invoices.map((i) => i.debtorId));
  return debtors.filter((d) => seen.has(d.id));
}
