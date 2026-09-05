import { describe, expect, it } from 'vitest';
import type { DeployedSecurity, IssuanceJob } from '../src/services/issuance.js';
import { IssuanceQueue, isRetryable } from '../src/services/issuance.js';

function job(invoiceId: string): IssuanceJob {
  return {
    invoiceId,
    isin: 'US0000000000',
    regulationType: 'reg-d-506c',
    maturityAt: new Date('2026-11-30T00:00:00Z'),
    faceValue: 4_000_000n,
    currency: 'USD',
    name: `Receivable ${invoiceId}`,
    symbol: 'FACT',
  };
}

const deployed: DeployedSecurity = {
  securityId: '0.0.99999',
  evmAddress: '0x0000000000000000000000000000000000000001',
  // The real adapter returns the ISIN it deployed with, and the sink writes it onto the
  // invoice. A fake without one leaves that projection silently null.
  isin: 'US0000000000',
  transactionId: '0.0.1@1700000000.000000000',
  gasUsed: 6_978_091,
};

async function settle(queue: IssuanceQueue, invoiceId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const state = queue.status(invoiceId)?.state;
    if (state === 'issued' || state === 'failed') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`issuance for ${invoiceId} never finished`);
}

describe('issuance queue', () => {
  it('runs deployments strictly one at a time', async () => {
    let concurrent = 0;
    let peak = 0;
    const queue = new IssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 3,
      backoffBaseMs: 1,
      deploy: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return deployed;
      },
    });

    for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(job(id));
    for (const id of ['a', 'b', 'c', 'd']) await settle(queue, id);

    expect(peak).toBe(1);
    expect(queue.snapshot().counts.issued).toBe(4);
  });

  it('retries BUSY and gives up after maxAttempts', async () => {
    let attempts = 0;
    const queue = new IssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 3,
      backoffBaseMs: 1,
      deploy: () => {
        attempts += 1;
        return Promise.reject(new Error('receipt for transaction had status BUSY'));
      },
    });

    queue.enqueue(job('busy'));
    await settle(queue, 'busy');

    expect(attempts).toBe(3);
    expect(queue.status('busy')?.state).toBe('failed');
  });

  it('fails a non-retryable status immediately rather than burning attempts', async () => {
    let attempts = 0;
    const queue = new IssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 5,
      backoffBaseMs: 1,
      deploy: () => {
        attempts += 1;
        return Promise.reject(new Error('CONTRACT_REVERT_EXECUTED: onlyValidISIN'));
      },
    });

    queue.enqueue(job('bad-isin'));
    await settle(queue, 'bad-isin');

    expect(attempts).toBe(1);
    expect(queue.status('bad-isin')?.state).toBe('failed');
  });

  it('classifies throttling as retryable and reverts as not', () => {
    expect(isRetryable(new Error('BUSY'))).toBe(true);
    expect(isRetryable(new Error('CONSENSUS_GAS_EXHAUSTED'))).toBe(true);
    expect(isRetryable(new Error('INVALID_SIGNATURE'))).toBe(false);
  });
});
