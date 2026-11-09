import { describe, expect, it } from 'vitest';
import type { PromisedItem } from '../src/model.js';
import { caseView, itemTitles, shortTitle } from '../src/service.js';
import { NOW, paidCase } from './helpers/records.js';

describe('short titles for the screens', () => {
  it.each([
    ['Recessed LED lights, kitchen ceiling', 6, 'Recessed LED lights (6)', 'Recessed LED lights'],
    ['Main panel upgrade to 200A, new breakers, permit', 1, 'Main panel upgrade to 200A', 'Main panel upgrade to 200A'],
    ['GFCI outlets, kitchen and bath', 4, 'GFCI outlets (4)', 'GFCI outlets'],
    ['50A circuit for the EV charger in the garage', 1, '50A circuit for the EV charger in the garage', '50A circuit for the EV charger in the garage'],
    ['  Two flood lights  ', 2, 'Two flood lights (2)', 'Two flood lights'],
    [', starts with a comma', 1, ', starts with a comma', ', starts with a comma'],
    ['', 3, '', ''],
    ['1,200 sq ft tile', 1, '1,200 sq ft tile', '1,200 sq ft tile'],
    ['1,200 sq ft tile, kitchen and hall', 2, '1,200 sq ft tile (2)', '1,200 sq ft tile'],
    ['Tile, 1,200 sq ft', 1, 'Tile', 'Tile'],
    ['Deck boards 2,400 ft,stained', 1, 'Deck boards 2,400 ft', 'Deck boards 2,400 ft'],
    ['   ', 1, '', ''],
  ])('%j with quantity %i → %j', (title, qty, short, name) => {
    expect(shortTitle(title, qty)).toEqual({ short, name });
  });

  it('show the full titles of items whose short names would be the same, so they stay told apart', () => {
    const item = (id: string, title: string, qty: number): PromisedItem => ({ id, title, qty, price: '100.00', source: { kind: 'estimate', ref: 'estimate p.1', date: null, quote: '' } });
    expect(itemTitles([item('1', 'Interior doors, upstairs', 2), item('2', 'interior doors, basement', 3), item('3', 'Window trim, front', 1)])).toEqual({
      '1': { short: 'Interior doors, upstairs (2)', name: 'Interior doors, upstairs' },
      '2': { short: 'interior doors, basement (3)', name: 'interior doors, basement' },
      '3': { short: 'Window trim', name: 'Window trim' },
    });
    expect(itemTitles([item('1', 'Paint, walls', 1), item('2', 'Paint', 1)])).toEqual({
      '1': { short: 'Paint, walls', name: 'Paint, walls' },
      '2': { short: 'Paint', name: 'Paint' },
    });
  });

  it('are in the case view for every promised item, by id', () => {
    const view = caseView(paidCase(), NOW);
    expect(Object.keys(view.item_titles)).toEqual(view.promised_items.map((i) => i.id));
    expect(view.item_titles['3']).toEqual({ short: 'Recessed lights (6)', name: 'Recessed lights' });
    expect(view.promised_items[2]!.title).toBe('Recessed lights'); // the full title is not changed
  });
});

describe('amounts that depend on PayPal\'s answers', () => {
  const dispute = { id: 'PP-R-1', status: 'OPEN', life_cycle_stage: 'INQUIRY', opened_at: '2026-11-01T10:00:00Z', escalated_at: null, dispute_amount: '300.00', original_claim_amount: '3150.00' };
  const offer = (amount: string) => ({ amount, type: 'REFUND' as const, note: null, received_at: '2026-11-01T11:00:00Z', status: 'pending' as const });
  const outcome = (amount: string) => ({ status: 'money_back', amount_refunded: amount, refund_destination: 'the payment method you used', decided_at: null, outcome_code: null, outcome_reason: null });

  it('before a claim: the claim ready to file, no gap, and the work the photos prove is what the contractor keeps', () => {
    expect(caseView(paidCase(), NOW).amounts).toEqual({ filed_claim: '3150.00', offer_gap: null, kept_by_contractor: '1050.00' });
  });

  it('with an offer: the gap against the claim as filed, kept on our side when PayPal rewrites its amount', () => {
    expect(caseView(paidCase({ dispute, offer: offer('1200.00') }), NOW).amounts).toEqual({ filed_claim: '3150.00', offer_gap: '1950.00', kept_by_contractor: '1050.00' });
    expect(caseView(paidCase({ dispute, offer: offer('4000.00') }), NOW).amounts.offer_gap).toBe('0.00');
  });

  it('after a refund: the payment less the refund, in whole cents, never below zero', () => {
    expect(caseView(paidCase({ dispute, outcome: outcome('300.00') }), NOW).amounts.kept_by_contractor).toBe('3900.00');
    expect(caseView(paidCase({ dispute, outcome: outcome('4199.99') }), NOW).amounts.kept_by_contractor).toBe('0.01');
    expect(caseView(paidCase({ dispute, outcome: outcome('9999.00') }), NOW).amounts.kept_by_contractor).toBe('0.00');
  });
});
