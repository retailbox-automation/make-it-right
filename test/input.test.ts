import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { LIMITS, parseAmount, parseCaseInput } from '../src/input.js';

const item = (over: Record<string, unknown> = {}) => ({ id: '1', title: 'Ceiling fan', qty: 1, price: '310.00', ...over });
const body = (over: Record<string, unknown> = {}) => ({ payee_name: 'Ridgeway Electric', promised_items: [item()], ...over });
const rejects = (input: unknown, message: RegExp) => {
  let error: unknown;
  try {
    parseCaseInput(input);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  expect((error as Error).message).toMatch(message);
};

describe('amounts', () => {
  it('accepts up to 10 digits before the decimal point', () => {
    expect(parseCaseInput(body({ promised_items: [item({ price: '9999999999.99' })] })).promised_items[0]?.price).toBe('9999999999.99');
    expect(parseAmount('0.5', 'x')).toBe(50);
  });

  it.each(['10000000000.00', '12345678901', '99999999999999999999.99', '1e5', '-5.00', '5.001', '', ' 5.00', '$5'])('refuses the price %j', (price) => {
    rejects(body({ promised_items: [item({ price })] }), /price/);
  });

  it('refuses anything above the safe-integer limit even if it were 10 digits', () => {
    expect(LIMITS.maxDigits).toBe(10);
    expect(Number.MAX_SAFE_INTEGER).toBeGreaterThan(Number('9999999999.99'.replace('.', '')) * 1000); // price x quantity stays exact
  });

  it('caps the quantity so price times quantity stays exact', () => {
    expect(parseCaseInput(body({ promised_items: [item({ qty: 1000 })] })).promised_items[0]?.qty).toBe(1000);
    rejects(body({ promised_items: [item({ qty: 1001 })] }), /quantity/);
  });
});

describe('payment date', () => {
  it.each(['2026-09-12', '2024-02-29', '2026-12-31'])('accepts %s', (paid_at) => {
    expect(parseCaseInput(body({ paid_at })).paid_at).toBe(paid_at);
  });
  it.each(['2026-02-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-09-31', '2026-9-3', '12 Sep', '2026-09-12T00:00:00Z', 20260912, ''])('refuses %j', (paid_at) => {
    rejects(body({ paid_at }), /paid_at/);
  });
});

describe('size limits', () => {
  it('allows 50 promised items and refuses 51', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => item({ id: String(i + 1) }));
    expect(parseCaseInput(body({ promised_items: many(50) })).promised_items).toHaveLength(50);
    rejects(body({ promised_items: many(51) }), /at most 50/);
  });

  it('allows 50 verdicts and refuses 51', () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ id: String(i + 1) }));
    const verdict = (id: string) => ({ item_id: id, status: 'done', done_units: 1, fraction: null, photo_ref: 'p', note: '' });
    const verdicts = items.map((i) => verdict(i.id));
    expect(parseCaseInput(body({ promised_items: items, verdicts })).verdicts).toHaveLength(50);
    rejects(body({ promised_items: items, verdicts: [...verdicts, verdict('1')] }), /at most 50/);
  });

  const long = 'x'.repeat(501);
  it.each([
    ['payee_name', body({ payee_name: long })],
    ['title', body({ promised_items: [item({ title: long })] })],
    ['source ref', body({ promised_items: [item({ source: { kind: 'text', ref: long, date: null, quote: '' } })] })],
    ['source quote', body({ promised_items: [item({ source: { kind: 'text', ref: 'r', date: null, quote: long } })] })],
    ['source date', body({ promised_items: [item({ source: { kind: 'text', ref: 'r', date: long, quote: '' } })] })],
    ['verdict note', body({ verdicts: [{ item_id: '1', status: 'done', done_units: 1, fraction: null, photo_ref: 'p', note: long }] })],
    ['verdict photo_ref', body({ verdicts: [{ item_id: '1', status: 'done', done_units: 1, fraction: null, photo_ref: long, note: '' }] })],
    ['verdict fraction', body({ verdicts: [{ item_id: '1', status: 'done', done_units: 1, fraction: long, photo_ref: 'p', note: '' }] })],
  ])('refuses a %s longer than 500 characters', (_label, input) => {
    rejects(input, /500/);
  });

  it('keeps item ids to 64 characters', () => {
    expect(parseCaseInput(body({ promised_items: [item({ id: 'i'.repeat(64) })] })).promised_items).toHaveLength(1);
    rejects(body({ promised_items: [item({ id: 'i'.repeat(65) })] }), /64/);
  });

  it('accepts strings of exactly 500 characters', () => {
    const edge = 'x'.repeat(500);
    expect(parseCaseInput(body({ payee_name: edge })).payee_name).toBe(edge);
    expect(parseCaseInput(body({ promised_items: [item({ title: edge.slice(0, 120), source: { kind: 'text', ref: edge, date: null, quote: edge } })] })).promised_items[0]?.source.quote).toBe(edge);
  });
});
