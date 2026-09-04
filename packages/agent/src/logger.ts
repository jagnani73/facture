/**
 * Structured logging for the market-maker agent.
 *
 * One JSON object per line, matching the backend's logger so both services index the same
 * way. Dependency-free on purpose: four levels and `child()` is the whole surface.
 *
 * ## The one thing this adds over the backend's logger: redaction
 *
 * This process holds a Circle API key and an entity secret. Both are strings, both travel
 * inside `axios` request configuration, and an `AxiosError` serialises that configuration
 * — headers included — into something a naive logger would happily write to stdout. So the
 * final JSON line is swept for every registered secret before it is emitted, rather than
 * relying on every call site to remember which field is sensitive.
 *
 * Two layers, because either alone leaks:
 *
 * 1. **Key names.** Anything whose field name looks like a credential is replaced, whatever
 *    its value. Catches secrets this process never registered.
 * 2. **Values.** Every registered secret is replaced wherever it appears in the rendered
 *    line, at any depth, inside any string. Catches the axios/stack-trace case, where the
 *    secret is embedded in a longer string under an innocuous key.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const isLogLevel = (v: unknown): v is LogLevel =>
  typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that stamps `bindings` onto every subsequent line. */
  child(bindings: LogFields): Logger;
}

export const REDACTED = '[redacted]';

/**
 * Field names whose value is never printed, whatever it holds.
 *
 * Substring match on a lowercased key, so `circleApiKey`, `X-Api-Key`, `entitySecret` and
 * `authorization` are all covered without enumerating spellings.
 */
const SENSITIVE_KEY_PATTERN = /(api[-_]?key|secret|authorization|password|private[-_]?key|token)/i;

/**
 * Registered secret values, longest first so that a secret which contains another secret as
 * a prefix is replaced whole rather than leaving a tail behind.
 */
const secrets: string[] = [];

/**
 * Register a value that must never reach stdout.
 *
 * Call this at boot for every credential the process holds, before anything else runs.
 * Short strings are ignored: a two-character "secret" would match half the alphabet and
 * turn every log line into redaction marks, which hides real information without hiding
 * the credential.
 */
export function registerSecret(value: string | undefined): void {
  if (value === undefined || value.length < 8) return;
  if (secrets.includes(value)) return;
  secrets.push(value);
  secrets.sort((a, b) => b.length - a.length);
}

/** Test seam. Not exported from the package entry point. */
export function clearRegisteredSecrets(): void {
  secrets.length = 0;
}

/** Replace every registered secret wherever it occurs in an already-rendered line. */
export function scrub(line: string): string {
  let out = line;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Errors, `bigint`s and `Map`s do not survive `JSON.stringify` — the first loses everything
 * but its class name, the second throws outright. Money in this package is `bigint`, so the
 * second case is the common one and it would take the whole log line with it.
 */
function serialise(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: serialise(value.cause) }),
    };
  }
  if (Array.isArray(value)) return value.map((item) => serialise(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialise(v, k);
    return out;
  }
  return value;
}

function normalise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) out[key] = serialise(value, key);
  return out;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  /** Test seam. Defaults to writing to stdout/stderr. */
  readonly write?: (level: LogLevel, line: string) => void;
}

const defaultWrite = (level: LogLevel, line: string): void => {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const write = options.write ?? defaultWrite;
  const threshold = SEVERITY[level];

  const emit = (lineLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (SEVERITY[lineLevel] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lineLevel,
      msg,
      ...normalise(bindings),
      ...(fields ? normalise(fields) : {}),
    });
    // Scrubbed after rendering, not before: a secret embedded in an axios error's config
    // dump is inside a longer string under an innocuous key, and only a pass over the
    // finished line catches it.
    write(lineLevel, scrub(line));
  };

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (extra) => createLogger({ ...options, level, bindings: { ...bindings, ...extra } }),
  };
}
