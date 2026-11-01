import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPayment, listCases, loadCase } from '../eval/cases.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('eval cases on disk', () => {
  it('lists case folders and refuses unknown --only ids', async () => {
    expect(await listCases(FIXTURES)).toEqual(['case-mini']);
    expect(await listCases(FIXTURES, ['case-mini'])).toEqual(['case-mini']);
    await expect(listCases(FIXTURES, ['c99'])).rejects.toThrow(/no such case.*c99/);
  });

  it('loads what the core sees, photos in number order, and the truth separately', async () => {
    const c = await loadCase(join(FIXTURES, 'case-mini'));
    expect(c.id).toBe('case-mini');
    expect(c.input.estimate.kind).toBe('pdf');
    if (c.input.estimate.kind === 'pdf') expect(c.input.estimate.rows.map((r) => r.text)).toContain('Interior doors 3 $1,050.00');
    expect(c.input.texts).toHaveLength(3);
    expect(c.input.texts[0]!.from).toBe('Harbor Plumbing & Bath');
    expect(c.input.payment).toEqual({ date: '2026-08-12', amount: '2200.00', method: 'PayPal Goods & Services', payee: 'Harbor Plumbing & Bath', transaction_id: null });
    expect(c.input.photos.map((p) => p.id)).toEqual(['photo-2', 'photo-10']);
    expect(c.truth.claim_amount).toBe('1050.00');
    expect(JSON.stringify(c.input)).not.toContain('claim_amount');
  });

  it('checks payment.json', () => {
    expect(() => checkPayment({ date: '2026-08-12', amount: '$2,200', payee: 'X' })).toThrow(/not a USD amount/);
    expect(() => checkPayment({ date: 'Aug 12', amount: '2200.00', payee: 'X' })).toThrow(/YYYY-MM-DD/);
    expect(() => checkPayment({ date: '2026-08-12', amount: '2200.00', payee: ' ' })).toThrow(/payee/);
  });
});
