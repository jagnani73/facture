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
