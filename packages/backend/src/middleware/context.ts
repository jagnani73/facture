/**
 * Per-request context: a request id every log line and every problem response carries,
 * and a child logger bound to it. Tracing a demo failure back through the issuance
 * queue and the facilitator round-trip needs one id that appears in all three.
 */

import { createMiddleware } from 'hono/factory';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
  };
}

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const requestId = inbound && inbound.length <= 128 ? inbound : crypto.randomUUID();

  const log = rootLogger.child({ requestId });
  c.set('requestId', requestId);
  c.set('log', log);
  c.header(REQUEST_ID_HEADER, requestId);

  const startedAt = performance.now();
  await next();
  const durationMs = Math.round(performance.now() - startedAt);

  const fields = {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs,
  };
  if (c.res.status >= 500) log.error('request failed', fields);
  else log.info('request', fields);
});
