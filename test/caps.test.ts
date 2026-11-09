import { describe, expect, it } from 'vitest';
import { DailyCaps } from '../src/caps.js';
import { HttpError } from '../src/errors.js';

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
