// The demo job from design/screens/README.md: Ridgeway Electric, $4,200.00 paid up front.
import type { PromisedItem, Verdict } from '../../src/model.js';

const src = { kind: 'estimate' as const, ref: 'estimate p.1', date: '2026-09-08', quote: '' };
export const item = (id: string, title: string, qty: number, price: string): PromisedItem => ({ id, title, qty, price, source: src });
export const verdict = (item_id: string, status: Verdict['status'], done_units: number): Verdict => ({
  item_id, status, done_units, fraction: null, photo_ref: status === 'unclear' ? null : `p${item_id}`, note: '',
});

export const RIDGEWAY_ITEMS: PromisedItem[] = [
  item('1', 'GFCI outlets', 4, '260.00'),
  item('2', 'Ceiling fan', 1, '310.00'),
  item('3', 'Recessed lights', 6, '720.00'),
  item('4', 'Main panel upgrade', 1, '1800.00'),
  item('5', 'EV charger circuit', 1, '650.00'),
  item('6', 'Flood lights', 2, '460.00'),
];
export const RIDGEWAY_VERDICTS: Verdict[] = [
  verdict('1', 'done', 4), verdict('2', 'done', 1), verdict('3', 'partial', 4),
  verdict('4', 'not_done', 0), verdict('5', 'not_done', 0), verdict('6', 'not_done', 0),
];
