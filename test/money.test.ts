import { describe, expect, it } from 'vitest';
import { claimCents, computeClaim, dayN, fromCents, toCents } from '../src/money.js';
import type { PromisedItem, Verdict } from '../src/model.js';

const src = { kind: 'estimate' as const, ref: 'estimate p.1', date: '2026-09-08', quote: '' };
const item = (id: string, title: string, qty: number, price: string): PromisedItem => ({ id, title, qty, price, source: src });
const v = (item_id: string, status: Verdict['status'], done_units: number): Verdict => ({
  item_id, status, done_units, fraction: null, photo_ref: status === 'unclear' ? null : `p${item_id}`, note: '',
});

// The demo job from design/screens/README.md: Ridgeway Electric, $4,200.00 paid up front.
const RIDGEWAY = [
  item('1', 'GFCI outlets', 4, '260.00'),
  item('2', 'Ceiling fan', 1, '310.00'),
  item('3', 'Recessed lights', 6, '720.00'),
  item('4', 'Main panel upgrade', 1, '1800.00'),
  item('5', 'EV charger circuit', 1, '650.00'),
  item('6', 'Flood lights', 2, '460.00'),
];
const RIDGEWAY_VERDICTS = [v('1', 'done', 4), v('2', 'done', 1), v('3', 'partial', 4), v('4', 'not_done', 0), v('5', 'not_done', 0), v('6', 'not_done', 0)];

describe('money', () => {
  it('converts amounts both ways', () => {
    expect(toCents('4200.00')).toBe(420000);
    expect(toCents('0.5')).toBe(50);
    expect(fromCents(315000)).toBe('3150.00');
    expect(fromCents(7)).toBe('0.07');
    expect(() => toCents('$4,200')).toThrow();
    expect(() => toCents('-1.00')).toThrow();
    expect(() => fromCents(1.5)).toThrow();
  });

  it('reproduces the demo claim: photos prove $1,050.00, claim $3,150.00, together $4,200.00', () => {
    const c = computeClaim(RIDGEWAY, RIDGEWAY_VERDICTS, { payee_name: 'Ridgeway Electric', paid_at: '2026-09-12', today: '2026-10-31' });
    expect(c.paid_total).toBe('4200.00');
    expect(c.proven_done).toBe('1050.00');
    expect(c.amount).toBe('3150.00');
    expect(c.lines.find((l) => l.item_id === '3')).toEqual({ item_id: '3', claim_amount: '240.00', proven_amount: '480.00' });
    expect(c.reason).toBe('MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
    expect(c.day_n).toBe(49);
  });

  it('keeps unproven work in the claim', () => {
    expect(claimCents(item('9', 'Paint', 1, '500.00'), undefined)).toBe(50000);
    expect(claimCents(item('9', 'Paint', 1, '500.00'), v('9', 'unclear', 0))).toBe(50000);
  });

  it('rounds a partial claim down to the cent and still adds up', () => {
    const items = [item('1', 'Doors', 3, '100.00')];
    const c = computeClaim(items, [v('1', 'partial', 2)], { payee_name: 'X' });
    expect(c.amount).toBe('33.33');
    expect(c.proven_done).toBe('66.67');
  });

  it('rejects impossible verdicts', () => {
    expect(() => claimCents(item('1', 'Fan', 1, '310.00'), v('1', 'partial', 0))).toThrow(/qty > 1/);
    expect(() => claimCents(item('1', 'Lights', 6, '720.00'), v('1', 'partial', 7))).toThrow(/outside/);
  });

  it('counts the 180-day window from the payment date', () => {
    expect(dayN('2026-09-12', '2026-09-12')).toBe(0);
    expect(dayN(null, '2026-10-31')).toBeNull();
    expect(dayN('2026-11-02', '2026-10-31')).toBeNull();
  });
});
