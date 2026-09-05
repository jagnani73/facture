/**
 * What went wrong, in words.
 *
 * This product's whole argument about refusals is that a rejection owes the reader a
 * reason rather than a stack trace — a mandate that will not take an invoice says why, and
 * nothing on screen is ever allowed to say "transaction reverted". A *failure* is not a
 * refusal, but it inherits the same rule: if the venue cannot answer, the screen says what
 * was asked, of whom, and what came back.
 *
 * The backend speaks RFC 9457 `application/problem+json` (`packages/backend/src/errors.ts`).
 * Its `code` values are mirrored here, plus two the client can produce on its own: a
 * service that never answered, and a service that answered in a shape this build cannot
 * read. Both are real failure modes and both deserve a sentence.
 */

/** Mirrors `ERROR_CODES` in `packages/backend/src/errors.ts`. */
export const SERVER_ERROR_CODES = [
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

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/** Failures the client detects without the server having said anything useful. */
export type ClientErrorCode = 'unreachable' | 'unreadable' | 'misconfigured';

export type ApiErrorCode = ServerErrorCode | ClientErrorCode;

export interface ProblemIssue {
  path: string;
  message: string;
}

/** The `application/problem+json` body, as the backend renders it. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ServerErrorCode;
  detail?: string | undefined;
  instance?: string | undefined;
  requestId?: string | undefined;
  errors?: ProblemIssue[] | undefined;
}

export interface ApiErrorInit {
  code: ApiErrorCode;
  status: number;
  title: string;
  detail?: string | undefined;
  issues?: readonly ProblemIssue[] | undefined;
  /** What was being asked for, in the product's own words: "the seller's book". */
  what?: string | undefined;
  url?: string | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly issues: readonly ProblemIssue[] | undefined;
  readonly what: string | undefined;
  readonly url: string | undefined;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.issues = init.issues;
    this.what = init.what;
    this.url = init.url;
    this.requestId = init.requestId;
  }

  /** The same failure, re-labelled with what the caller was actually asking for. */
  about(what: string): ApiError {
    return new ApiError({
      code: this.code,
      status: this.status,
      title: this.title,
      detail: this.detail,
      issues: this.issues,
      what,
      url: this.url,
      requestId: this.requestId,
      cause: this.cause,
    });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/* -------------------------------------------------------------------------- */
/* Two answers that are not failures                                           */
/* -------------------------------------------------------------------------- */

/**
 * A compliance refusal.
 *
 * `POST /v1/trades` checks the buyer against the security's own `ControlList` and `Kyc`
 * facets **before** matching, and answers 403 when they are not eligible. That 403 is the
 * product's distinguishing claim rather than an error: an AMM matches first and finds out
 * afterwards, so non-compliance arrives there as a revert nobody can read. Here it arrives
 * as a sentence — *"Harrow Point is not permitted to hold this security by its control
 * list."* — and nothing was reserved, held or moved.
 *
 * `forbidden` is raised in exactly one place in the whole service (`routes/trades.ts`), so
 * the code alone identifies it.
 */
export const isComplianceRefusal = (error: unknown): boolean =>
  isApiError(error) && error.code === 'forbidden';

/**
 * The half-settled trade: the cash leg settled and the asset leg did not.
 *
 * The venue answers 500 and deliberately does **not** unwind, because releasing a hold
 * against a payment that actually happened turns a reconcilable state into a lost one. So
 * this must never render as a generic failure — the money moved, and the seller is owed a
 * sentence saying exactly that plus the id to quote.
 *
 * Matched on the detail rather than the code because `internal_error` is also the code for
 * an ordinary crash, and those two must not be shown the same way.
 */
export const isHalfSettled = (error: unknown): boolean =>
  isApiError(error) && error.code === 'internal_error' && /half-settled/i.test(error.detail ?? '');

/** The trade id the venue told the reader to quote. */
export function halfSettledTradeId(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const match = /Trade\s+([0-9a-f-]{36})/i.exec(error.detail ?? '');
  return match?.[1] ?? null;
}

/**
 * A problem detail split into the part a person reads and the part a developer does.
 *
 * The venue's compliance detail can carry a whole viem call trace — contract address,
 * selector, ABI docs link, library version — inline in `detail`, because the probe fails
 * closed and reports what it could not read. All of that is true and none of it belongs in
 * the sentence a funder is shown. So a parenthesis containing a line break is lifted out
 * whole, and a `SCREAMING_CODE:` prefix becomes a label rather than the first three words
 * of an English sentence.
 */
export interface SplitDetail {
  /** Machine code the venue led with, if it led with one. */
  code: string | null;
  /** What happened, in words, with the trace taken out. */
  sentence: string;
  /** The trace, kept for whoever is debugging. Never shown above the fold. */
  technical: string | null;
}

export function splitDetail(detail: string | undefined | null): SplitDetail {
  const raw = (detail ?? '').trim();
  if (raw === '') return { code: null, sentence: '', technical: null };

  const technical: string[] = [];

  // Lift out any parenthesis that contains a line break. Those are traces, not asides.
  let sentence = '';
  let depth = 0;
  let buffer = '';
  for (const char of raw) {
    if (char === '(') {
      if (depth === 0) buffer = '';
      else buffer += char;
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        if (buffer.includes('\n')) technical.push(buffer.trim());
        else sentence += `(${buffer})`;
      } else {
        buffer += char;
      }
      continue;
    }
    if (depth > 0) buffer += char;
    else sentence += char;
  }
  if (depth > 0 && buffer !== '') technical.push(buffer.trim());

  let code: string | null = null;
  const prefix = /^([A-Z][A-Z0-9_]{3,}):\s*/.exec(sentence);
  if (prefix?.[1]) {
    code = prefix[1];
    sentence = sentence.slice(prefix[0].length);
  }

  sentence = sentence
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

  return {
    code,
    sentence,
    technical: technical.length === 0 ? null : technical.join('\n\n'),
  };
}

/* -------------------------------------------------------------------------- */
/* Sentences                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One sentence a reader can act on. Never a code, never a status number on its own, and
 * never the word "error" where a plainer word will do.
 */
export function explainApiError(error: ApiError): string {
  const subject = error.what ?? 'what this page needs';
  const split = splitDetail(error.detail);
  const detail = split.sentence === '' ? undefined : split.sentence;

  switch (error.code) {
    case 'unreachable':
      return `The market service did not answer, so ${subject} could not be loaded. It may not be running${error.url ? ` at ${originOf(error.url)}` : ''}.`;

    case 'unreadable':
      return `The market service answered, but not in a shape this build understands${detail ? `: ${detail}` : ''}. The screen is not going to guess at ${subject}.`;

    case 'misconfigured':
      return detail ?? `This build is not configured to ask the venue for ${subject}.`;

    case 'not_implemented':
      return `The venue has not wired up ${subject} yet. The route exists and answered, but there is nothing behind it.`;

    case 'not_found':
      return detail ?? `There is no record here of ${subject}.`;

    case 'validation_failed':
      return [
        `The venue would not accept that request${error.issues?.length ? ':' : '.'}`,
        ...(error.issues ?? []).map((issue) => `${issue.path} — ${issue.message}`),
      ].join(' ');

    case 'bad_request':
      return detail ?? 'The venue could not read that request.';

    // Not "you are not permitted to see this". A 403 from this venue is a compliance
    // refusal against an instrument, checked before matching, and the sentence it carries
    // is the answer rather than the wrapping around one.
    case 'forbidden':
      return (
        detail ??
        'The security’s own control list and KYC facets were read before matching, and they ' +
          'do not permit this buyer to hold it. Nothing was reserved and nothing moved.'
      );

    case 'unauthorized':
      return detail ?? `You are not permitted to see ${subject}.`;

    case 'duplicate_receivable':
      return (
        detail ??
        'That receivable is already on the book. One receivable mints exactly one instrument, ever.'
      );

    case 'invoice_not_confirmed':
      return detail ?? 'That invoice has not been confirmed by the customer, so it has no price.';

    case 'quote_expired':
      return (
        detail ??
        'That price is no longer firm — the curve moved while it was on screen. Read the new one before selling.'
      );

    case 'insufficient_mandate_balance':
      return detail ?? 'That mandate does not have the unallocated capital to take this invoice.';

    case 'issuance_pending':
      return (
        detail ??
        'That invoice is still being added to the book. Issuance is paced on purpose; it becomes quotable the moment it lands.'
      );

    case 'conflict':
      return detail ?? `${capitalise(subject)} changed underneath this request.`;

    case 'upstream_unavailable':
      return detail ?? 'Something the venue depends on is not answering. Nothing has moved.';

    // "Nothing has moved" is the right thing to say about a crash and the wrong thing to
    // say about a half-settled trade, where the payment went through. The detail is the
    // venue's own words and it says which one this is.
    case 'internal_error':
      return detail ?? 'The venue failed while answering. Nothing has moved.';

    default:
      return detail ?? `${capitalise(subject)} could not be loaded.`;
  }
}

/** The one-line technical footnote under the sentence, for whoever is debugging. */
export function traceApiError(error: ApiError): string {
  const parts: string[] = [];
  if (error.url) parts.push(error.url);
  if (error.status > 0) parts.push(`HTTP ${error.status}`);
  parts.push(error.code);
  if (error.requestId) parts.push(`request ${error.requestId}`);
  return parts.join(' · ');
}

/**
 * The trace the venue inlined into `detail`, if it inlined one.
 *
 * Kept separate from `explainApiError` so a screen can put it behind a disclosure rather
 * than in the sentence. A contract selector and an ABI docs link are true and useless to
 * the person being refused.
 */
export function technicalDetail(error: unknown): string | null {
  return isApiError(error) ? splitDetail(error.detail).technical : null;
}

/** The machine code the venue led its detail with, e.g. `COMPLIANCE_PROBE_FAILED`. */
export function detailCode(error: unknown): string | null {
  return isApiError(error) ? splitDetail(error.detail).code : null;
}

/** Anything thrown anywhere, rendered as a sentence. */
export function describeFailure(error: unknown, what?: string): string {
  if (isApiError(error)) return explainApiError(what ? error.about(what) : error);
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return what ? `${capitalise(what)} could not be loaded.` : 'Something did not work.';
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
