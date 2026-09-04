/**
 * Every error leaves the API as `application/problem+json` with a stable `code`, so a
 * client can branch on the failure without string-matching a message.
 */

import { HTTPException } from 'hono/http-exception';
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { AppEnv } from './context.js';
import type { Problem } from '../errors.js';
import { AppError, PROBLEM_CONTENT_TYPE, isAppError } from '../errors.js';

function respond(problem: Problem): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE },
  });
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  const log = c.get('log') ?? undefined;

  if (isAppError(err)) {
    if (err.status >= 500) log?.error('handler error', { err, code: err.code });
    else log?.warn('handler rejected request', { code: err.code, detail: err.detail });
    return respond(err.toProblem(c.req.path, requestId));
  }

  if (err instanceof HTTPException) {
    log?.warn('http exception', { status: err.status, message: err.message });
    const mapped = new AppError(
      err.status === 404 ? 'not_found' : 'bad_request',
      err.status,
      err.message || 'Request failed',
    );
    return respond(mapped.toProblem(c.req.path, requestId));
  }

  // Unknown failure: log everything, leak nothing.
  log?.error('unhandled error', { err });
  const internal = new AppError(
    'internal_error',
    500,
    'Internal server error',
    'The request could not be completed. Quote the request id when reporting this.',
  );
  return respond(internal.toProblem(c.req.path, requestId));
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const problem = new AppError(
    'not_found',
    404,
    'Not found',
    `No route matches ${c.req.method} ${c.req.path}.`,
  ).toProblem(c.req.path, c.get('requestId'));
  return respond(problem);
};
