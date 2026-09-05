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
const RAW_PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

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
 * Who this build was *configured* to look at.
 *
 * Every seller-side and buyer-side route on the backend is scoped by a `z.uuid()` — the
 * book is `GET /v1/invoices?sellerId=…`, the mandates page is `GET /v1/mandates?buyerId=…`.
 *
 * These two are the fallback and no longer the whole answer. **Read `lib/api/identity.ts`
 * instead of importing these directly**: a signed-in seller takes precedence over the
 * configured one, and a constant captured at module load cannot express that. They stay
 * exported because they are genuinely what the build was told, which is still the answer
 * when nobody has signed in.
 */
export const SELLER_ID: string = RAW_SELLER_ID?.trim() ?? '';
export const BUYER_ID: string = RAW_BUYER_ID?.trim() ?? '';

/**
 * Privy's app id, which identifies this app to Privy and authorises nothing.
 *
 * It is public by design and belongs in the client bundle. The app *secret* is a server
 * credential, is not read here, and must never appear in a `NEXT_PUBLIC_` variable — the
 * prefix is precisely an instruction to inline the value into JavaScript anyone can read.
 *
 * Unset is a supported state, not a misconfiguration: sign-in disappears and the configured
 * seller keeps rendering, which is how the demo book and `pnpm dev` with nothing set behave.
 */
export const PRIVY_APP_ID: string = RAW_PRIVY_APP_ID?.trim() ?? '';

export const signInAvailable = (): boolean => PRIVY_APP_ID !== '' && usingApi();
