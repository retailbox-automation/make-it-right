import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DailyCaps, RefundCap, WindowLimit } from '../src/caps.js';
import { HttpError } from '../src/errors.js';
import { PgliteStore } from '../src/store.js';

function caps(perAddressPerDay: number, perDay: number, start = '2026-11-09T10:00:00.000Z') {
  let now = new Date(start);
  const limiter = new DailyCaps({ perAddressPerDay, perDay, now: () => now });
  return { limiter, setNow: (iso: string) => (now = new Date(iso)) };
}

const refused = (fn: () => unknown): HttpError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('daily caps on new demo cases', () => {
  it('lets an address start its allowance, then answers 429 with a plain reason and a Retry-After until midnight UTC', () => {
    const { limiter } = caps(2, 10);
    limiter.take('a');
    limiter.take('a');
    const error = refused(() => limiter.take('a'));
    expect(error).toMatchObject({ status: 429, code: 'DEMO_ADDRESS_LIMIT' });
    expect(error.message).toMatch(/This address has started 2 live demo cases today/);
    expect(error.headers['retry-after']).toBe(String(14 * 3600));
    expect(() => limiter.take('b')).not.toThrow();
  });

  it('stops everyone at the daily total, whatever the address', () => {
    const { limiter } = caps(5, 3);
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    const error = refused(() => limiter.take('d'));
    expect(error).toMatchObject({ status: 429, code: 'DEMO_DAILY_LIMIT' });
    expect(error.message).toMatch(/started its 3 live cases for today/);
  });

  it('starts counting again on the next UTC day', () => {
    const { limiter, setNow } = caps(1, 1);
    limiter.take('a');
    expect(() => limiter.take('a')).toThrow(HttpError);
    setNow('2026-11-09T23:59:59.000Z');
    expect(() => limiter.take('b')).toThrow(HttpError);
    setNow('2026-11-10T00:00:00.000Z');
    expect(() => limiter.take('a')).not.toThrow();
  });

  it('gives a place back once for a case that could not be made, and not on another day', () => {
    const { limiter, setNow } = caps(1, 2);
    const giveBack = limiter.take('a');
    giveBack();
    giveBack(); // twice changes nothing more
    limiter.take('a');
    limiter.take('b');
    expect(() => limiter.take('c')).toThrow(/2 live cases/);

    setNow('2026-11-10T08:00:00.000Z');
    const today = limiter.take('a');
    setNow('2026-11-11T08:00:00.000Z');
    limiter.take('x');
    today(); // yesterday's place is not given back into today's count
    limiter.take('y');
    expect(() => limiter.take('z')).toThrow(/2 live cases/);
  });
});

describe('PayPal steps per address in a window', () => {
  it('counts per address and starts again once the window has passed', () => {
    let now = 1_000_000;
    const limit = new WindowLimit({ limit: 2, windowMs: 600_000, now: () => now });
    limit.take('a');
    limit.take('a');
    const error = refused(() => limit.take('a'));
    expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_PAYPAL_STEPS' });
    expect(error.headers['retry-after']).toBe('600');
    expect(error.message).toMatch(/please wait 10 minute\(s\)/);
    limit.take('b');
    now += 599_000;
    expect(refused(() => limit.take('a')).headers['retry-after']).toBe('1');
    now += 1_000;
    expect(() => limit.take('a')).not.toThrow();
  });
});

describe('the daily refund cap', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('is kept in the database: a restart does not reset it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-refunds-'));
    dirs.push(dir);
    const today = () => new Date('2026-11-09T15:00:00.000Z');
    let store = await PgliteStore.open(dir);
    const cap = new RefundCap(store, 2, today);
    await cap.take('c1', 'adjudicate');
    await cap.take('c2', 'accept-claim');
    await expect(cap.take('c3', 'adjudicate')).rejects.toMatchObject({ status: 429, code: 'DEMO_REFUND_LIMIT' });
    await store.close();

    store = await PgliteStore.open(dir);
    try {
      await expect(new RefundCap(store, 2, today).take('c3', 'adjudicate')).rejects.toMatchObject({ status: 429 });
      const tomorrow = new RefundCap(store, 2, () => new Date('2026-11-10T00:00:00.000Z'));
      await expect(tomorrow.take('c3', 'adjudicate')).resolves.toBeDefined();
    } finally {
      await store.close();
    }
  });

  it('gives a place back, and never hands out more places than the cap to callers at the same moment', async () => {
    const store = await PgliteStore.open();
    try {
      const cap = new RefundCap(store, 3, () => new Date('2026-11-09T15:00:00.000Z'));
      const first = await cap.take('c1', 'adjudicate');
      await first.giveBack();
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => cap.take(`c${i}`, 'accept-claim')));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(7);
    } finally {
      await store.close();
    }
  });
});
