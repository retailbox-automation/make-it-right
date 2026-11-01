import { describe, expect, it } from 'vitest';
import type { Estimate } from '../src/core/estimate.js';
import { extractA0, extractWithModel, itemsFromAnswer, parseTexts, sumWarning, usd, type PaymentInfo } from '../src/core/extract.js';
import { ModelError } from '../src/models/vision.js';
import { fakeModel, PNG_1PX } from './helpers.js';

const PAYMENT: PaymentInfo = { date: '2026-09-12', amount: '4200.00', method: 'PayPal Goods & Services', payee: 'Ridgeway Electric' };

const RIDGEWAY_PDF: Estimate = {
  kind: 'pdf',
  pages: 1,
  rows: [
    { page: 1, text: 'Ridgeway Electric' },
    { page: 1, text: 'ESTIMATE #1187' },
    { page: 1, text: 'Date: 2026-09-08' },
    { page: 1, text: 'Description Qty Amount' },
    { page: 1, text: 'GFCI outlets, kitchen and bath 4 $260.00' },
    { page: 1, text: 'Ceiling fan with light, living room 1 $310.00' },
    { page: 1, text: 'Recessed LED lights, kitchen ceiling 6 $720.00' },
    { page: 1, text: 'Main panel upgrade to 200A, new breakers, permit 1 $1,800.00' },
    { page: 1, text: 'LED flood lights over backyard, on a switch 2 $460.00' },
    { page: 1, text: 'Total $3,550.00' },
    { page: 1, text: 'Payment in full before work starts.' },
  ],
};

const TEXTS = parseTexts(
  [
    "2026-09-09 · Ridgeway Electric: I'll run a 50A circuit for the EV charger in the garage too. $650, just add it to the total.",
    '2026-09-12 · Dana: Sent the full $4,200 through PayPal. When do you start?',
    '2026-10-17 · Ridgeway Electric: All done on our end!',
  ].join('\n'),
);

describe('text messages', () => {
  it('parses "date · sender: message" rows and joins continuation rows', () => {
    const t = parseTexts('2026-09-09 · Ridgeway Electric: First row\nsecond row\n\n2026-09-12 · Dana: Paid: all of it\n');
    expect(t).toEqual([
      { date: '2026-09-09', from: 'Ridgeway Electric', text: 'First row\nsecond row' },
      { date: '2026-09-12', from: 'Dana', text: 'Paid: all of it' },
    ]);
    expect(parseTexts('loose text')).toEqual([{ date: null, from: '', text: 'loose text' }]);
  });
});

describe('A0: rules only', () => {
  it('reads "<title> <qty> $<amount>" rows; totals and notes are not items; texts are ignored', () => {
    const r = extractA0(RIDGEWAY_PDF, PAYMENT);
    expect(r.items.map((i) => [i.id, i.title, i.qty, i.price])).toEqual([
      ['1', 'GFCI outlets, kitchen and bath', 4, '260.00'],
      ['2', 'Ceiling fan with light, living room', 1, '310.00'],
      ['3', 'Recessed LED lights, kitchen ceiling', 6, '720.00'],
      ['4', 'Main panel upgrade to 200A, new breakers, permit', 1, '1800.00'],
      ['5', 'LED flood lights over backyard, on a switch', 2, '460.00'],
    ]);
    expect(r.items[0]!.source).toEqual({ kind: 'estimate', ref: 'estimate p.1', date: '2026-09-08', quote: 'GFCI outlets, kitchen and bath' });
    // the EV circuit is only in a text, so A0 misses it and the sum is short
    expect(r.warnings).toEqual(['the promised items add up to $3,550.00, but the payment was $4,200.00']);
  });

  it('skips tax, deposit and subtotal rows even when shaped like an item', () => {
    const est: Estimate = {
      kind: 'pdf',
      pages: 2,
      rows: [
        { page: 1, text: 'Paint hallway 1 $500' },
        { page: 2, text: 'Tax 1 $40.00' },
        { page: 2, text: 'Deposit 1 $100.00' },
        { page: 2, text: 'Subtotal 1 $500.00' },
        { page: 2, text: 'Interior doors 3 $660.50' },
      ],
    };
    const r = extractA0(est);
    expect(r.items.map((i) => [i.title, i.qty, i.price, i.source.ref, i.source.date])).toEqual([
      ['Paint hallway', 1, '500.00', 'estimate p.1', null],
      ['Interior doors', 3, '660.50', 'estimate p.2', null],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('reads no items from an image estimate', () => {
    const r = extractA0({ kind: 'image', mime: 'image/png', image: PNG_1PX }, PAYMENT);
    expect(r.items).toEqual([]);
    expect(r.warnings[0]).toMatch(/image/);
    expect(r.warnings[1]).toMatch(/\$0\.00, but the payment was \$4,200\.00/);
  });
});

describe('extraction with a model', () => {
  const answer = {
    items: [
      { title: 'GFCI outlets', qty: 4, price: '260.00', source: { kind: 'estimate', ref: 'estimate p.1', date: '2026-09-08', quote: 'GFCI outlets, kitchen and bath' } },
      { title: 'Main panel upgrade', qty: 1, price: '$1,800.00', source: { kind: 'estimate', ref: 'page 1', date: '2026-09-08', quote: 'Main panel upgrade to 200A' } },
      { title: 'EV charger circuit', qty: 0, price: '650', source: { kind: 'text', ref: 'text 9/9', date: '2026-09-09', quote: "I'll run a 50A circuit" } },
      { title: 'Recessed lights', qty: 6, price: 'about 720', source: { kind: 'estimate', ref: 'estimate p.1', date: '', quote: '' } },
      { title: '', qty: 1, price: '10.00', source: { kind: 'estimate', ref: '', date: '', quote: '' } },
    ],
  };

  it('sends the estimate text, the texts and the payment; assigns ids; checks every amount', async () => {
    const model = fakeModel([answer]);
    const r = await extractWithModel(model, RIDGEWAY_PDF, TEXTS, PAYMENT);
    const req = model.requests[0]!;
    expect(req.images).toBeUndefined();
    expect(req.prompt).toContain('Main panel upgrade to 200A, new breakers, permit 1 $1,800.00');
    expect(req.prompt).toContain("2026-09-09 · Ridgeway Electric: I'll run a 50A circuit");
    expect(req.prompt).toContain('the homeowner paid $4,200.00 to Ridgeway Electric on 2026-09-12');
    expect(req.prompt).not.toMatch(/\blines?\b/i);
    expect(r.items.map((i) => [i.id, i.title, i.qty, i.price, i.source.kind, i.source.ref, i.source.date])).toEqual([
      ['1', 'GFCI outlets', 4, '260.00', 'estimate', 'estimate p.1', '2026-09-08'],
      ['2', 'Main panel upgrade', 1, '1800.00', 'estimate', 'estimate p.1', '2026-09-08'],
      ['3', 'EV charger circuit', 1, '650.00', 'text', 'text Sep 9', '2026-09-09'],
    ]);
    expect(r.warnings).toEqual([
      'item "EV charger circuit": qty 0 is not a whole number ≥ 1; using 1',
      'item "Recessed lights": price "about 720" is not an amount; dropped',
      'item 5 from the model has no title; dropped',
      'the promised items add up to $2,710.00, but the payment was $4,200.00',
    ]);
  });

  it('passes an image estimate as the image', async () => {
    const model = fakeModel([{ items: [] }]);
    await extractWithModel(model, { kind: 'image', mime: 'image/png', image: PNG_1PX }, [], PAYMENT);
    expect(model.requests[0]!.images).toEqual([PNG_1PX]);
    expect(model.requests[0]!.prompt).toContain('the attached image');
    expect(model.requests[0]!.prompt).toContain('(none)');
  });

  it('no warning when the items add up to the payment', () => {
    const w: string[] = [];
    const items = itemsFromAnswer({ items: [{ title: 'All of it', qty: 1, price: '4200.00', source: { kind: 'estimate', ref: 'estimate p.1', date: '', quote: '' } }] }, w);
    expect(sumWarning(items, PAYMENT)).toBeNull();
    expect(items[0]!.source.date).toBeNull();
  });

  it('a wrong shape is a failure, not an empty list', async () => {
    await expect(extractWithModel(fakeModel([{ things: [] }]), RIDGEWAY_PDF, TEXTS, PAYMENT)).rejects.toBeInstanceOf(ModelError);
    await expect(extractWithModel(fakeModel([{ things: [] }]), RIDGEWAY_PDF, TEXTS, PAYMENT)).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('formats dollars for people', () => {
    expect(usd('4200.00')).toBe('$4,200.00');
    expect(usd('0.5')).toBe('$0.50');
    expect(usd('1234567.89')).toBe('$1,234,567.89');
  });
});
