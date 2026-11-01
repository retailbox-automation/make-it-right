import { describe, expect, it } from 'vitest';
import type { Truth } from '../eval/cases.js';
import { computeMetrics, matchItems, renderSummary, titleOverlap, verdictCorrect, type JobResult } from '../eval/metrics.js';
import type { PromisedItem, Verdict, VerdictStatus } from '../src/model.js';

const src = { kind: 'estimate' as const, ref: 'estimate p.1', date: null, quote: '' };
const it_ = (id: string, title: string, price: string, qty = 1): PromisedItem => ({ id, title, qty, price, source: src });
const v = (item_id: string, status: VerdictStatus, done_units = 0): Verdict => ({ item_id, status, done_units, fraction: null, photo_ref: null, note: '' });
const tv = (item_id: string, status: VerdictStatus, done_units = 0) => ({ item_id, status, done_units, photo_refs: [] });

const TRUTH: Truth = {
  promised_items: [it_('1', 'New toilet installed', '450.00'), it_('2', 'Interior doors', '1050.00', 3), it_('3', 'Tile bathroom floor', '700.00')],
  verdicts: [tv('1', 'done', 1), tv('2', 'partial', 2), tv('3', 'unclear')],
  claim_amount: '1050.00',
  proven_done: '1150.00',
  paid_total: '2200.00',
};

describe('item matching', () => {
  it('exact price first, best title among equal prices; then title overlap; one to one', () => {
    const truth = [it_('1', 'Ceiling fan', '300.00'), it_('2', 'Flood lights', '300.00'), it_('3', 'Main panel upgrade', '1800.00')];
    const pred = [it_('1', 'Exterior flood lights', '300.00'), it_('2', 'Fan in living room', '300.00'), it_('3', 'Panel upgrade to 200A', '1750.00'), it_('4', 'Permit', '50.00')];
    expect(matchItems(pred, truth)).toEqual([
      { pred: 1, truth: 0, by: 'price' },
      { pred: 0, truth: 1, by: 'price' },
      { pred: 2, truth: 2, by: 'title' },
    ]);
  });

  it('title overlap needs real shared words', () => {
    expect(titleOverlap('Recessed LED lights', 'Recessed LED lights, kitchen ceiling')).toBeCloseTo(0.6);
    expect(titleOverlap('Paint walls', 'Drywall')).toBe(0);
    expect(matchItems([it_('1', 'Paint walls', '10.00')], [it_('1', 'Drywall', '20.00')])).toEqual([]);
  });

  it('verdicts: status exact, and the count for partial', () => {
    expect(verdictCorrect(tv('1', 'partial', 2), v('1', 'partial', 2))).toBe(true);
    expect(verdictCorrect(tv('1', 'partial', 2), v('1', 'partial', 1))).toBe(false);
    expect(verdictCorrect(tv('1', 'done', 3), v('1', 'done', 3))).toBe(true);
    expect(verdictCorrect(tv('1', 'done', 3), undefined)).toBe(false);
  });
});

describe('computeMetrics', () => {
  const perfect: JobResult = {
    id: 'c01',
    truth: TRUTH,
    payment_amount: '2200.00',
    extracted: TRUTH.promised_items,
    verdicts_true: [v('1', 'done', 1), v('2', 'partial', 2), v('3', 'unclear')],
    claim_amount: '1050.00',
    ms: 1000,
    failures: [],
  };
  const sloppy: JobResult = {
    id: 'c02',
    truth: TRUTH,
    payment_amount: '2200.00',
    extracted: [it_('1', 'Toilet', '450.00'), it_('2', 'Doors', '1000.00', 3)], // misses the tile, wrong door price
    verdicts_true: [v('1', 'not_done'), v('2', 'partial', 1), v('3', 'done', 1)],
    claim_amount: '1783.33',
    ms: 3000,
    failures: [],
  };
  const failed: JobResult = {
    id: 'c03',
    truth: TRUTH,
    payment_amount: '2200.00',
    extracted: null,
    verdicts_true: null,
    claim_amount: null,
    ms: null,
    failures: [
      { job: 'c03', stage: 'extract', kind: 'timeout', message: 'no answer in 300000 ms' },
      { job: 'c03', stage: 'judge_true', kind: 'invalid_json', message: 'not JSON' },
    ],
  };
  const unloaded: JobResult = { id: 'c04', truth: null, payment_amount: null, extracted: null, verdicts_true: null, claim_amount: null, ms: null, failures: [{ job: 'c04', stage: 'load', kind: 'exception', message: 'no estimate' }] };

  it('one perfect job', () => {
    const m = computeMetrics([perfect]);
    expect(m.extraction).toMatchObject({ true_items: 3, predicted_items: 3, matched: 3, precision: 1, recall: 1, f1: 1 });
    expect(m.extraction.exact_price).toEqual({ count: 3, n: 3, share: 1 });
    expect(m.extraction.adds_up).toEqual({ count: 1, n: 1, share: 1 });
    expect(m.verdicts.accuracy).toEqual({ count: 3, n: 3, share: 1 });
    expect(m.claim.exact).toEqual({ count: 1, n: 1, share: 1 });
    expect(m.failures.count).toBe(0);
  });

  it('counts misses, harms and failures over all jobs; failed steps count as wrong, never dropped', () => {
    const m = computeMetrics([perfect, sloppy, failed, unloaded]);
    expect(m.jobs).toBe(4);
    // items: true 3+3+3 = 9; predicted 3+2+0 = 5; matched 3 + 2 (toilet by price, doors by title) = 5
    expect(m.extraction).toMatchObject({ true_items: 9, predicted_items: 5, matched: 5 });
    expect(m.extraction.precision).toBe(1);
    expect(m.extraction.recall).toBeCloseTo(5 / 9);
    expect(m.extraction.f1).toBeCloseTo(10 / 14);
    expect(m.extraction.exact_price).toEqual({ count: 4, n: 9, share: 4 / 9 });
    expect(m.extraction.adds_up).toEqual({ count: 1, n: 4, share: 0.25 });
    // verdicts: perfect 3/3, sloppy 0/3, failed 0/3 (none)
    expect(m.verdicts.accuracy).toEqual({ count: 3, n: 9, share: 1 / 3 });
    expect(m.verdicts.confusion.done).toEqual({ done: 1, partial: 0, not_done: 1, unclear: 0, none: 1 });
    expect(m.verdicts.confusion.partial).toEqual({ done: 0, partial: 2, not_done: 0, unclear: 0, none: 1 });
    expect(m.verdicts.confusion.unclear).toEqual({ done: 1, partial: 0, not_done: 0, unclear: 1, none: 1 });
    expect(m.verdicts.done_called_unfinished).toEqual({ count: 1, n: 3, share: 1 / 3 });
    expect(m.verdicts.not_done_called_done).toEqual({ count: 0, n: 0, share: null });
    expect(m.claim.exact).toEqual({ count: 1, n: 4, share: 0.25 });
    expect(m.time.ms_per_job).toEqual({ n: 2, mean: 2000, median: 2000, max: 3000 });
    expect(m.failures.count).toBe(3);
    expect(m.failures.by_kind).toEqual({ timeout: 1, invalid_json: 1, exception: 1 });
    expect(m.failures.jobs_with_failures).toEqual({ count: 2, n: 4, share: 0.5 });
    expect(m.rows.map((r) => [r.id, r.items_matched, r.verdicts_correct, r.claim_exact])).toEqual([
      ['c01', 3, 3, true],
      ['c02', 2, 0, false],
      ['c03', 0, null, false],
      ['c04', null, null, false],
    ]);
  });

  it('harm to the homeowner: a not-done item called done', () => {
    const truth: Truth = { ...TRUTH, verdicts: [tv('1', 'not_done'), tv('2', 'not_done'), tv('3', 'unclear')] };
    const m = computeMetrics([{ ...perfect, truth, verdicts_true: [v('1', 'done', 1), v('2', 'not_done'), v('3', 'done', 1)] }]);
    expect(m.verdicts.not_done_called_done).toEqual({ count: 1, n: 2, share: 0.5 });
  });

  it('nothing predicted gives F1 0, not a missing number', () => {
    const m = computeMetrics([{ ...perfect, extracted: [] }]);
    expect(m.extraction.f1).toBe(0);
    expect(m.extraction.precision).toBeNull();
    expect(m.extraction.adds_up.count).toBe(0);
  });

  it('summary puts n next to every number and lists every failure', () => {
    const md = renderSummary(computeMetrics([perfect, failed]), {
      approach: 'a1-whole', model: 'gemma4:31b', num_ctx: 16384, cases: '/cases', started_at: 't0', finished_at: 't1',
    });
    expect(md).toContain('| Verdict accuracy (true items) | 50.0 % (3/6) | 6 true items |');
    expect(md).toContain('| Jobs with the exact claim (to the cent) | 50.0 % (1/2) | 2 jobs |');
    expect(md).toContain('| c03 | extract | timeout | no answer in 300000 ms |');
    expect(md).toContain('| c03 | judge_true | invalid_json | not JSON |');
    expect(md).toContain('By kind: timeout 1, invalid_json 1');
    for (const row of md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Number') && md.indexOf(l) < md.indexOf('## Verdicts'))) {
      expect(row.split('|').length).toBe(5); // | number | value | n |
    }
  });
});
