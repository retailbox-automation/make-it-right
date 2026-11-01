import { describe, expect, it } from 'vitest';
import { analyzeCase, type CaseInput } from '../src/core/analyze.js';
import { parseTexts } from '../src/core/extract.js';
import { fakeModel } from './helpers.js';

const est = (title: string, qty: number, price: string, quote = title) => ({
  title, qty, price, source: { kind: 'estimate', ref: 'estimate p.1', date: '2026-09-08', quote },
});

// The demo job from design/screens/README.md: $4,200.00 paid; photos prove $1,050.00; claim $3,150.00.
const INPUT: CaseInput = {
  estimate: {
    kind: 'pdf',
    pages: 1,
    rows: [
      { page: 1, text: 'Date: 2026-09-08' },
      { page: 1, text: 'GFCI outlets, kitchen and bath 4 $260.00' },
      { page: 1, text: 'Ceiling fan with light, living room 1 $310.00' },
      { page: 1, text: 'Recessed LED lights, kitchen ceiling 6 $720.00' },
      { page: 1, text: 'Main panel upgrade to 200A, new breakers, permit 1 $1,800.00' },
      { page: 1, text: 'LED flood lights over backyard, on a switch 2 $460.00' },
      { page: 1, text: 'Total $3,550.00' },
    ],
  },
  texts: parseTexts(
    "2026-09-09 · Ridgeway Electric: I'll run a 50A circuit for the EV charger in the garage too. $650, just add it to the total.\n" +
      '2026-10-17 · Ridgeway Electric: All done on our end!',
  ),
  payment: { date: '2026-09-12', amount: '4200.00', method: 'PayPal Goods & Services', payee: 'Ridgeway Electric', transaction_id: '9XY' },
  photos: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `photo-${n}`, image: Buffer.from(`p${n}`) })),
};

const EXTRACTED = {
  items: [
    est('GFCI outlets', 4, '260.00'),
    est('Ceiling fan with light', 1, '310.00'),
    est('Recessed LED lights', 6, '720.00'),
    est('Main panel upgrade to 200A', 1, '1800.00'),
    est('LED flood lights', 2, '460.00'),
    { title: '50A EV charger circuit', qty: 1, price: '650.00', source: { kind: 'text', ref: 'text Sep 9', date: '2026-09-09', quote: "I'll run a 50A circuit" } },
  ],
};

const JUDGED = {
  verdicts: [
    { item_id: '1', photo_ref: 'photo-1', note: '', status: 'done', done_units: 4 },
    { item_id: '2', photo_ref: 'photo-2', note: '', status: 'done', done_units: 1 },
    { item_id: '3', photo_ref: 'photo-3', note: '', status: 'partial', done_units: 4 },
    { item_id: '4', photo_ref: 'photo-4', note: 'old fuse box', status: 'not_done', done_units: 0 },
    { item_id: '5', photo_ref: 'photo-5', note: 'bare box', status: 'not_done', done_units: 0 },
    { item_id: '6', photo_ref: 'photo-6', note: 'coiled cable', status: 'partial', done_units: 0 },
  ],
};

describe('analyzeCase', () => {
  it('reproduces the demo claim from the model answers, with every amount computed in code', async () => {
    const model = fakeModel([EXTRACTED, JUDGED]);
    const r = await analyzeCase(INPUT, { model, judgeMode: 'whole', today: '2026-10-31' });
    expect(r.promised_items).toHaveLength(6);
    expect(r.claim.amount).toBe('3150.00');
    expect(r.claim.proven_done).toBe('1050.00');
    expect(r.claim.paid_total).toBe('4200.00');
    expect(r.claim.payee_name).toBe('Ridgeway Electric');
    expect(r.claim.transaction_id).toBe('9XY');
    expect(r.claim.day_n).toBe(49);
    expect(r.claim.lines.find((l) => l.item_id === '3')).toEqual({ item_id: '3', claim_amount: '240.00', proven_amount: '480.00' });
    expect(r.verdicts.find((v) => v.item_id === '6')).toMatchObject({ status: 'not_done' });
    expect(r.warnings).toEqual(['item 6: partial on an item that cannot be split; not_done']);
    expect(r.timings.model_calls).toBe(2);
  });

  it('A0 without a model: rules read the estimate, everything stays in the claim', async () => {
    const r = await analyzeCase(INPUT, { judgeMode: 'a0' });
    expect(r.promised_items).toHaveLength(5);
    expect(r.claim.amount).toBe('3550.00');
    expect(r.claim.proven_done).toBe('0.00');
    expect(r.warnings).toEqual(['the promised items add up to $3,550.00, but the payment was $4,200.00']);
    expect(r.timings.model_calls).toBe(0);
  });

  it('trust-texts without a model: the false "all done" empties the claim', async () => {
    const r = await analyzeCase(INPUT, { judgeMode: 'trust-texts' });
    expect(r.claim.amount).toBe('0.00');
  });

  it('a model judge mode needs a model', async () => {
    await expect(analyzeCase(INPUT, { judgeMode: 'photo' })).rejects.toThrow(/needs a model/);
  });
});
