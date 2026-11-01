import { describe, expect, it } from 'vitest';
import { parseTexts } from '../src/core/extract.js';
import { combineSeen, judgeA0, judgePerPhoto, judgeTrustTexts, judgeWhole, settleVerdict, titleWords, type Photo } from '../src/core/judge.js';
import type { PromisedItem } from '../src/model.js';
import { ModelError, type VisionRequest } from '../src/models/vision.js';
import { fakeModel } from './helpers.js';

const src = { kind: 'estimate' as const, ref: 'estimate p.1', date: '2026-09-08', quote: '' };
const item = (id: string, title: string, qty: number, price: string): PromisedItem => ({ id, title, qty, price, source: src });
const ITEMS = [
  item('1', 'GFCI outlets, kitchen and bath', 4, '260.00'),
  item('2', 'Ceiling fan with light', 1, '310.00'),
  item('3', 'Recessed LED lights', 6, '720.00'),
  item('4', 'Main panel upgrade to 200A', 1, '1800.00'),
];
const PHOTOS: Photo[] = [1, 2, 3].map((n) => ({ id: `photo-${n}`, image: Buffer.from(`img${n}`) }));

describe('settleVerdict keeps the rule', () => {
  const fan = ITEMS[1]!;
  const lights = ITEMS[2]!;
  it('partial on an item that cannot be split is not_done', () => {
    const w: string[] = [];
    expect(settleVerdict(fan, { status: 'partial', done_units: 0, photo_ref: 'photo-1' }, w)).toMatchObject({ status: 'not_done', done_units: 0 });
    expect(w[0]).toMatch(/cannot be split/);
  });
  it('partial counts are checked against qty', () => {
    const w: string[] = [];
    expect(settleVerdict(lights, { status: 'partial', done_units: 4, photo_ref: 'photo-2' }, w)).toMatchObject({ status: 'partial', done_units: 4, fraction: '4/6' });
    expect(settleVerdict(lights, { status: 'partial', done_units: 6, photo_ref: 'photo-2' }, w)).toMatchObject({ status: 'done', done_units: 6, fraction: null });
    expect(settleVerdict(lights, { status: 'partial', done_units: 0, photo_ref: 'photo-2' }, w)).toMatchObject({ status: 'not_done', done_units: 0 });
    expect(settleVerdict(lights, { status: 'partial', done_units: 2.5, photo_ref: 'photo-2' }, w)).toMatchObject({ status: 'not_done' });
    expect(w).toHaveLength(3);
  });
  it('done without a photo is unclear; unclear drops its photo; done always has every unit', () => {
    const w: string[] = [];
    expect(settleVerdict(lights, { status: 'done', done_units: 2, photo_ref: null }, w)).toMatchObject({ status: 'unclear', done_units: 0, photo_ref: null });
    expect(settleVerdict(lights, { status: 'unclear', done_units: 3, photo_ref: 'photo-1' }, w)).toMatchObject({ status: 'unclear', done_units: 0, photo_ref: null });
    expect(settleVerdict(lights, { status: 'done', done_units: 2, photo_ref: 'photo-1' }, w)).toMatchObject({ status: 'done', done_units: 6 });
    expect(settleVerdict(lights, { status: 'finished', photo_ref: 'photo-1' }, w)).toMatchObject({ status: 'unclear' });
  });
});

describe('judgeWhole', () => {
  it('one call with all photos in order; the rule is in the prompt; answers checked', async () => {
    const model = fakeModel([
      {
        verdicts: [
          { item_id: '1', photo_ref: 'photo-1', note: 'outlet with cover', status: 'done', done_units: 4 },
          { item_id: '2', photo_ref: 'Photo 2.png', note: 'fan mounted', status: 'done', done_units: 1 },
          { item_id: '3', photo_ref: '3', note: 'four lights in', status: 'partial', done_units: 4 },
          { item_id: '3', photo_ref: 'photo-1', note: 'dup', status: 'done', done_units: 6 },
          { item_id: '9', photo_ref: 'photo-1', note: 'not ours', status: 'done', done_units: 1 },
        ],
      },
    ]);
    const r = await judgeWhole(model, ITEMS, PHOTOS);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.images).toEqual(PHOTOS.map((p) => p.image));
    const prompt = model.requests[0]!.prompt;
    expect(prompt).toContain('in this order: photo-1, photo-2, photo-3');
    expect(prompt).toContain('- id 3: Recessed LED lights (qty 6)');
    expect(prompt).toContain('never partial');
    expect(prompt).toContain("The contractor's words are never proof");
    expect(prompt).not.toMatch(/\blines?\b/i);
    const props = (model.requests[0]!.schema as any).properties.verdicts.items.properties;
    expect(props.item_id.enum).toEqual(['1', '2', '3', '4']);
    expect(props.photo_ref.enum).toEqual(['photo-1', 'photo-2', 'photo-3', '']);
    expect(r.verdicts.map((v) => [v.item_id, v.status, v.done_units, v.fraction, v.photo_ref])).toEqual([
      ['1', 'done', 4, null, 'photo-1'],
      ['2', 'done', 1, null, 'photo-2'],
      ['3', 'partial', 4, '4/6', 'photo-3'],
      ['4', 'unclear', 0, null, null],
    ]);
    expect(r.warnings).toEqual(['second verdict for item 3 ignored', 'verdict for unknown item "9" ignored', 'no verdict for item 4; unclear']);
    expect(r.calls).toBe(1);
  });

  it('a photo that is not one of ours does not prove anything', async () => {
    const model = fakeModel([{ verdicts: [{ item_id: '2', photo_ref: 'photo-7', note: '', status: 'done', done_units: 1 }] }]);
    const r = await judgeWhole(model, [ITEMS[1]!], PHOTOS);
    expect(r.verdicts[0]).toMatchObject({ status: 'unclear', photo_ref: null });
    expect(r.warnings[0]).toMatch(/not one of the photos/);
  });

  it('no photos: every item unclear, no call', async () => {
    const model = fakeModel([]);
    const r = await judgeWhole(model, ITEMS, []);
    expect(r.verdicts.every((v) => v.status === 'unclear')).toBe(true);
    expect(model.requests).toHaveLength(0);
  });

  it('a wrong shape and model errors are failures', async () => {
    await expect(judgeWhole(fakeModel([{ nope: 1 }]), ITEMS, PHOTOS)).rejects.toMatchObject({ kind: 'invalid_output' });
    await expect(judgeWhole(fakeModel([new ModelError('timeout', 't')]), ITEMS, PHOTOS)).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('judgePerPhoto', () => {
  const s = (photo: string, finished: boolean, units: number) => ({ photo, finished, units, note: photo });
  const lights = ITEMS[2]!;
  const fan = ITEMS[1]!;

  it('combines: largest finished count in one photo; all units beat a not-finished photo', () => {
    expect(combineSeen(lights, [s('photo-1', false, 0), s('photo-2', true, 6)])).toMatchObject({ status: 'done', done_units: 6, photo_ref: 'photo-2' });
    expect(combineSeen(lights, [s('photo-1', true, 2), s('photo-2', true, 4), s('photo-3', false, 0)])).toMatchObject({ status: 'partial', done_units: 4, fraction: '4/6', photo_ref: 'photo-2' });
    expect(combineSeen(lights, [s('photo-1', true, 0), s('photo-2', false, 0)])).toMatchObject({ status: 'not_done', done_units: 0, photo_ref: 'photo-2' });
    expect(combineSeen(fan, [s('photo-3', false, 0), s('photo-1', true, 1)])).toMatchObject({ status: 'done', done_units: 1, photo_ref: 'photo-1' });
    expect(combineSeen(fan, [s('photo-3', false, 0)])).toMatchObject({ status: 'not_done', photo_ref: 'photo-3' });
    expect(combineSeen(fan, [])).toMatchObject({ status: 'unclear', photo_ref: null, done_units: 0 });
  });

  it('one call per photo with only that photo; verdicts combined in code', async () => {
    const model = fakeModel([
      { shows: [{ item_id: '3', note: 'two lights in', state: 'finished', finished_units: 2 }, { item_id: '2', note: 'fan box, no fan', state: 'not_finished', finished_units: 0 }] },
      { shows: [{ item_id: '3', note: 'four lights in', state: 'finished', finished_units: 4 }, { item_id: '1', note: 'outlets', state: 'finished', finished_units: 9 }] },
      { shows: [{ item_id: '2', note: 'fan mounted', state: 'finished', finished_units: 0 }, { item_id: '77', note: 'a deck', state: 'finished', finished_units: 1 }] },
    ]);
    const r = await judgePerPhoto(model, ITEMS, PHOTOS);
    expect(model.requests.map((q) => q.images)).toEqual(PHOTOS.map((p) => [p.image]));
    expect(model.requests[1]!.prompt).toContain('One job-site photo is attached: photo-2.');
    expect((model.requests[0]!.schema as any).properties.shows.items.properties.item_id.enum).toEqual(['1', '2', '3', '4']);
    expect(r.verdicts.map((v) => [v.item_id, v.status, v.done_units, v.photo_ref])).toEqual([
      ['1', 'done', 4, 'photo-2'],
      ['2', 'done', 1, 'photo-3'],
      ['3', 'partial', 4, 'photo-2'],
      ['4', 'unclear', 0, null],
    ]);
    expect(r.warnings).toEqual(['photo-2: item 1 9 finished units of 4; 4', 'photo-3: unknown item "77" ignored']);
    expect(r.calls).toBe(3);
    expect(r.ms).toBe(15);
  });

  it('a failed photo call fails the judgement (counted, not hidden)', async () => {
    const model = fakeModel([{ shows: [] }, new ModelError('invalid_json', 'bad')]);
    await expect(judgePerPhoto(model, ITEMS, PHOTOS)).rejects.toMatchObject({ kind: 'invalid_json' });
  });
});

describe('lower bounds', () => {
  it('A0: everything not done', () => {
    const r = judgeA0(ITEMS);
    expect(r.verdicts.map((v) => v.status)).toEqual(['not_done', 'not_done', 'not_done', 'not_done']);
  });

  it('trust texts: a blanket "all done" from the contractor makes everything done', () => {
    const texts = parseTexts('2026-09-12 · Dana: is it all done?\n2026-10-17 · Ridgeway Electric: All done on our end!');
    const r = judgeTrustTexts(ITEMS, texts, 'Ridgeway Electric');
    expect(r.verdicts.map((v) => [v.status, v.done_units])).toEqual([['done', 4], ['done', 1], ['done', 6], ['done', 1]]);
  });

  it('trust texts: per item by title words in a clause with a done word; the homeowner\'s words do not count', () => {
    const texts = parseTexts(
      '2026-09-26 · Ridgeway Electric: Fan is installed, panel next week.\n2026-09-27 · Dana: The outlets are done, I checked.',
    );
    const r = judgeTrustTexts(ITEMS, texts, 'ridgeway electric ');
    expect(r.verdicts.map((v) => v.status)).toEqual(['not_done', 'done', 'not_done', 'not_done']);
  });

  it('title words: lowercase, 3+ letters, no filler, singular', () => {
    expect([...titleWords('GFCI outlets, kitchen and bath')]).toEqual(['gfci', 'outlet', 'kitchen', 'bath']);
    expect([...titleWords('Main panel upgrade to 200A')]).toEqual(['main', 'panel', 'upgrade', '200a']);
  });
});

describe('judgeWhole with countFirst: the model lists finished units, the code counts them', () => {
  it('uses the length of units_seen for items with qty > 1 and asks for the list in the schema', async () => {
    const model = fakeModel([
      (req: VisionRequest) => {
        const v = (req.schema as { properties: { verdicts: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.verdicts.items;
        expect(Object.keys(v.properties)).toContain('units_seen');
        expect(v.required).toContain('units_seen');
        expect(req.prompt).toMatch(/units_seen/);
        return {
          verdicts: [
            { item_id: '1', photo_ref: 'photo-1', note: 'four outlets', units_seen: ['a', 'b', 'c', 'd'], status: 'partial', done_units: 3 },
            { item_id: '2', photo_ref: 'photo-2', note: 'fan', units_seen: [], status: 'done', done_units: 1 },
            { item_id: '3', photo_ref: 'photo-3', note: 'lights', units_seen: ['over sink', 'over island', 'by door'], status: 'partial', done_units: 5 },
            { item_id: '4', photo_ref: '', note: 'no panel photo', units_seen: [], status: 'unclear', done_units: 0 },
          ],
        };
      },
    ]);
    const j = await judgeWhole(model, ITEMS, PHOTOS, { countFirst: true });
    expect(j.verdicts.map((v) => [v.item_id, v.status, v.done_units])).toEqual([
      ['1', 'done', 4],
      ['2', 'done', 1],
      ['3', 'partial', 3],
      ['4', 'unclear', 0],
    ]);
    expect(j.warnings.join(' ')).toMatch(/item 3: done_units 5 replaced by 3 listed units/);
  });

  it('without countFirst the schema has no units_seen and done_units is the model\'s', async () => {
    const model = fakeModel([
      (req: VisionRequest) => {
        const props = (req.schema as { properties: { verdicts: { items: { properties: Record<string, unknown> } } } }).properties.verdicts.items.properties;
        expect(Object.keys(props)).not.toContain('units_seen');
        return { verdicts: [{ item_id: '3', photo_ref: 'photo-3', note: 'x', status: 'partial', done_units: 5 }] };
      },
    ]);
    const j = await judgeWhole(model, [ITEMS[2]!], PHOTOS);
    expect(j.verdicts[0]).toMatchObject({ status: 'partial', done_units: 5 });
  });
});
