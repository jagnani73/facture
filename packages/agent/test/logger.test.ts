/**
 * The logger must not leak the Circle credentials.
 *
 * This is not a hypothetical. The API key travels inside axios request configuration, and
 * an `AxiosError` serialises that configuration — headers included — so a logger that
 * simply stringified an error would put the key on stdout on the one code path that runs
 * when something is already going wrong.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecrets,
  createLogger,
  REDACTED,
  registerSecret,
  scrub,
} from '../src/logger.js';

const API_KEY = 'TEST_API_KEY:1234567890abcdef:fedcba0987654321';
const ENTITY_SECRET = 'a1b2c3d4'.repeat(8);

/** Collects lines instead of writing them, so a test can read what would have been logged. */
function capture(level: 'debug' | 'info' = 'debug') {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (_l, line) => lines.push(line) });
  return { logger, lines, text: () => lines.join('\n') };
}

afterEach(() => {
  clearRegisteredSecrets();
});

describe('secret redaction', () => {
  it('replaces a registered secret wherever it appears in a line', () => {
    registerSecret(API_KEY);
    const { logger, text } = capture();

    logger.info('calling circle', { url: `https://api.circle.com?key=${API_KEY}` });

    expect(text()).not.toContain(API_KEY);
    expect(text()).toContain(REDACTED);
  });

  it('redacts a secret buried inside a serialised axios-style error', () => {
    registerSecret(API_KEY);
    registerSecret(ENTITY_SECRET);
    const { logger, text } = capture();

    const cause = new Error('Request failed with status code 401');
    (cause as Error & { config?: unknown }).config = {
      url: 'https://api.circle.com/v1/w3s/wallets',
      headers: { Authorization: `Bearer ${API_KEY}` },
      data: JSON.stringify({ entitySecretCiphertext: ENTITY_SECRET }),
    };

    logger.error('circle call failed', { err: cause });

    expect(text()).not.toContain(API_KEY);
    expect(text()).not.toContain(ENTITY_SECRET);
    // The useful part of the error survives; only the credentials go.
    expect(text()).toContain('Request failed with status code 401');
  });

  it('redacts by field name even for a value nobody registered', () => {
    const { logger, text } = capture();

    logger.info('config', {
      apiKey: 'never-registered-but-obviously-a-key',
      entitySecret: 'also-not-registered',
      circleApiKey: 'nested-name-variant',
      authorization: 'Bearer abc',
      walletId: 'wallet-1',
    });

    expect(text()).not.toContain('never-registered-but-obviously-a-key');
    expect(text()).not.toContain('also-not-registered');
    expect(text()).not.toContain('nested-name-variant');
    expect(text()).not.toContain('Bearer abc');
    // A non-sensitive field is untouched, or the redaction would hide real information.
    expect(text()).toContain('wallet-1');
  });

  it('reaches a secret nested several levels down', () => {
    registerSecret(API_KEY);
    const { logger, text } = capture();
    logger.info('deep', { a: { b: [{ c: `prefix-${API_KEY}-suffix` }] } });
    expect(text()).not.toContain(API_KEY);
  });

  it('ignores a value too short to be a credential', () => {
    // Registering "abc" would match half the alphabet and turn every line into redaction
    // marks, which hides information without hiding a credential.
    registerSecret('abc');
    const { logger, text } = capture();
    logger.info('abcdef', { note: 'abc' });
    expect(text()).toContain('abcdef');
  });

  it('scrub is idempotent and safe on a line with nothing to redact', () => {
    registerSecret(API_KEY);
    expect(scrub('nothing here')).toBe('nothing here');
    expect(scrub(scrub(`x ${API_KEY} y`))).toBe(`x ${REDACTED} y`);
  });
});

describe('structured output', () => {
  it('writes one JSON object per line with ts, level and msg', () => {
    const { logger, lines } = capture();
    logger.info('hello', { n: 1 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['msg']).toBe('hello');
    expect(parsed['n']).toBe(1);
    expect(typeof parsed['ts']).toBe('string');
  });

  it('renders bigint money rather than throwing on it', () => {
    // JSON.stringify throws outright on a bigint, and every amount in this package is one.
    const { logger, lines } = capture();
    expect(() => logger.info('priced', { proceeds: 3_917_808n })).not.toThrow();
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ proceeds: '3917808' });
  });

  it('carries child bindings onto every subsequent line', () => {
    const { logger, lines } = capture();
    logger.child({ mandateId: 'mandate-a' }).info('took invoice', { invoiceId: 'i-1' });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      mandateId: 'mandate-a',
      invoiceId: 'i-1',
    });
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (_l, line) => lines.push(line) });
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    expect(lines).toHaveLength(2);
  });
});
