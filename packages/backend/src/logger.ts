/**
 * Structured logging. One JSON object per line, so `pnpm dev | jq` works and so a
 * hosted log sink can index fields without a parser.
 *
 * Deliberately dependency-free: the whole surface is four levels and `child()`, and
 * pulling in pino would only buy speed we do not need at demo throughput.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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

/** Errors do not survive JSON.stringify; unwrap them into something readable. */
function serialise(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: serialise(value.cause) }),
    };
  }
  return value;
}

function normalise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) out[key] = serialise(value);
  return out;
}

export function createLogger(level: LogLevel = 'info', bindings: LogFields = {}): Logger {
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
    if (lineLevel === 'error' || lineLevel === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

/**
 * Process-wide logger. Replaced once config is parsed so that boot failures still
 * get logged at a sane level before `LOG_LEVEL` is known.
 */
export let rootLogger: Logger = createLogger('info', { svc: 'facture-backend' });

export function setRootLogger(next: Logger): void {
  rootLogger = next;
}
