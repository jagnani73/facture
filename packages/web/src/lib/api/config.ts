/**
 * Where the data comes from, and how to reach it.
 *
 * The web package has exactly two data sources and this module is the only place that
 * decides between them:
 *
 *   - **`api`** — the Hono service in `packages/backend`, over HTTP.
 *   - **`fixtures`** — the demo book in `src/lib/fixtures.ts`, in-process.
 *
 * The rule is deliberately boring: **the client talks to the API when you tell it where
 * the API is.** Set `NEXT_PUBLIC_API_BASE_URL` and it points there; leave it unset and the
 * demo book renders, so `pnpm --filter @facture/web dev` with nothing else running still
 * shows a market rather than nine error pages. `NEXT_PUBLIC_FACTURE_DATA_SOURCE` overrides
 * the inference in either direction.
 *
 * Nothing here is read at runtime from a dynamic key. Next inlines `process.env.NEXT_PUBLIC_*`
 * at build time only where the member expression is written out literally, so each one is.
 */

export type DataSource = 'api' | 'fixtures';

/** Written out literally so the Next compiler can inline them into the client bundle. */
const RAW_SOURCE = process.env.NEXT_PUBLIC_FACTURE_DATA_SOURCE;
const RAW_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const RAW_SELLER_ID = process.env.NEXT_PUBLIC_SELLER_ID;
const RAW_BUYER_ID = process.env.NEXT_PUBLIC_BUYER_ID;

/** The backend's own default in `packages/backend/src/env.ts` is port 8787. */
const DEFAULT_BASE_URL = 'http://localhost:8787';

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export const API_BASE_URL: string = trimTrailingSlash(
  RAW_BASE_URL && RAW_BASE_URL.trim() !== '' ? RAW_BASE_URL.trim() : DEFAULT_BASE_URL,
);

/** The versioned product surface. `/health` deliberately sits outside it. */
export const API_V1 = `${API_BASE_URL}/v1`;

function resolveSource(): DataSource {
  if (RAW_SOURCE === 'api') return 'api';
  if (RAW_SOURCE === 'fixtures') return 'fixtures';
  return RAW_BASE_URL && RAW_BASE_URL.trim() !== '' ? 'api' : 'fixtures';
}

export const DATA_SOURCE: DataSource = resolveSource();

export const usingApi = (): boolean => DATA_SOURCE === 'api';

/**
 * Who the screens are looking at.
 *
 * Every seller-side and buyer-side route on the backend is scoped by a `z.uuid()` — the
 * book is `GET /v1/invoices?sellerId=…`, the mandates page is `GET /v1/mandates?buyerId=…`.
 * There is no session yet, so the identity is configuration rather than login state, and
 * it is stated here rather than threaded through every call site.
 */
export const SELLER_ID: string = RAW_SELLER_ID?.trim() ?? '';
export const BUYER_ID: string = RAW_BUYER_ID?.trim() ?? '';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The backend validates these as UUIDs and answers 422 otherwise, which would surface as
 * "the venue rejected the request" on every screen at once. Catching it here means the
 * message can name the variable that is actually missing.
 */
export function checkIdentity(kind: 'seller' | 'buyer'): string | null {
  const value = kind === 'seller' ? SELLER_ID : BUYER_ID;
  const variable = kind === 'seller' ? 'NEXT_PUBLIC_SELLER_ID' : 'NEXT_PUBLIC_BUYER_ID';

  if (value === '') {
    return `${variable} is not set, so this build does not know which ${kind} to ask the venue about.`;
  }
  if (!UUID.test(value)) {
    return `${variable} is "${value}", which is not a UUID. The venue identifies a ${kind} by UUID and will refuse anything else.`;
  }
  return null;
}
