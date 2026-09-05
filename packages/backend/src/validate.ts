/**
 * Request validation. Helpers rather than middleware: a helper keeps the inferred type
 * at the call site without threading generics through Hono's context type.
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import type { ProblemIssue } from './errors.js';
import { badRequest, validationFailed } from './errors.js';

function toIssues(error: z.ZodError): ProblemIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }));
}

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw validationFailed(toIssues(result.error), 'Request body is invalid.');
  return result.data;
}

/**
 * Like {@link readJson}, but an absent body parses as `{}`.
 *
 * For a POST whose fields are all optional — unwinding a trade, say. `c.req.json()` throws
 * on an empty body, and refusing "give me my capital back" for want of a pair of braces is
 * a bad way to answer a request that was perfectly clear. A body that is present and
 * malformed is still a 400: silence is the only thing being read generously.
 */
export async function readOptionalJson<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S>> {
  const raw = (await c.req.text()).trim();
  if (raw.length === 0) {
    const empty = schema.safeParse({});
    if (!empty.success) throw validationFailed(toIssues(empty.error), 'Request body is required.');
    return empty.data;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw validationFailed(toIssues(result.error), 'Request body is invalid.');
  return result.data;
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw validationFailed(toIssues(result.error), 'Query string is invalid.');
  }
  return result.data;
}

export function readParams<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const result = schema.safeParse(c.req.param());
  if (!result.success) {
    throw validationFailed(toIssues(result.error), 'Path parameters are invalid.');
  }
  return result.data;
}
