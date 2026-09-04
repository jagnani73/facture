import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/env.js';

const valid: Record<string, string> = {
  CONFIRMATION_TOKEN_SECRET: 'x'.repeat(32),
  HEDERA_OPERATOR_ID: '0.0.12345',
  HEDERA_OPERATOR_KEY: '3030020100300706052b8104000a04220420' + 'a'.repeat(64),
  ARC_SETTLEMENT_PRIVATE_KEY: `0x${'b'.repeat(64)}`,
  X402_PAY_TO: '0.0.54321',
  DATABASE_URL: 'postgres://facture:facture@localhost:5432/facture',
};

describe('parseEnv', () => {
  it('applies defaults for everything optional', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(8787);
    expect(env.NODE_ENV).toBe('development');
    expect(env.X402_ASSET_MODE).toBe('hbar');
    expect(env.X402_FACILITATOR_URL).toBe('https://api.testnet.blocky402.com');
    expect(env.ARC_MAX_FEE_PER_GAS_GWEI).toBe(20);
  });

  it('names every missing variable at once', () => {
    try {
      parseEnv({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const { problems } = err as EnvValidationError;
      expect(problems).toContain('DATABASE_URL is required but not set');
      expect(problems).toContain('HEDERA_OPERATOR_ID is required but not set');
      expect(problems.length).toBeGreaterThan(3);
    }
  });

  it('rejects an ED25519 operator key, which cannot sign EVM transactions', () => {
    const ed25519 = '302e020100300506032b657004220420' + 'c'.repeat(64);
    expect(() => parseEnv({ ...valid, HEDERA_OPERATOR_KEY: ed25519 })).toThrow(/ECDSA/);
  });

  it('rejects an Arc max fee below the 20 Gwei floor', () => {
    expect(() => parseEnv({ ...valid, ARC_MAX_FEE_PER_GAS_GWEI: '10' })).toThrow(/underpriced/);
  });

  it('requires an HTS asset id when settling in HTS', () => {
    expect(() => parseEnv({ ...valid, X402_ASSET_MODE: 'hts' })).toThrow(/X402_HTS_ASSET_ID/);
  });
});
