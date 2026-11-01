// POST /api/cases/analyze through the Hono app: a multipart body built from test/fixtures/case-mini, a fake model, a fake PayPal, a temp data directory.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { Tracker } from '../src/disputes/tracker.js';
import type { UploadLimits } from '../src/intake.js';
import { KeyedLock } from '../src/lock.js';
import { ModelError, type VisionModel } from '../src/models/vision.js';
import { TITLE_LIMIT } from '../src/paypal/orders.js';
import { CaseService } from '../src/service.js';
import { UploadStore } from '../src/uploads.js';
import { fakeModel, JPEG_HEAD, PNG_1PX } from './helpers.js';
import { file, MINI_EXTRACTED, MINI_JOB, MINI_JUDGED, miniForm } from './helpers/upload.js';
import { makeWorld } from './helpers/world.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Options {
  model?: VisionModel;
  uploadLimits?: UploadLimits;
  /** Leave the upload store out of the app */
  withoutUploads?: boolean;
}

/** An app on a fresh temp "data directory"; case ids are case-1, case-2, ... */
function setup(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mir-analyze-'));
  dirs.push(dir);
  const uploadsDir = join(dir, 'uploads');
  const uploads = new UploadStore(uploadsDir);
  const world = makeWorld();
  const locks = new KeyedLock();
  const tracker = new Tracker({ store: world.store, paypal: world.client, locks });
  let count = 0;
  const service = new CaseService({
    store: world.store, paypal: world.client, tracker, locks,
    newId: () => `case-${++count}`,
    urls: { returnUrl: 'http://localhost:8787/r', cancelUrl: 'http://localhost:8787/c' },
  });
  const logged: string[] = [];
  const app = createApp(service, {
    log: (m) => logged.push(m),
    ...(options.withoutUploads ? {} : { uploads }),
    ...(options.model ? { model: options.model } : {}),
    ...(options.uploadLimits ? { uploadLimits: options.uploadLimits } : {}),
  });
  return { app, world, dir, uploads, uploadsDir, logged };
}

const post = (app: ReturnType<typeof setup>['app'], form: FormData) => app.request('/api/cases/analyze', { method: 'POST', body: form });
const json = async (res: Response) => (await res.json()) as any;
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
const filesOf = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const png = (size: number) => Buffer.concat([PNG_1PX.subarray(0, 8), Buffer.alloc(size - 8, 1)]);
const edited = (change: (form: FormData) => void) => {
  const form = miniForm();
  change(form);
  return form;
};

describe('POST /api/cases/analyze', () => {
  describe('a job that is read correctly', () => {
    it('makes a case from the model answers; every amount is computed in code', async () => {
      const model = fakeModel([MINI_EXTRACTED, MINI_JUDGED]);
      const { app } = setup({ model });
      const res = await post(app, miniForm());
      expect(res.status).toBe(201);
      const body = await json(res);

      expect(body.case).toMatchObject({ id: 'case-1', payee_name: 'Harbor Plumbing & Bath', paid_at: '2026-08-12', payment: null });
      expect(body.promised_items.map((i: any) => [i.id, i.title, i.qty, i.price, i.source.kind])).toEqual([
        ['1', 'New toilet installed', 1, '450.00', 'estimate'],
        ['2', 'Interior doors', 3, '1050.00', 'estimate'],
        ['3', 'Tile bathroom floor', 1, '700.00', 'text'],
      ]);
      expect(body.verdicts.map((v: any) => [v.item_id, v.status, v.done_units, v.fraction, v.photo_ref])).toEqual([
        ['1', 'done', 1, null, 'photo-1'],
        ['2', 'partial', 2, '2/3', 'photo-2'],
        ['3', 'unclear', 0, null, null],
      ]);
      // the doors: one of three is missing = $350.00; the tile has no photo, so all of it stays in the claim
      expect(body.claim).toMatchObject({ amount: '1050.00', proven_done: '1150.00', paid_total: '2200.00', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', payee_name: 'Harbor Plumbing & Bath' });
      expect(body.claim.lines).toEqual([
        { item_id: '1', claim_amount: '0.00', proven_amount: '450.00' },
        { item_id: '2', claim_amount: '350.00', proven_amount: '700.00' },
        { item_id: '3', claim_amount: '700.00', proven_amount: '0.00' },
      ]);
      expect(body.analysis).toEqual({ warnings: [], timings: { extract_ms: 5, judge_ms: 5, total_ms: expect.any(Number), model_calls: 2 } });
    });

    it('shows the model the estimate, the texts and the photos in the order they were uploaded', async () => {
      const model = fakeModel([MINI_EXTRACTED, MINI_JUDGED]);
      await post(setup({ model }).app, miniForm());
      expect(model.requests).toHaveLength(2);
      const [extract, judge] = model.requests;
      expect(extract!.prompt).toContain('the homeowner paid $2,200.00 to Harbor Plumbing & Bath on 2026-08-12');
      expect(extract!.prompt).toContain('2026-08-11 · Harbor Plumbing & Bath: I can also tile the floor. $700, just add it to the total.');
      expect(extract!.prompt).toMatch(/Page 1:\n/); // the text of the PDF
      expect(judge!.images).toEqual(MINI_JOB.photos);
      expect(judge!.prompt).toContain('photo-1, photo-2');
    });

    it('keeps the uploads under the case and serves them byte for byte', async () => {
      const { app, uploadsDir } = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      const body = await json(await post(app, miniForm()));
      expect(body.photos).toEqual([
        { name: 'photo-1.png', url: '/api/cases/case-1/photos/photo-1.png' },
        { name: 'photo-2.png', url: '/api/cases/case-1/photos/photo-2.png' },
      ]);
      expect(readdirSync(join(uploadsDir, 'case-1')).sort()).toEqual(['estimate.pdf', 'photo-1.png', 'photo-2.png']);

      for (const [index, photo] of body.photos.entries()) {
        const res = await app.request(photo.url);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await bytesOf(res)).toEqual(MINI_JOB.photos[index]);
      }
      const estimate = await app.request('/api/cases/case-1/estimate');
      expect(estimate.status).toBe(200);
      expect(estimate.headers.get('content-type')).toBe('application/pdf');
      expect(await bytesOf(estimate)).toEqual(MINI_JOB.estimate);
    });

    it('gives the same case back on GET, photos included', async () => {
      const { app } = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      const made = await json(await post(app, miniForm()));
      const again = await json(await app.request('/api/cases/case-1'));
      expect(again.claim).toEqual(made.claim);
      expect(again.photos).toEqual(made.photos);
      expect(again).not.toHaveProperty('analysis');
    });

    it('stores a JPEG as .jpg and an image estimate as an image, and serves each with its own type', async () => {
      const model = fakeModel([MINI_EXTRACTED, MINI_JUDGED]);
      const { app } = setup({ model });
      const scan = Buffer.concat([JPEG_HEAD, Buffer.from('scan')]);
      const res = await post(app, edited((f) => {
        f.set('estimate', file(scan, 'estimate.pdf', 'application/pdf')); // a JPEG with a .pdf name
        f.delete('photos');
        f.append('photos', file(Buffer.concat([JPEG_HEAD, Buffer.from('one')]), 'a.png')); // a JPEG with a .png name
        f.append('photos', file(MINI_JOB.photos[1]!, 'b.png', 'image/png'));
      }));
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.photos.map((p: any) => p.name)).toEqual(['photo-1.jpg', 'photo-2.png']);
      expect(model.requests[0]!.images).toEqual([scan]); // an image estimate goes to the model as an image
      const photo = await app.request('/api/cases/case-1/photos/photo-1.jpg');
      expect(photo.headers.get('content-type')).toBe('image/jpeg');
      const estimate = await app.request('/api/cases/case-1/estimate');
      expect(estimate.headers.get('content-type')).toBe('image/jpeg');
      expect(await bytesOf(estimate)).toEqual(scan);
    });

    it('makes a case that pays, claims and disputes like one made from JSON', async () => {
      const { app, world } = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      await post(app, miniForm());
      const payment = await app.request('/api/cases/case-1/payment', { method: 'POST' });
      expect(payment.status).toBe(200);
      const order = JSON.parse(world.fake.calls.find((c) => c.method === 'POST' && c.path === '/v2/checkout/orders')!.body);
      const unit = order.purchase_units[0];
      expect(unit.custom_id).toBe('MIR-case-1');
      expect(unit.amount.value).toBe('2200.00');
      expect(unit.items.map((i: any) => i.name)).toEqual(['New toilet installed', 'Interior doors', 'Tile bathroom floor']);
      expect((await world.store.get('case-1'))!.uploads).toEqual({ estimate: 'estimate.pdf', photos: ['photo-1.png', 'photo-2.png'] });
      expect((await app.request('/api/cases/case-1/dispute')).status).toBe(200);
    });

    it('gives every case its own id and its own files', async () => {
      const { app, uploadsDir } = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED, MINI_EXTRACTED, MINI_JUDGED]) });
      expect((await json(await post(app, miniForm()))).case.id).toBe('case-1');
      expect((await json(await post(app, miniForm()))).case.id).toBe('case-2');
      expect(readdirSync(uploadsDir).sort()).toEqual(['case-1', 'case-2']);
    });
  });

  describe('what the model gets wrong or leaves out', () => {
    it('keeps the case when the items do not add up to the payment, and returns the core warning', async () => {
      const { app } = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      const res = await post(app, edited((f) => f.set('paid_amount', '2500')));
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.analysis.warnings).toEqual(['the promised items add up to $2,200.00, but the payment was $2,500.00']);
      expect(body.claim.paid_total).toBe('2200.00'); // the claim follows the items, not the typed amount
      expect((await app.request('/api/cases/case-1')).status).toBe(200);
    });

    it('returns the core warnings for a verdict it had to correct', async () => {
      const judged = { verdicts: [{ ...MINI_JUDGED.verdicts[0]!, status: 'partial', done_units: 0 }, ...MINI_JUDGED.verdicts.slice(1)] }; // "partial" for a qty-1 item
      const { app } = setup({ model: fakeModel([MINI_EXTRACTED, judged]) });
      const body = await json(await post(app, miniForm()));
      expect(body.analysis.warnings).toEqual(['item 1: partial on an item that cannot be split; not_done']);
      expect(body.verdicts[0]).toMatchObject({ status: 'not_done', done_units: 0 });
      expect(body.claim.amount).toBe('1500.00'); // the toilet now stays in the claim
    });

    it('warns when the texts are not in the form of texts.txt', async () => {
      const model = fakeModel([MINI_EXTRACTED, MINI_JUDGED]);
      const body = await json(await post(setup({ model }).app, edited((f) => f.set('texts', 'He said he would finish by Friday'))));
      expect(body.analysis.warnings).toEqual(['texts: the first line is not in the form "YYYY-MM-DD · Sender: message"; it was read as a message without a date']);
      expect(model.requests[0]!.prompt).toContain('no date · unknown: He said he would finish by Friday');
    });

    it('works without texts', async () => {
      const model = fakeModel([MINI_EXTRACTED, MINI_JUDGED]);
      const res = await post(setup({ model }).app, edited((f) => f.delete('texts')));
      expect(res.status).toBe(201);
      expect(model.requests[0]!.prompt).toContain('Text messages (date · sender: message):\n(none)');
    });

    it('shortens text the model wrote when it is longer than a case accepts, and says so', async () => {
      const [first, ...others] = MINI_EXTRACTED.items;
      const extracted = { items: [{ ...first!, title: 'T'.repeat(600), source: { ...(first!.source as object), quote: 'Q'.repeat(501) } }, ...others] };
      const judged = { verdicts: [{ ...MINI_JUDGED.verdicts[0]!, note: 'N'.repeat(900) }, ...MINI_JUDGED.verdicts.slice(1)] };
      const res = await post(setup({ model: fakeModel([extracted, judged]) }).app, miniForm());
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.promised_items[0].title).toBe(`${'T'.repeat(TITLE_LIMIT - 1)}…`);
      expect(body.promised_items[0].source.quote).toBe(`${'Q'.repeat(499)}…`);
      expect(body.verdicts[0].note).toBe(`${'N'.repeat(499)}…`);
      expect(body.analysis.warnings).toEqual([
        `item 1: title was longer than ${TITLE_LIMIT} characters and is shortened`,
        'item 1: quote was longer than 500 characters and is shortened',
        'item 1: note was longer than 500 characters and is shortened',
      ]);
    });

    it('does not cut a character in two when it shortens text', async () => {
      const [first, ...others] = MINI_EXTRACTED.items;
      const extracted = { items: [{ ...first!, title: `${'a'.repeat(TITLE_LIMIT - 2)}😀${'b'.repeat(50)}` }, ...others] }; // the emoji is two UTF-16 units, the last two that would fit
      const body = await json(await post(setup({ model: fakeModel([extracted, MINI_JUDGED]) }).app, miniForm()));
      expect(body.promised_items[0].title).toBe(`${'a'.repeat(TITLE_LIMIT - 2)}…`);
      expect(body.promised_items[0].title.isWellFormed()).toBe(true);
    });
  });

  describe('a job it cannot make a case from', () => {
    const nothingStored = async (ctx: ReturnType<typeof setup>) => {
      expect(await ctx.world.store.list()).toEqual([]);
      expect(filesOf(ctx.uploadsDir)).toEqual([]); // no case directory, no scratch directory
    };

    it('answers 502 when the model fails, whichever way, and stores nothing', async () => {
      const failures = [
        new ModelError('timeout', 'gemma: no answer in 300000 ms'),
        new ModelError('invalid_json', 'gemma: answer is not JSON after 2 attempts'),
        new ModelError('network', 'gemma: http://localhost:11434 unreachable'),
        new ModelError('http', 'gemma: HTTP 500'),
      ];
      for (const failure of failures) {
        const ctx = setup({ model: fakeModel([failure]) });
        const res = await post(ctx.app, miniForm());
        expect(res.status, failure.kind).toBe(502);
        expect(await json(res)).toEqual({ error: { code: 'PHOTO_CHECK_FAILED', message: `the photo check failed (${failure.kind}): ${failure.message}` } });
        await nothingStored(ctx);
        expect(ctx.logged.join('\n')).toContain(failure.kind);
      }
    });

    it('answers 502 when the second call fails, after the items were read', async () => {
      const ctx = setup({ model: fakeModel([MINI_EXTRACTED, new ModelError('invalid_json', 'gemma: answer is not JSON after 2 attempts')]) });
      expect((await post(ctx.app, miniForm())).status).toBe(502);
      await nothingStored(ctx);
    });

    it('answers 502 when the model answers with something that is not what was asked', async () => {
      const ctx = setup({ model: fakeModel([{ unexpected: true }]) });
      const res = await post(ctx.app, miniForm());
      expect(res.status).toBe(502);
      expect((await json(res)).error.message).toMatch(/invalid_output/);
      await nothingStored(ctx);
    });

    it('answers 500 for a failure that is not the model\'s, and stores nothing', async () => {
      const ctx = setup({ model: fakeModel([new Error('boom')]) });
      const res = await post(ctx.app, miniForm());
      expect(res.status).toBe(500);
      expect(await json(res)).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } });
      await nothingStored(ctx);
    });

    it('answers 422 when no promised items are found', async () => {
      const model = fakeModel([{ items: [] }]);
      const ctx = setup({ model });
      const res = await post(ctx.app, miniForm());
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        error: { code: 'NO_PROMISED_ITEMS', message: 'no promised items could be read from the estimate and the texts: the promised items add up to $0.00, but the payment was $2,200.00' },
      });
      expect(model.requests).toHaveLength(1); // nothing to check the photos against
      await nothingStored(ctx);
    });

    it('answers 422 when the case cannot take what was found, and removes the files it had saved', async () => {
      const [first, ...others] = MINI_EXTRACTED.items;
      const tooMany = { items: Array.from({ length: 51 }, () => first!) };
      const free = { items: [{ ...first!, price: '0.00' }, ...others] };
      for (const [extracted, message] of [
        [free, /item 1: price must be more than zero/],
        [tooMany, /at most 50 items/],
      ] as const) {
        const ctx = setup({ model: fakeModel([extracted, { verdicts: [] }]) });
        const save = vi.spyOn(ctx.uploads, 'save');
        const remove = vi.spyOn(ctx.uploads, 'remove');
        const res = await post(ctx.app, miniForm());
        expect(res.status).toBe(422);
        const { error } = await json(res);
        expect(error.code).toBe('PUNCH_LIST_NOT_USABLE');
        expect(error.message).toMatch(message);
        expect(save).toHaveBeenCalledTimes(1); // the files were written ...
        expect(remove).toHaveBeenCalledWith('case-1'); // ... and taken away again
        await nothingStored(ctx);
      }
    });

    it('answers 400 for an estimate PDF that cannot be read, without asking the model', async () => {
      const model = fakeModel([]);
      const ctx = setup({ model });
      const res = await post(ctx.app, edited((f) => f.set('estimate', file(Buffer.from('%PDF-1.4\nthis is not a pdf at all'), 'estimate.pdf', 'application/pdf'))));
      expect(res.status).toBe(400);
      const { error } = await json(res);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(/^the estimate could not be read: /);
      expect(model.requests).toHaveLength(0);
      await nothingStored(ctx);
    });
  });

  describe('a request that is not valid', () => {
    const cases: Array<[string, (f: FormData) => void, number, string, RegExp]> = [
      ['no estimate', (f) => f.delete('estimate'), 400, 'INVALID_INPUT', /estimate is required/],
      ['a .png that is really text', (f) => f.append('photos', file(Buffer.from('not a picture'), 'site.png', 'image/png')), 400, 'INVALID_INPUT', /photo 3 is not a JPEG or PNG/],
      ['21 photos', (f) => { f.delete('photos'); for (let i = 0; i < 21; i++) f.append('photos', file(PNG_1PX, `${i}.png`, 'image/png')); }, 400, 'INVALID_INPUT', /at most 20 photos/],
      ['a bad paid_at', (f) => f.set('paid_at', '2026-02-30'), 400, 'INVALID_INPUT', /paid_at must be a date/],
      ['a bad paid_amount', (f) => f.set('paid_amount', 'two thousand'), 400, 'INVALID_INPUT', /paid_amount/],
      ['no photos', (f) => f.delete('photos'), 400, 'INVALID_INPUT', /at least one photo/],
      ['a photo of 10 MB and one byte', (f) => f.append('photos', file(png(10 * 1024 * 1024 + 1), 'big.png', 'image/png')), 413, 'PAYLOAD_TOO_LARGE', /photo 3 is larger than 10 MB/],
    ];

    it.each(cases)('answers with the right status for %s, and the model is not asked and nothing is stored', async (_name, change, status, code, message) => {
      const model = fakeModel([]);
      const ctx = setup({ model });
      const res = await post(ctx.app, edited(change));
      expect(res.status).toBe(status);
      const { error } = await json(res);
      expect(error.code).toBe(code);
      expect(error.message).toMatch(message);
      expect(model.requests).toHaveLength(0);
      expect(await ctx.world.store.list()).toEqual([]);
      expect(existsSync(ctx.uploadsDir)).toBe(false);
    });

    it('answers 400 for a JSON body', async () => {
      const ctx = setup({ model: fakeModel([]) });
      const res = await ctx.app.request('/api/cases/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"payee_name":"x"}' });
      expect(res.status).toBe(400);
      expect((await json(res)).error.message).toMatch(/multipart\/form-data/);
    });

    it('takes a photo of exactly 10 MB', async () => {
      const ctx = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      const res = await post(ctx.app, edited((f) => f.set('photos', file(png(10 * 1024 * 1024), 'big.png', 'image/png'))));
      expect(res.status).toBe(201);
    });

    it('refuses files that together are over the limit, and names the limit', async () => {
      const ctx = setup({ model: fakeModel([]), uploadLimits: { maxFileBytes: 1000, maxTotalBytes: 1500, maxPhotos: 20 } });
      const form = edited((f) => {
        f.set('estimate', file(png(600), 'e.png'));
        f.delete('photos');
        f.append('photos', file(png(600), 'a.png'));
        f.append('photos', file(png(600), 'b.png'));
      });
      const res = await post(ctx.app, form);
      expect(res.status).toBe(413);
      expect((await json(res)).error).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: 'the files together are larger than 1500 bytes' });
    });
  });

  describe('the size of the request body', () => {
    it('refuses a body that announces more than the files and the form can need, in JSON', async () => {
      const ctx = setup({ model: fakeModel([]) });
      const announced = 51 * 1024 * 1024 + 1;
      const res = await ctx.app.request('/api/cases/analyze', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(announced) }, body: 'x' });
      expect(res.status).toBe(413);
      expect(await json(res)).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'the request body is larger than 51 MB' } });
    });

    it('lets this route take a body over 256 KB while every other route keeps that limit', async () => {
      const ctx = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      const big = await post(ctx.app, edited((f) => f.set('photos', file(png(300 * 1024), 'big.png', 'image/png'))));
      expect(big.status).toBe(201);
      const other = await ctx.app.request('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(256 * 1024 + 1) });
      expect(other.status).toBe(413);
      expect((await json(other)).error.message).toBe('the request body is larger than 256 KB');
    });
  });

  describe('a server without a photo-checking model', () => {
    it('answers 503 and reads none of the body', async () => {
      const ctx = setup();
      const res = await post(ctx.app, miniForm());
      expect(res.status).toBe(503);
      expect((await json(res)).error.code).toBe('PHOTO_CHECK_NOT_CONFIGURED');
      const announced = await ctx.app.request('/api/cases/analyze', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(500 * 1024 * 1024) }, body: 'x' });
      expect(announced.status).toBe(503); // not 413: the answer does not depend on the body
      expect(existsSync(ctx.uploadsDir)).toBe(false);
    });

    it('answers 503 when there is a model but nowhere to keep the files', async () => {
      const ctx = setup({ model: fakeModel([]), withoutUploads: true });
      expect((await post(ctx.app, miniForm())).status).toBe(503);
    });

    it('still serves what was uploaded before, and the other routes work', async () => {
      const ctx = setup();
      mkdirSync(join(ctx.uploadsDir, 'old-case'), { recursive: true });
      writeFileSync(join(ctx.uploadsDir, 'old-case', 'photo-1.png'), PNG_1PX);
      expect(await bytesOf(await ctx.app.request('/api/cases/old-case/photos/photo-1.png'))).toEqual(PNG_1PX);
      expect((await ctx.app.request('/api/cases/nope')).status).toBe(404);
    });
  });

  describe('serving the uploads', () => {
    const notFound = async (res: Response) => {
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe('NOT_FOUND');
    };

    it('answers 404 for a case or a file that does not exist', async () => {
      const ctx = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      await post(ctx.app, miniForm());
      await notFound(await ctx.app.request('/api/cases/nope/photos/photo-1.png'));
      await notFound(await ctx.app.request('/api/cases/nope/estimate'));
      await notFound(await ctx.app.request('/api/cases/case-1/photos/photo-3.png'));
      await notFound(await ctx.app.request('/api/cases/case-1/photos/photo-1.jpg')); // it is a .png
    });

    it('answers 404 for a name that is not a photo name, and never leaves the uploads directory', async () => {
      const ctx = setup({ model: fakeModel([MINI_EXTRACTED, MINI_JUDGED]) });
      await post(ctx.app, miniForm());
      writeFileSync(join(ctx.dir, 'photo-1.png'), PNG_1PX); // beside the uploads directory
      writeFileSync(join(ctx.dir, 'secret.txt'), 'secret');
      for (const path of [
        '/api/cases/case-1/photos/photo-1.gif',
        '/api/cases/case-1/photos/photo-001.png',
        '/api/cases/case-1/photos/estimate.pdf',
        '/api/cases/case-1/photos/..%2Fsecret.txt',
        '/api/cases/case-1/photos/..%2F..%2Fsecret.txt',
        '/api/cases/..%2F/photos/photo-1.png',
        '/api/cases/..%2Fuploads%2Fcase-1/photos/photo-1.png',
        '/api/cases/..%2F/estimate',
      ]) {
        await notFound(await ctx.app.request(path));
      }
    });

    it('answers 404 for a case made from JSON, which has no uploads', async () => {
      const ctx = setup();
      const res = await ctx.app.request('/api/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payee_name: 'Ridgeway Electric', promised_items: [{ title: 'Fan', qty: 1, price: '310.00' }] }),
      });
      expect(res.status).toBe(201);
      expect(await json(res)).not.toHaveProperty('photos');
      await notFound(await ctx.app.request('/api/cases/case-1/photos/photo-1.png'));
      await notFound(await ctx.app.request('/api/cases/case-1/estimate'));
    });

    it('answers 404 when the app has no upload store', async () => {
      const ctx = setup({ withoutUploads: true });
      await notFound(await ctx.app.request('/api/cases/case-1/photos/photo-1.png'));
      await notFound(await ctx.app.request('/api/cases/case-1/estimate'));
    });
  });
});
