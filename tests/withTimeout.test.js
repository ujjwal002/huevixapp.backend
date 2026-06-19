import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/utils/withTimeout.js';

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('ok'), { ms: 100 });
    expect(result).toBe('ok');
  });

  it('rejects with a 503 UPSTREAM_TIMEOUT when the deadline passes', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(slow, { ms: 20, label: 'test upstream' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('propagates the original rejection if it loses no race', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(withTimeout(boom, { ms: 100 })).rejects.toThrow('boom');
  });
});