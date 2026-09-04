/**
 * Typed problem responses, shaped after RFC 9457 (`application/problem+json`).
 *
 * A refusal is NOT an error. When a mandate is ineligible for an instrument the API
 * returns 200 with a `RefusalReceipt` in the body — see `services/quote-engine.ts`.
 * This module is only for things that actually went wrong.
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Stable machine-readable codes. The URN in `type` is derived from these. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'duplicate_receivable',
  'invoice_not_confirmed',
  'quote_expired',
  'insufficient_mandate_balance',
  'issuance_pending',
  'upstream_unavailable',
  'not_implemented',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Problem {
  /** `urn:facture:error:<code>` — dereferenceable later, stable now. */
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string | undefined;
  instance: string | undefined;
  requestId: string | undefined;
  /** Field-level issues, present only for `validation_failed`. */
  errors?: ProblemIssue[];
}

export interface ProblemIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly issues: ProblemIssue[] | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    title: string,
    detail?: string,
    issues?: ProblemIssue[],
  ) {
    super(detail ?? title);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.issues = issues;
  }

  toProblem(instance?: string, requestId?: string): Problem {
    return {
      type: `urn:facture:error:${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      detail: this.detail,
      instance,
      requestId,
      ...(this.issues ? { errors: this.issues } : {}),
    };
  }
}

export const badRequest = (detail?: string): AppError =>
  new AppError('bad_request', 400, 'Bad request', detail);

export const validationFailed = (issues: ProblemIssue[], detail?: string): AppError =>
  new AppError('validation_failed', 422, 'Request failed validation', detail, issues);

export const unauthorized = (detail?: string): AppError =>
  new AppError('unauthorized', 401, 'Unauthorized', detail);

export const forbidden = (detail?: string): AppError =>
  new AppError('forbidden', 403, 'Forbidden', detail);

export const notFound = (what: string): AppError =>
  new AppError('not_found', 404, 'Not found', `${what} does not exist.`);

export const conflict = (code: ErrorCode, detail: string): AppError =>
  new AppError(code, 409, 'Conflict', detail);

/** `hash(debtor, invoice number, amount)` already minted an instrument. */
export const duplicateReceivable = (hash: string): AppError =>
  new AppError(
    'duplicate_receivable',
    409,
    'Receivable already listed',
    `A receivable with uniqueness hash ${hash} has already been tokenised. ` +
      'One receivable mints exactly one instrument, ever.',
  );

export const upstreamUnavailable = (upstream: string, detail?: string): AppError =>
  new AppError(
    'upstream_unavailable',
    503,
    'Upstream unavailable',
    detail ?? `${upstream} did not respond in time.`,
  );

/** Used by every stubbed service body so the failure mode is explicit, not a silent 200. */
export const notImplemented = (what: string): AppError =>
  new AppError('not_implemented', 501, 'Not implemented', `${what} is not wired up yet.`);

export const internalError = (detail?: string): AppError =>
  new AppError('internal_error', 500, 'Internal server error', detail);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
