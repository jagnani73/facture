/**
 * The Hono application.
 *
 * Kept separate from `index.ts` so tests can build an app without binding a port or
 * starting the issuance worker.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './middleware/context.js';
import { requestContext } from './middleware/context.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { healthRoutes, v1Routes } from './routes/index.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext);
  app.use('*', secureHeaders());

  /*
   * The debtor confirmation link is opened from an email client, and the seller and buyer
   * apps are separate origins in development.
   *
   * `authorization` is on this list because `POST /v1/sellers` reads a Privy identity token
   * out of that header, and a header the preflight does not allow is one the browser never
   * sends. Leaving it off did not fail loudly: the route kept its refusal, the venue kept
   * its log, and sign-in simply could not complete from a browser at all. The route was
   * hardened to verify a token rather than believe a body long after this line was written,
   * and this line did not follow — so the test below pins the pair together.
   *
   * TODO: narrow to the deployed web origins before anything real is on this.
   */
  app.use(
    '*',
    cors({ origin: '*', allowHeaders: ['content-type', 'x-request-id', 'authorization'] }),
  );

  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route('/', healthRoutes);
  app.route('/v1', v1Routes);

  return app;
}
