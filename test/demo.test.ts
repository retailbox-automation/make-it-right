import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoCopy, DEMO_DIR, DEMO_OFFER_AMOUNT, demoInput, loadDemo, seedWalkthrough, standInOfferAmount, WALKTHROUGH_ID } from '../src/demo.js';
import { Tracker } from '../src/disputes/tracker.js';
import { HttpError } from '../src/errors.js';
import { KeyedLock } from '../src/lock.js';
import { CaseService } from '../src/service.js';
import { PgliteStore, type Store } from '../src/store.js';
import { NOW } from './helpers/records.js';
import { makeWorld } from './helpers/world.js';

const recorded = () => JSON.parse(readFileSync(join(DEMO_DIR, 'recorded-analysis.json'), 'utf8'));
const payment = () => JSON.parse(readFileSync(join(DEMO_DIR, 'payment.json'), 'utf8'));

function serviceOn(store: Store) {
  const world = makeWorld();
  const locks = new KeyedLock();
  let n = 0;
  const tracker = new Tracker({ store, paypal: world.client, locks });
  const service = new CaseService({
    store, paypal: world.client, tracker, locks, now: () => NOW, newId: () => `copy${++n}`,
    urls: { returnUrl: 'http://localhost:8787/paypal/return', cancelUrl: 'http://localhost:8787/paypal/cancel' },
  });
  return { service, world };
}

const dirs: string[] = [];
const stores: PgliteStore[] = [];
afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const memStore = async () => {
  const store = await PgliteStore.open();
  stores.push(store);
  return store;
};
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mir-demo-'));
  dirs.push(dir);
  return dir;
};

describe('the recorded demo case', () => {
  it('becomes a case: the model\'s items and its own verdicts, the payee and the date from payment.json', () => {
    const input = demoInput(recorded(), payment());
    expect(input.payee_name).toBe('Ridgeway Electric');
    expect(input.paid_at).toBe('2026-09-12');
    expect(input.promised_items.map((i) => i.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(input.verdicts.map((v) => `${v.item_id}:${v.status}:${v.photo_ref}`)).toEqual(['1:done:photo-1', '2:done:photo-2', '3:partial:photo-3', '4:not_done:photo-4', '5:not_done:photo-6', '6:not_done:photo-5']);
  });

  it('uses the end-to-end verdicts (judge_e2e), not the evaluation\'s judge run on the true items', () => {
    const file = recorded();
    file.judge_true.verdicts[3].note = 'judge_true note';
    file.judge_e2e.verdicts[3].note = 'judge_e2e note';
    expect(demoInput(file, payment()).verdicts[3]!.note).toBe('judge_e2e note');
  });

  it('refuses a recorded answer that is not a usable case', () => {
    const file = recorded();
    file.extraction.items[0].price = 'lots';
    expect(() => demoInput(file, payment())).toThrow(/not a usable case.*price/);
    expect(() => demoInput({}, payment())).toThrow(/extraction or judge_e2e/);
    expect(() => demoInput(recorded(), [])).toThrow(/payment.json/);
  });

  it('loads the files in demo/ridgeway: six photos, the estimate, five texts, the payment amount', () => {
    const demo = loadDemo();
    expect(demo.files.uploads).toEqual({ estimate: 'estimate.pdf', photos: ['photo-1.png', 'photo-2.png', 'photo-3.png', 'photo-4.png', 'photo-5.png', 'photo-6.png'] });
    expect(demo.files).toMatchObject({ paid_amount: '3700.00', text_count: 5, template: 'ridgeway', warnings: [] });
  });

  it('stops the start when a verdict names a photo that is not there, or a file is missing', () => {
    const dir = tempDir();
    cpSync(DEMO_DIR, dir, { recursive: true });
    rmSync(join(dir, 'photos', 'photo-6.png'));
    expect(() => loadDemo(dir)).toThrow(/names photo "photo-6"/);
    cpSync(join(DEMO_DIR, 'photos', 'photo-6.png'), join(dir, 'photos', 'photo-6.png'));
    rmSync(join(dir, 'estimate.pdf'));
    expect(() => loadDemo(dir)).toThrow(/estimate.pdf is missing/);
    cpSync(join(DEMO_DIR, 'estimate.pdf'), join(dir, 'estimate.pdf'));
    writeFileSync(join(dir, 'payment.json'), JSON.stringify({ ...payment(), amount: 'a lot' }));
    expect(() => loadDemo(dir)).toThrow(/payment.json: amount/);
    writeFileSync(join(dir, 'payment.json'), JSON.stringify(payment()));
    rmSync(join(dir, 'screen', 'photo-4.jpg'));
    expect(() => loadDemo(dir)).toThrow(/screen\/photo-4.jpg is missing/);
  });
});

/** Width and height from a PNG's IHDR or a JPEG's first SOF marker; enough to compare shapes without a decoder */
function imageSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString('latin1') === 'PNG') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  expect(bytes.readUInt16BE(0)).toBe(0xffd8);
  let at = 2;
  while (at < bytes.length) {
    const marker = bytes.readUInt16BE(at);
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + length;
  }
  throw new Error('no frame header in the JPEG');
}

describe('the light copies of the demo photos the screens show', () => {
  const referenced = [...new Set(loadDemo().input.verdicts.map((v) => v.photo_ref).filter((ref): ref is string => ref !== null))];

  it('exist for every photo the recorded analysis names, under 300 KB, at most 1200 px, with the shape of the original', () => {
    expect(referenced.sort()).toEqual(['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5', 'photo-6']);
    for (const id of referenced) {
      const copy = readFileSync(join(DEMO_DIR, 'screen', `${id}.jpg`));
      const original = imageSize(readFileSync(join(DEMO_DIR, 'photos', `${id}.png`)));
      const light = imageSize(copy);
      expect(copy.length, id).toBeLessThan(300 * 1024);
      expect(Math.max(light.width, light.height), id).toBeLessThanOrEqual(Math.min(1200, Math.max(original.width, original.height)));
      // same aspect ratio: the copy's height is the original's scaled to the copy's width, within 1 px
      expect(Math.abs(light.height - (original.height * light.width) / original.width), id).toBeLessThanOrEqual(1);
    }
  });
});

describe('the walkthrough case', () => {
  it('computes its claim from the items and verdicts: claim 2650.00, proven 1050.00, paid 3700.00', async () => {
    const { service } = serviceOn(await memStore());
    // The amounts in the recorded file are not read: change them all and the claim stays what the code computes
    const file = recorded();
    file.claim = { ...file.claim, amount: '9999.99', proven_done: '0.01', paid_total: '1.00', lines: [] };
    const demo = { ...loadDemo(), input: demoInput(file, payment()) };
    const { view } = await seedWalkthrough(service, demo);
    expect(view.case).toMatchObject({ id: WALKTHROUGH_ID, template: 'ridgeway', read_only: true, paid_at: '2026-09-12', paid_amount: '3700.00' });
    expect(view.claim).toMatchObject({ amount: '2650.00', proven_done: '1050.00', paid_total: '3700.00' });
    expect(view.claim.lines.map((l) => l.claim_amount)).toEqual(['0.00', '0.00', '240.00', '1300.00', '460.00', '650.00']);
  });

  it('gets a different claim when one verdict changes (the claim really comes from the verdicts)', async () => {
    const { service } = serviceOn(await memStore());
    const file = recorded();
    file.judge_e2e.verdicts[3] = { ...file.judge_e2e.verdicts[3], status: 'done', done_units: 1 }; // the panel upgrade, $1,300
    const { view } = await seedWalkthrough(service, { ...loadDemo(), input: demoInput(file, payment()) });
    expect(view.claim).toMatchObject({ amount: '1350.00', proven_done: '2350.00', paid_total: '3700.00' });
  });

  it('shows the demo files: the photos and the estimate the photo check read, from demo/ridgeway', async () => {
    const { service } = serviceOn(await memStore());
    const { view } = await seedWalkthrough(service, loadDemo());
    expect(view.photos?.map((p) => `${p.id} ${p.url}`)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `photo-${n} /demo/ridgeway/photos/photo-${n}.png`));
    expect(view.estimate_url).toBe('/demo/ridgeway/estimate.pdf');
    expect(view.analysis).toEqual({ warnings: [], text_count: 5 });
  });

  it('is stored once on a persistent data directory: seeding again changes nothing, and a tampered copy is put back', async () => {
    const dir = tempDir();
    let store = await PgliteStore.open(dir);
    const first = await seedWalkthrough(serviceOn(store).service, loadDemo());
    expect(first.changed).toBe(true);
    await store.close();

    store = await PgliteStore.open(dir);
    stores.push(store);
    const again = await seedWalkthrough(serviceOn(store).service, loadDemo());
    expect(again.changed).toBe(false);
    expect(again.view).toEqual(first.view);
    expect((await store.list()).length).toBe(1);

    const stored = (await store.get(WALKTHROUGH_ID))!;
    await store.put({ ...stored, payee_name: 'Someone else', payment: { order_id: 'X', approve_url: 'https://www.sandbox.paypal.com/x', status: 'created', capture_id: null, capture_status: null, captured_at: null, method: null } });
    const repaired = await seedWalkthrough(serviceOn(store).service, loadDemo());
    expect(repaired.changed).toBe(true);
    expect(repaired.view.case).toMatchObject({ payee_name: 'Ridgeway Electric', payment: null, created_at: first.view.case.created_at });
  });

  it('cannot be paid or changed through the service, and asks PayPal nothing', async () => {
    const { service, world } = serviceOn(await memStore());
    await seedWalkthrough(service, loadDemo());
    for (const attempt of [
      () => service.startPayment(WALKTHROUGH_ID),
      () => service.capture(WALKTHROUGH_ID),
      () => service.escalate(WALKTHROUGH_ID),
      () => service.adjudicate(WALKTHROUGH_ID, 'BUYER_FAVOR'),
      () => service.contractorOffer(WALKTHROUGH_ID, { amount: '100.00' }),
      () => service.contractorAcceptClaim(WALKTHROUGH_ID),
      () => service.contractorEvidence(WALKTHROUGH_ID, {}),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ status: 403, code: 'READ_ONLY_CASE' });
    }
    expect(world.fake.calls).toEqual([]);
  });
});

describe('a copy of the demo case', () => {
  it('has the same punch list and claim, a new id, no payment date, and can be paid', async () => {
    const { service, world } = serviceOn(await memStore());
    const copy = await createDemoCopy(service, loadDemo());
    expect(copy.case.id).toBe('copy1');
    expect(copy.case).toMatchObject({ template: 'ridgeway', paid_at: null, payment: null });
    expect(copy.case.read_only).toBeUndefined();
    expect(copy.claim).toMatchObject({ amount: '2650.00', proven_done: '1050.00', paid_total: '3700.00', day_n: null });
    expect(copy.photos?.[0]?.url).toBe('/demo/ridgeway/photos/photo-1.png');

    const paid = await service.startPayment(copy.case.id);
    expect(paid.order_id).toBe('5X6481368Y377541C');
    const order = JSON.parse(world.fake.calls.find((c) => c.path === '/v2/checkout/orders')!.body);
    expect(order.purchase_units[0].amount.value).toBe('3700.00');
    expect(order.purchase_units[0].custom_id).toBe('MIR-copy1');
  });
});

describe('the contractor stand-in\'s offer amount', () => {
  it('is fixed in the public demo, on demo copies only', () => {
    expect(standInOfferAmount({ publicDemo: true, template: 'ridgeway', requested: undefined })).toBe(DEMO_OFFER_AMOUNT);
    expect(standInOfferAmount({ publicDemo: true, template: 'ridgeway', requested: DEMO_OFFER_AMOUNT })).toBe(DEMO_OFFER_AMOUNT);
    expect(() => standInOfferAmount({ publicDemo: true, template: 'ridgeway', requested: '1.00' })).toThrow(HttpError);
    expect(() => standInOfferAmount({ publicDemo: true, template: 'ridgeway', requested: '2650.00' })).toThrow(/always offers \$1200.00/);
    expect(() => standInOfferAmount({ publicDemo: true, template: undefined, requested: undefined })).toThrow(/only on copies of the demo case/);
  });

  it('is the caller\'s outside the public demo, with the demo amount as the default on demo copies', () => {
    expect(standInOfferAmount({ publicDemo: false, template: undefined, requested: '300.00' })).toBe('300.00');
    expect(standInOfferAmount({ publicDemo: false, template: undefined, requested: undefined })).toBeUndefined();
    expect(standInOfferAmount({ publicDemo: false, template: 'ridgeway', requested: undefined })).toBe(DEMO_OFFER_AMOUNT);
    expect(standInOfferAmount({ publicDemo: false, template: 'ridgeway', requested: '500.00' })).toBe('500.00');
  });
});
