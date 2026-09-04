/**
 * The demo book.
 *
 * This is the same market the web package renders from `packages/web/src/lib/fixtures.ts`,
 * moved behind the API. Same customers, same invoices, same standing bids, same numbers —
 * so the screens keep reading identically once they point at this service instead of at
 * their own fixtures.
 *
 * ## Two invoices carry the argument, and they are here to be checked
 *
 * - **MF-2046** — Petra Foods, $62,300, due 4 December. Every tight bid refuses it: three
 *   sit above Petra's `C`, and the ladder that does take `C` caps Petra at $40,000 against
 *   a $62,300 face. It clears against the wide end of the book at **18.5% annualised**,
 *   which is the point — a market does not go silent on paper it dislikes, it quotes it
 *   worse, and the price itself carries the information.
 * - **MF-2047** — Orrin Metalworks, $27,500. Nothing takes it, for one reason: on shared's
 *   scale `D` ranks **below** `UNRATED`, so even the bid written to price cold starts and
 *   long tenors refuses a customer already known to default. One invoice with no price,
 *   because no price is the honest answer.
 *
 * ## Three things are derived, never typed in
 *
 * Otherwise the book drifts out of agreement with itself:
 *
 * - every **uniqueness hash and ISIN** is computed exactly as the listing path computes
 *   them, from `uniquenessHash` and `isinForInvoice`;
 * - every historic position's **outlay** is `priceInvoice(face, bid, tenor at purchase)`;
 * - every mandate's **allocated capital and per-debtor exposure** are summed from its own
 *   settled trades by the store, not asserted here.
 *
 * ## Ratings, and where these numbers differ from the web fixtures
 *
 * The fixtures assign a grade next to an on-time count, and for three customers the two do
 * not agree with the ladder in `services/rating.ts` — nine on-time payments scores `A`, not
 * `B`. Rather than assign a grade the backend would immediately recompute, each of those
 * three carries a late payment, which is a fact the accumulator holds and the fixtures have
 * no field for. `score = onTime - 2 × late` then lands on the grade the fixtures state, and
 * the on-time counts are unchanged. See `RATING_NOTE` below.
 *
 * ## Ids
 *
 * The web fixtures use readable ids (`INV-2046`, `MND-06`) and the API validates `uuid`.
 * Every row here therefore gets a UUIDv5 derived from its fixture label, so the mapping is
 * reproducible in both directions and `seedIds` exposes it.
 */

import {
  isinForInvoice,
  priceInvoice,
  tenorDays,
  uniquenessHash,
  type Rating,
} from '@facture/shared';
import { createHash } from 'node:crypto';
import type { Store } from './store.js';

/** The market clock the web fixtures freeze at. Prices are reproducible against it. */
export const MARKET_NOW_ISO = '2026-09-01T09:32:00.000Z';

export const marketNow = (): Date => new Date(MARKET_NOW_ISO);

/**
 * Why three customers carry a late payment that the web fixtures do not show.
 *
 * Kept as an exported string rather than a comment so it can be quoted in a demo without
 * anyone having to go and find this file.
 */
export const RATING_NOTE =
  'Northwind, Petra and Vantage each carry one late payment. The web fixtures state a ' +
  'grade beside an on-time count, and for these three the pair does not satisfy ' +
  'score = onTime - 2 x late. The late payment is the fact that reconciles them, and it ' +
  'leaves every on-time count untouched.';

const NAMESPACE = 'facture/seed/v1';

/** UUIDv5-shaped id derived from a fixture label, so a re-seed produces the same book. */
export function seedId(label: string): string {
  const digest = createHash('sha1').update(`${NAMESPACE}:${label}`).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Fixtures are written as calendar dates; the market works in instants. */
const at = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Dollars to cents. USD minor units, never a float on the money path. */
const usd = (major: number): bigint => BigInt(Math.round(major * 100));

/** The instrument address is derived from the receivable's own hash, so the two agree. */
const addressFromHash = (hash: string): `0x${string}` => `0x${hash.slice(26)}` as `0x${string}`;

// --- the parties ------------------------------------------------------------------

const SELLER = {
  label: 'SEL-MERIDIAN',
  name: 'Meridian Fabrication',
  email: 'accounts@meridianfab.co',
  hederaAccountId: '0.0.5512',
  arcAddress: '0x2Ee0aB7c4915dF6b83C0a1E5d724Bf9068A3c17D',
} as const;

interface BuyerSpec {
  label: string;
  name: string;
  email: string;
  hederaAccountId: string;
  arcAddress: string;
  /** Set for the agent-run desks. Presented as exactly that; fake liquidity undoes it all. */
  agent?: { label: string; capsMinor: string };
}

const BUYERS: readonly BuyerSpec[] = [
  {
    label: 'BUY-ASHGROVE',
    name: 'Ashgrove Treasury',
    email: 'desk@ashgrove.example',
    hederaAccountId: '0.0.6098431',
    arcAddress: '0x9C41f5A8B2e70dD3c1A4e88F6b0C25dE7a913F04',
  },
  {
    label: 'BUY-CORDELL',
    name: 'Cordell Credit Partners',
    email: 'desk@cordell.example',
    hederaAccountId: '0.0.6098442',
    arcAddress: '0x3B77dE1a9042cF85b6E0a37c419D2b8Ae5104C6F',
  },
  {
    label: 'BUY-TESSELLATE',
    name: 'Tessellate Capital',
    email: 'ops@tessellate.example',
    hederaAccountId: '0.0.6098455',
    arcAddress: '0x5A2c8b31Fd074E69a1C4e07B8352Df6019cE43aB',
    agent: { label: 'Broad yield ladder, policy-capped', capsMinor: '15000000' },
  },
  {
    label: 'BUY-HARROW',
    name: 'Harrow Point',
    email: 'ops@harrowpoint.example',
    hederaAccountId: '0.0.6098467',
    arcAddress: '0x77Ba0e4c9351Df82a60C1e5B4739Ac06d81F2E35',
    agent: { label: 'Deep value, long tenor, policy-capped', capsMinor: '25000000' },
  },
];

interface DebtorSpec {
  label: string;
  name: string;
  email: string;
  rating: Rating;
  onTime: number;
  late: number;
  defaulted: number;
  settledFace: number;
  since: string;
}

const DEBTORS: readonly DebtorSpec[] = [
  {
    label: 'DBT-LUMEN',
    name: 'Lumen Grid Utilities',
    email: 'ap@lumengrid.example',
    rating: 'A',
    onTime: 21,
    late: 0,
    defaulted: 0,
    settledFace: 1_842_000,
    since: '2025-11-04',
  },
  {
    label: 'DBT-HALDEN',
    name: 'Halden Aerospace',
    email: 'payables@halden.example',
    rating: 'A',
    onTime: 14,
    late: 0,
    defaulted: 0,
    settledFace: 906_500,
    since: '2026-01-19',
  },
  {
    label: 'DBT-ASHFIELD',
    name: 'Ashfield Rail Group',
    email: 'ap@ashfieldrail.example',
    rating: 'A',
    onTime: 12,
    late: 0,
    defaulted: 0,
    settledFace: 774_200,
    since: '2026-02-02',
  },
  {
    label: 'DBT-NORTHWIND',
    name: 'Northwind Logistics',
    email: 'accounts@northwind.example',
    rating: 'B',
    onTime: 9,
    late: 1,
    defaulted: 0,
    settledFace: 412_800,
    since: '2026-02-27',
  },
  {
    label: 'DBT-CALDER',
    name: 'Calder & Roe',
    email: 'ap@calderroe.example',
    rating: 'B',
    onTime: 7,
    late: 0,
    defaulted: 0,
    settledFace: 288_400,
    since: '2026-03-15',
  },
  {
    label: 'DBT-PETRA',
    name: 'Petra Foods Group',
    email: 'payables@petrafoods.example',
    rating: 'C',
    onTime: 5,
    late: 1,
    defaulted: 0,
    settledFace: 214_900,
    since: '2026-04-08',
  },
  {
    label: 'DBT-VANTAGE',
    name: 'Vantage Clinical',
    email: 'ap@vantageclinical.example',
    rating: 'C',
    onTime: 4,
    late: 1,
    defaulted: 0,
    settledFace: 168_300,
    since: '2026-04-30',
  },
  {
    label: 'DBT-ORRIN',
    name: 'Orrin Metalworks',
    email: 'accounts@orrinmetal.example',
    rating: 'D',
    onTime: 3,
    late: 0,
    defaulted: 1,
    settledFace: 96_700,
    since: '2026-05-21',
  },
  {
    label: 'DBT-SABLE',
    name: 'Sable Interiors',
    email: 'hello@sableinteriors.example',
    rating: 'UNRATED',
    onTime: 0,
    late: 0,
    defaulted: 0,
    settledFace: 0,
    since: '2026-08-18',
  },
];

// --- the standing bids ------------------------------------------------------------

interface MandateSpec {
  label: string;
  buyer: string;
  name: string;
  minRating: 'UNRATED' | 'C' | 'B' | 'A';
  maxTenorDays: number;
  yieldBps: number;
  committed: number;
  perDebtor: number;
  fundedOn: string;
}

const MANDATES: readonly MandateSpec[] = [
  {
    label: 'MND-01',
    buyer: 'BUY-ASHGROVE',
    name: 'Investment grade, 60 days',
    minRating: 'A',
    maxTenorDays: 60,
    yieldBps: 800,
    committed: 500_000,
    perDebtor: 120_000,
    fundedOn: '2026-06-02',
  },
  {
    label: 'MND-05',
    buyer: 'BUY-ASHGROVE',
    name: 'Prime 30',
    minRating: 'A',
    maxTenorDays: 30,
    yieldBps: 675,
    committed: 400_000,
    perDebtor: 250_000,
    fundedOn: '2026-07-11',
  },
  {
    label: 'MND-02',
    buyer: 'BUY-CORDELL',
    name: 'Short-dated A book',
    minRating: 'B',
    maxTenorDays: 90,
    yieldBps: 925,
    committed: 250_000,
    perDebtor: 50_000,
    fundedOn: '2026-06-19',
  },
  {
    label: 'MND-03',
    buyer: 'BUY-TESSELLATE',
    name: 'Broad yield ladder',
    minRating: 'C',
    maxTenorDays: 120,
    yieldBps: 1250,
    committed: 150_000,
    perDebtor: 40_000,
    fundedOn: '2026-07-28',
  },
  {
    label: 'MND-04',
    buyer: 'BUY-ASHGROVE',
    name: 'Unrated, short only',
    minRating: 'UNRATED',
    maxTenorDays: 45,
    yieldBps: 1600,
    committed: 60_000,
    perDebtor: 15_000,
    fundedOn: '2026-08-14',
  },
  /*
   * The wide end of the book, and the reason MF-2046 has a price at all.
   *
   * Its floor is `UNRATED` — the widest a buyer can actually write — and that is exactly
   * why MF-2047 still has no bid: `D` ranks below `UNRATED`, so a book built to price cold
   * starts and long tenors still refuses a customer already known to default.
   */
  {
    label: 'MND-06',
    buyer: 'BUY-HARROW',
    name: 'Deep value, long tenor',
    minRating: 'UNRATED',
    maxTenorDays: 120,
    yieldBps: 1850,
    committed: 200_000,
    perDebtor: 75_000,
    fundedOn: '2026-08-24',
  },
];

// --- the book ---------------------------------------------------------------------

type InvoiceStatusSpec =
  | 'draft'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'listed'
  | 'sold'
  | 'matured'
  | 'disputed'
  | 'defaulted';

interface InvoiceSpec {
  label: string;
  invoiceNumber: string;
  debtor: string;
  face: number;
  issuedOn: string;
  dueOn: string;
  status: InvoiceStatusSpec;
  /** False while the instrument is still being deployed — the book shows "being added". */
  issued?: boolean;
  securityId?: string;
}

const INVOICES: readonly InvoiceSpec[] = [
  // Quotable, priced right now.
  {
    label: 'INV-2041',
    invoiceNumber: 'MF-2041',
    debtor: 'DBT-HALDEN',
    face: 40_000,
    issuedOn: '2026-08-31',
    dueOn: '2026-10-31',
    status: 'confirmed',
  },
  {
    label: 'INV-2038',
    invoiceNumber: 'MF-2038',
    debtor: 'DBT-LUMEN',
    face: 128_400,
    issuedOn: '2026-08-26',
    dueOn: '2026-09-25',
    status: 'listed',
  },
  {
    label: 'INV-2044',
    invoiceNumber: 'MF-2044',
    debtor: 'DBT-NORTHWIND',
    face: 18_750,
    issuedOn: '2026-08-31',
    dueOn: '2026-11-15',
    status: 'confirmed',
  },
  {
    label: 'INV-2045',
    invoiceNumber: 'MF-2045',
    debtor: 'DBT-CALDER',
    face: 9_600,
    issuedOn: '2026-08-17',
    dueOn: '2026-09-16',
    status: 'confirmed',
  },
  {
    label: 'INV-2046',
    invoiceNumber: 'MF-2046',
    debtor: 'DBT-PETRA',
    face: 62_300,
    issuedOn: '2026-08-28',
    dueOn: '2026-12-04',
    status: 'confirmed',
  },
  {
    label: 'INV-2047',
    invoiceNumber: 'MF-2047',
    debtor: 'DBT-ORRIN',
    face: 27_500,
    issuedOn: '2026-08-29',
    dueOn: '2026-10-16',
    status: 'confirmed',
  },
  {
    label: 'INV-2048',
    invoiceNumber: 'MF-2048',
    debtor: 'DBT-SABLE',
    face: 6_400,
    issuedOn: '2026-08-30',
    dueOn: '2026-10-01',
    status: 'confirmed',
  },

  // Waiting on the customer.
  {
    label: 'INV-2049',
    invoiceNumber: 'MF-2049',
    debtor: 'DBT-VANTAGE',
    face: 44_000,
    issuedOn: '2026-08-31',
    dueOn: '2026-11-30',
    status: 'awaiting_confirmation',
  },
  {
    label: 'INV-2050',
    invoiceNumber: 'MF-2050',
    debtor: 'DBT-HALDEN',
    face: 21_900,
    issuedOn: '2026-08-31',
    dueOn: '2026-10-09',
    status: 'awaiting_confirmation',
  },

  // Added this morning; the instrument has not landed yet.
  {
    label: 'INV-2051',
    invoiceNumber: 'MF-2051',
    debtor: 'DBT-NORTHWIND',
    face: 12_250,
    issuedOn: '2026-09-01',
    dueOn: '2026-09-30',
    status: 'draft',
    issued: false,
  },
  {
    label: 'INV-2052',
    invoiceNumber: 'MF-2052',
    debtor: 'DBT-PETRA',
    face: 8_900,
    issuedOn: '2026-09-01',
    dueOn: '2026-10-20',
    status: 'draft',
    issued: false,
  },

  // Closed, one way or another.
  {
    label: 'INV-2033',
    invoiceNumber: 'MF-2033',
    debtor: 'DBT-LUMEN',
    face: 95_000,
    issuedOn: '2026-08-12',
    dueOn: '2026-09-12',
    status: 'sold',
    securityId: '0.0.6741228',
  },
  {
    label: 'INV-2029',
    invoiceNumber: 'MF-2029',
    debtor: 'DBT-NORTHWIND',
    face: 33_400,
    issuedOn: '2026-07-14',
    dueOn: '2026-08-28',
    status: 'matured',
  },
  {
    label: 'INV-2043',
    invoiceNumber: 'MF-2043',
    debtor: 'DBT-CALDER',
    face: 7_250,
    issuedOn: '2026-08-21',
    dueOn: '2026-10-05',
    status: 'disputed',
  },
  {
    label: 'INV-2031',
    invoiceNumber: 'MF-2031',
    debtor: 'DBT-ORRIN',
    face: 15_800,
    issuedOn: '2026-07-06',
    dueOn: '2026-08-20',
    status: 'defaulted',
  },
];

/**
 * Paper the mandates already hold.
 *
 * Each becomes a sold invoice plus the quote it filled at plus a settled trade, because
 * that is what a position *is* here: the store derives allocated capital and per-debtor
 * concentration from these trades rather than taking a number on trust. That is what makes
 * MF-2046's refusal from the `C` ladder true rather than asserted — Petra's headroom there
 * is what POS-07 actually consumed.
 */
interface PositionSpec {
  label: string;
  mandate: string;
  invoiceLabel: string;
  invoiceNumber: string;
  debtor: string;
  face: number;
  boughtOn: string;
  dueOn: string;
  securityId?: string;
  assetRef?: string;
  cashRef?: string;
}

const POSITIONS: readonly PositionSpec[] = [
  // Ashgrove — Investment grade, 60 days
  {
    label: 'TRD-4417',
    mandate: 'MND-01',
    invoiceLabel: 'INV-2033',
    invoiceNumber: 'MF-2033',
    debtor: 'DBT-LUMEN',
    face: 95_000,
    boughtOn: '2026-08-14',
    dueOn: '2026-09-12',
    securityId: '0.0.6741228',
    assetRef: '0.0.5512@1755177641.902314772',
    cashRef: '0x7b41c9e2a6d5f38104bb27ce9a1d6f5c8e30b74a92f1c0d6e5a8b3c7d419f2e08',
  },
  {
    label: 'POS-02',
    mandate: 'MND-01',
    invoiceLabel: 'INV-2018',
    invoiceNumber: 'MF-2018',
    debtor: 'DBT-HALDEN',
    face: 56_000,
    boughtOn: '2026-08-06',
    dueOn: '2026-10-20',
  },
  {
    label: 'TRD-4402',
    mandate: 'MND-01',
    invoiceLabel: 'INV-2027',
    invoiceNumber: 'MF-2027',
    debtor: 'DBT-ASHFIELD',
    face: 71_500,
    boughtOn: '2026-08-20',
    dueOn: '2026-11-05',
    securityId: '0.0.6739904',
    assetRef: '0.0.5512@1755684169.114820377',
    cashRef: '0x1d84fb06c39a72e5081cb4de7f2a9106b53c8ed4907f61a2b8c0d35e9427af16',
  },

  // Ashgrove — Prime 30
  {
    label: 'POS-13',
    mandate: 'MND-05',
    invoiceLabel: 'INV-2032',
    invoiceNumber: 'MF-2032',
    debtor: 'DBT-LUMEN',
    face: 82_000,
    boughtOn: '2026-08-27',
    dueOn: '2026-09-19',
  },
  {
    label: 'POS-14',
    mandate: 'MND-05',
    invoiceLabel: 'INV-2037',
    invoiceNumber: 'MF-2037',
    debtor: 'DBT-LUMEN',
    face: 36_500,
    boughtOn: '2026-08-24',
    dueOn: '2026-09-08',
  },

  // Ashgrove — Unrated, short only (agent-run)
  {
    label: 'POS-10',
    mandate: 'MND-04',
    invoiceLabel: 'INV-2036',
    invoiceNumber: 'MF-2036',
    debtor: 'DBT-SABLE',
    face: 3_900,
    boughtOn: '2026-08-18',
    dueOn: '2026-09-14',
  },
  {
    label: 'POS-11',
    mandate: 'MND-04',
    invoiceLabel: 'INV-2039',
    invoiceNumber: 'MF-2039',
    debtor: 'DBT-ORRIN',
    face: 8_600,
    boughtOn: '2026-08-04',
    dueOn: '2026-09-05',
  },
  {
    label: 'POS-12',
    mandate: 'MND-04',
    invoiceLabel: 'INV-2040',
    invoiceNumber: 'MF-2040',
    debtor: 'DBT-PETRA',
    face: 14_000,
    boughtOn: '2026-08-26',
    dueOn: '2026-09-29',
  },

  // Cordell — Short-dated A book
  {
    label: 'POS-04',
    mandate: 'MND-02',
    invoiceLabel: 'INV-2019',
    invoiceNumber: 'MF-2019',
    debtor: 'DBT-NORTHWIND',
    face: 28_000,
    boughtOn: '2026-07-30',
    dueOn: '2026-09-18',
  },
  {
    label: 'POS-05',
    mandate: 'MND-02',
    invoiceLabel: 'INV-2024',
    invoiceNumber: 'MF-2024',
    debtor: 'DBT-CALDER',
    face: 42_000,
    boughtOn: '2026-08-11',
    dueOn: '2026-10-02',
  },
  {
    label: 'POS-06',
    mandate: 'MND-02',
    invoiceLabel: 'INV-2030',
    invoiceNumber: 'MF-2030',
    debtor: 'DBT-HALDEN',
    face: 8_000,
    boughtOn: '2026-08-01',
    dueOn: '2026-09-08',
  },

  // Tessellate — Broad yield ladder. POS-07 is Petra's exposure, and is why MF-2046 is
  // refused by the only bid whose floor it clears on rating.
  {
    label: 'POS-07',
    mandate: 'MND-03',
    invoiceLabel: 'INV-2022',
    invoiceNumber: 'MF-2022',
    debtor: 'DBT-PETRA',
    face: 36_000,
    boughtOn: '2026-08-05',
    dueOn: '2026-10-28',
  },
  {
    label: 'POS-08',
    mandate: 'MND-03',
    invoiceLabel: 'INV-2026',
    invoiceNumber: 'MF-2026',
    debtor: 'DBT-ORRIN',
    face: 9_400,
    boughtOn: '2026-08-09',
    dueOn: '2026-09-22',
  },
  {
    label: 'POS-09',
    mandate: 'MND-03',
    invoiceLabel: 'INV-2034',
    invoiceNumber: 'MF-2034',
    debtor: 'DBT-NORTHWIND',
    face: 25_000,
    boughtOn: '2026-08-25',
    dueOn: '2026-11-20',
  },
];

/** Label -> UUID for every seeded row, so a demo can address the book by its fixture name. */
export const seedIds = {
  seller: seedId(SELLER.label),
  buyers: Object.fromEntries(BUYERS.map((b) => [b.label, seedId(b.label)])),
  debtors: Object.fromEntries(DEBTORS.map((d) => [d.label, seedId(d.label)])),
  mandates: Object.fromEntries(MANDATES.map((m) => [m.label, seedId(m.label)])),
  invoices: Object.fromEntries(
    [...INVOICES.map((i) => i.label), ...POSITIONS.map((p) => p.invoiceLabel)].map((label) => [
      label,
      seedId(label),
    ]),
  ),
  trades: Object.fromEntries(POSITIONS.map((p) => [p.label, seedId(p.label)])),
} as const;

/** Display metadata the domain does not carry: what a mandate is called, and who runs it. */
export const mandateMeta = Object.fromEntries(
  MANDATES.map((m) => [
    seedId(m.label),
    {
      label: m.label,
      name: m.name,
      ownerName: BUYERS.find((b) => b.label === m.buyer)?.name ?? m.buyer,
      operator: BUYERS.find((b) => b.label === m.buyer)?.agent ? 'agent' : 'desk',
    },
  ]),
);

export interface SeedResult {
  sellerId: string;
  buyerIds: Record<string, string>;
  debtorIds: Record<string, string>;
  mandateIds: Record<string, string>;
  invoiceIds: Record<string, string>;
  tradeIds: Record<string, string>;
  counts: {
    sellers: number;
    buyers: number;
    debtors: number;
    invoices: number;
    mandates: number;
    trades: number;
  };
}

/**
 * Fill a store with the demo book. Works against either implementation, which is what
 * makes the tests exercise the same market the API serves.
 */
export async function seedStore(store: Store): Promise<SeedResult> {
  const seller = await store.insertSeller({
    id: seedIds.seller,
    name: SELLER.name,
    email: SELLER.email,
    hederaAccountId: SELLER.hederaAccountId,
    arcAddress: SELLER.arcAddress,
    createdAt: at('2026-05-12'),
  });

  for (const spec of BUYERS) {
    await store.insertBuyer({
      id: seedId(spec.label),
      name: spec.name,
      email: spec.email,
      hederaAccountId: spec.hederaAccountId,
      arcAddress: spec.arcAddress,
      /*
       * An agent-run desk is surfaced as exactly that. Fake liquidity is the one thing
       * that would undo every argument this market makes, so an agent is never dressed up
       * as a human.
       */
      agentPolicy: spec.agent ? { label: spec.agent.label, capsMinor: spec.agent.capsMinor } : null,
      createdAt: at('2026-05-20'),
    });
  }

  for (const spec of DEBTORS) {
    await store.insertDebtor({
      id: seedId(spec.label),
      name: spec.name,
      email: spec.email,
      rating: spec.rating,
      settledOnTime: spec.onTime,
      settledLate: spec.late,
      defaulted: spec.defaulted,
      settledFaceValue: usd(spec.settledFace),
      firstSettlementAt: spec.onTime + spec.late + spec.defaulted > 0 ? at(spec.since) : null,
      lastSettlementAt: spec.onTime + spec.late + spec.defaulted > 0 ? at('2026-08-20') : null,
      createdAt: at(spec.since),
    });
  }

  for (const spec of MANDATES) {
    await store.insertMandate({
      id: seedId(spec.label),
      buyerId: seedId(spec.buyer),
      ratingFloor: spec.minRating,
      maxTenorDays: spec.maxTenorDays,
      annualisedYieldBps: spec.yieldBps,
      currency: 'USD',
      exposureLimitMinor: usd(spec.committed),
      perDebtorLimitMinor: usd(spec.perDebtor),
      // Escrowed at funding, which is what makes the bid firm. `funded` is the number the
      // curve reads; `exposureLimit` is only the ceiling the buyer wrote.
      fundedMinor: usd(spec.committed),
      allocatedMinor: 0n,
      escrowRef: `escrow:${spec.label.toLowerCase()}`,
      status: 'active',
      createdAt: at(spec.fundedOn),
      updatedAt: at(spec.fundedOn),
    });
  }

  const yieldOf = new Map(MANDATES.map((m) => [m.label, m.yieldBps]));

  const insertInvoice = async (spec: {
    label: string;
    invoiceNumber: string;
    debtor: string;
    face: number;
    issuedOn: string;
    dueOn: string;
    status: InvoiceStatusSpec;
    issued?: boolean;
    securityId?: string;
  }): Promise<void> => {
    const debtorId = seedId(spec.debtor);
    const faceValue = usd(spec.face);
    // Computed exactly as the listing path computes it, not typed in — the registry key
    // and the ISIN it seeds have to agree with what a real listing would produce.
    const hash = uniquenessHash(debtorId, spec.invoiceNumber, faceValue);
    const issued = spec.issued !== false;

    const confirmed =
      spec.status === 'confirmed' ||
      spec.status === 'listed' ||
      spec.status === 'sold' ||
      spec.status === 'matured' ||
      spec.status === 'defaulted';

    await store.insertInvoice({
      id: seedId(spec.label),
      sellerId: seller.id,
      debtorId,
      invoiceNumber: spec.invoiceNumber,
      faceValue,
      currency: 'USD',
      issuedAt: at(spec.issuedOn),
      dueAt: at(spec.dueOn),
      status: spec.status,
      uniquenessHash: hash,
      isin: issued ? isinForInvoice(hash) : null,
      regulationType: 'reg-d-506c',
      securityId: issued ? (spec.securityId ?? hederaIdFor(hash)) : null,
      securityEvmAddress: issued ? addressFromHash(hash) : null,
      issuanceState: issued ? 'issued' : 'queued',
      issuanceAttempts: issued ? 1 : 0,
      issuanceTxId: issued ? `${SELLER.hederaAccountId}@${issuanceStamp(hash)}` : null,
      confirmationDecision: confirmed
        ? 'confirmed'
        : spec.status === 'disputed'
          ? 'disputed'
          : null,
      confirmationDecidedAt: confirmed || spec.status === 'disputed' ? at(spec.issuedOn) : null,
      createdAt: at(spec.issuedOn),
      updatedAt: at(spec.issuedOn),
    });
  };

  for (const spec of INVOICES) await insertInvoice(spec);

  // Historic paper: the invoices behind the mandates' open positions.
  for (const spec of POSITIONS) {
    if (INVOICES.some((i) => i.label === spec.invoiceLabel)) continue;
    await insertInvoice({
      label: spec.invoiceLabel,
      invoiceNumber: spec.invoiceNumber,
      debtor: spec.debtor,
      face: spec.face,
      issuedOn: spec.boughtOn,
      dueOn: spec.dueOn,
      status: 'sold',
      ...(spec.securityId === undefined ? {} : { securityId: spec.securityId }),
    });
  }

  for (const spec of POSITIONS) {
    const bps = yieldOf.get(spec.mandate) ?? 0;
    const faceValue = usd(spec.face);
    const heldDays = tenorDays(at(spec.dueOn), at(spec.boughtOn));
    // The outlay is the mandate's own bid applied at the tenor it bought at — derived, so
    // the book cannot disagree with itself about what a position cost.
    const { proceeds } = priceInvoice(faceValue, bps, heldDays);

    const debtor = DEBTORS.find((d) => d.label === spec.debtor);
    const boughtAt = at(spec.boughtOn);

    const quote = await store.insertQuote({
      id: seedId(`QTE-${spec.label}`),
      invoiceId: seedId(spec.invoiceLabel),
      mandateId: seedId(spec.mandate),
      ratingAtQuote: debtor?.rating ?? 'UNRATED',
      tenorDays: heldDays,
      annualisedYieldBps: bps,
      faceValue,
      discountMinor: faceValue - proceeds,
      proceedsMinor: proceeds,
      status: 'accepted',
      pricedAt: boughtAt,
      expiresAt: new Date(boughtAt.getTime() + 300_000),
    });

    const mandateSpec = MANDATES.find((m) => m.label === spec.mandate);
    const buyerLabel = mandateSpec?.buyer ?? 'BUY-ASHGROVE';

    await store.insertTrade({
      id: seedId(spec.label),
      invoiceId: seedId(spec.invoiceLabel),
      mandateId: seedId(spec.mandate),
      quoteId: quote.id,
      sellerId: seller.id,
      buyerId: seedId(buyerLabel),
      faceValue,
      proceedsMinor: proceeds,
      annualisedYieldBps: bps,
      tenorDays: heldDays,
      status: 'settled',
      holdId: String(1_000 + POSITIONS.indexOf(spec)),
      assetTxId: spec.assetRef ?? `${SELLER.hederaAccountId}@${issuanceStamp(spec.label)}`,
      assetConsensusAt: boughtAt,
      cashScheme: 'exact',
      cashNetwork: 'hedera-testnet',
      cashAsset: '0.0.0',
      cashTransaction: spec.cashRef ?? `0x${createHash('sha256').update(spec.label).digest('hex')}`,
      cashPayer: BUYERS.find((b) => b.label === buyerLabel)?.hederaAccountId ?? null,
      complianceDecision: {
        decision: 'allowed',
        checkedAt: boughtAt.toISOString(),
        checks: [
          {
            name: 'Control list',
            detail: 'Buyer account is not blocked on this security.',
            passed: true,
          },
          { name: 'KYC status', detail: 'Buyer holds a valid KYC grant.', passed: true },
          {
            name: 'Transfers enabled',
            detail: 'Transfers of this security are not paused.',
            passed: true,
          },
        ],
        reason: null,
      },
      complianceCheckedAt: boughtAt,
      hcsTopicId: '0.0.6741301',
      hcsSequenceNumber: BigInt(4_400 + POSITIONS.indexOf(spec)),
      createdAt: boughtAt,
      settledAt: boughtAt,
    });

    // Allocation is the mandate's own ledger of what it has spent, moved through the same
    // path a live trade uses rather than written as a column.
    await store.allocate(seedId(spec.mandate), proceeds);
  }

  await store.setCursor('arc-testnet', '0');
  await store.setCursor('hedera-testnet', '0');

  return {
    sellerId: seedIds.seller,
    buyerIds: seedIds.buyers,
    debtorIds: seedIds.debtors,
    mandateIds: seedIds.mandates,
    invoiceIds: seedIds.invoices,
    tradeIds: seedIds.trades,
    counts: {
      sellers: 1,
      buyers: BUYERS.length,
      debtors: DEBTORS.length,
      invoices: new Set([...INVOICES.map((i) => i.label), ...POSITIONS.map((p) => p.invoiceLabel)])
        .size,
      mandates: MANDATES.length,
      trades: POSITIONS.length,
    },
  };
}

/**
 * A stable `0.0.x` for a seeded instrument.
 *
 * Derived from the uniqueness hash so a re-seed produces the same ids. These are **not**
 * deployed contracts — the seeded book describes a market that has already traded, and
 * nothing here claims otherwise; an invoice listed through the API gets its id from a real
 * `deployBond` or gets none at all.
 */
function hederaIdFor(hash: string): string {
  return `0.0.${6_700_000 + Number(BigInt(hash.slice(0, 10)) % 90_000n)}`;
}

/** A plausible, stable consensus stamp for the seeded history. Same caveat as above. */
function issuanceStamp(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const seconds = 1_754_000_000 + (digest.readUInt32BE(0) % 2_000_000);
  const nanos = digest.readUInt32BE(4) % 1_000_000_000;
  return `${seconds}.${String(nanos).padStart(9, '0')}`;
}
