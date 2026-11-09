import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { DEMO_OFFER_AMOUNT, loadDemo, seedWalkthrough, WALKTHROUGH_ID } from '../src/demo.js';
import { Tracker } from '../src/disputes/tracker.js';
import { KeyedLock } from '../src/lock.js';
import { CaseService } from '../src/service.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './helpers/demo.js';
import { fixture } from './helpers/fake-paypal.js';
import { makeWorld, type World } from './helpers/world.js';

const demo = loadDemo();
let world: World;
let service: CaseService;
let now: Date;

function build(options: Partial<AppOptions> = {}): Hono {
  return createApp(service, { log: () => undefined, demo, trustForwardedFor: true, now: () => now, ...options });
}

beforeEach(async () => {
  now = new Date('2026-11-09T15:00:00.000Z');
  world = makeWorld();
  const locks = new KeyedLock();
  let n = 0;
  service = new CaseService({
    store: world.store, paypal: world.client, tracker: new Tracker({ store: world.store, paypal: world.client, locks }), locks,
    now: () => now, newId: () => `copy${++n}`,
    urls: { returnUrl: 'https://demo.example/paypal/return', cancelUrl: 'https://demo.example/paypal/cancel' },
  });
  await seedWalkthrough(service, demo);
});

const PUBLIC = { publicDemo: { perAddressPerDay: 25, perDay: 60 } };
const from = (address: string) => ({ 'x-forwarded-for': address });
const json = async (res: Response) => (await res.json()) as any;
const send = (app: Hono, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
const ownCase = { payee_name: 'Ridgeway Electric', promised_items: RIDGEWAY_ITEMS, verdicts: RIDGEWAY_VERDICTS };

describe('the public demo (MIR_PUBLIC_DEMO=1)', () => {
  it('refuses cases made from any JSON with a plain reason', async () => {
    const res = await send(build(PUBLIC), '/api/cases', { method: 'POST', body: ownCase });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toEqual({ code: 'PUBLIC_DEMO', message: expect.stringMatching(/only from the recorded demo case/) });
    expect(await world.store.list()).toHaveLength(1); // the walkthrough only
  });

  it('answers the photo check with 503: the hosted demo replays the recorded analysis, the live check runs locally', async () => {
    const res = await build(PUBLIC).request('/api/cases/analyze', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(503);
    const { error } = await json(res);
    expect(error.code).toBe('PHOTO_CHECK_NOT_ON_HOST');
    expect(error.message).toMatch(/recorded analysis of the demo case by Gemma 4 31B/);
    expect(error.message).toMatch(/runs when you run the app locally/);
  });

  it('makes copies of the demo case only, with the same claim of 2650.00, whatever the request says', async () => {
    const app = build(PUBLIC);
    const res = await send(app, '/api/demo/cases', { method: 'POST', headers: from('203.0.113.7') });
    expect(res.status).toBe(201);
    const copy = await json(res);
    expect(copy.case).toMatchObject({ id: 'copy1', template: 'ridgeway', payee_name: 'Ridgeway Electric' });
    expect(copy.claim).toMatchObject({ amount: '2650.00', proven_done: '1050.00', paid_total: '3700.00' });

    const tampered = await send(app, '/api/demo/cases', { method: 'POST', headers: from('203.0.113.7'), body: { promised_items: [{ title: 'x', qty: 1, price: '9999.00' }], verdicts: [] } });
    expect(tampered.status).toBe(400);
    expect((await json(tampered)).error.message).toMatch(/takes no body/);
    expect(await world.store.list()).toHaveLength(2);
  });

  it('caps new cases per address per day (25 by default) with a 429 and a plain message', async () => {
    const app = build(PUBLIC);
    for (let i = 0; i < 25; i += 1) expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('198.51.100.1') })).status).toBe(201);
    const over = await send(app, '/api/demo/cases', { method: 'POST', headers: from('198.51.100.1') });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe(String(9 * 3600));
    expect((await json(over)).error).toEqual({ code: 'DEMO_ADDRESS_LIMIT', message: expect.stringMatching(/started 25 live demo cases today/) });
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('198.51.100.2') })).status).toBe(201);

    now = new Date('2026-11-10T00:00:01.000Z');
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('198.51.100.1') })).status).toBe(201);
  });

  it('caps new cases in all per day, across addresses', async () => {
    const app = build({ publicDemo: { perAddressPerDay: 2, perDay: 3 } });
    for (const address of ['a', 'b', 'c']) expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from(address) })).status).toBe(201);
    const over = await send(app, '/api/demo/cases', { method: 'POST', headers: from('d') });
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe('DEMO_DAILY_LIMIT');
  });

  it('counts the address from X-Forwarded-For only when the proxy is trusted', async () => {
    const app = build({ publicDemo: { perAddressPerDay: 1, perDay: 10 }, trustForwardedFor: false });
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') })).status).toBe(201);
    // Without trust every request counts as the same (unknown) address, whatever the header says
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('b') })).status).toBe(429);
  });

  it('gives the place back when the copy cannot be made', async () => {
    let reads = 0;
    const failsOnce = { ...demo, get input() { reads += 1; return reads === 1 ? { ...demo.input, payee_name: '' } : demo.input; } };
    const app = build({ publicDemo: { perAddressPerDay: 1, perDay: 1 }, demo: failsOnce });
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') })).status).toBe(400);
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') })).status).toBe(201);
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') })).status).toBe(429);
  });

  it('keeps the walkthrough read-only: no payment, no PayPal call', async () => {
    const app = build(PUBLIC);
    for (const path of [`/api/cases/${WALKTHROUGH_ID}/payment`, `/api/cases/${WALKTHROUGH_ID}/capture`, `/api/cases/${WALKTHROUGH_ID}/escalate`, `/api/sim/contractor/${WALKTHROUGH_ID}/accept-claim`]) {
      const res = await send(app, path, { method: 'POST' });
      expect(res.status, path).toBe(403);
      expect((await json(res)).error.code).toBe('READ_ONLY_CASE');
    }
    expect(world.fake.calls).toEqual([]);
    expect((await json(await send(app, `/api/cases/${WALKTHROUGH_ID}`))).case.payment).toBeNull();
  });

  describe('the contractor stand-in on a copy', () => {
    async function copyWithClaim(app: Hono) {
      const { case: made } = await json(await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') }));
      await send(app, `/api/cases/${made.id}/payment`, { method: 'POST' });
      await send(app, `/api/cases/${made.id}/capture`, { method: 'POST' });
      // A recorded claim, filed for the demo amount; the copy finds it through the capture id, as in the sandbox
      world.dispute = { ...fixture('dispute-a-open'), dispute_amount: { currency_code: 'USD', value: '2650.00' } };
      world.listed = true;
      return made.id as string;
    }

    it('offers the fixed demo amount when the request names none', async () => {
      const app = build(PUBLIC);
      const id = await copyWithClaim(app);
      const res = await send(app, `/api/sim/contractor/${id}/offer`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await json(res)).amount).toBe(DEMO_OFFER_AMOUNT);
      const offer = world.fake.calls.find((c) => c.path.endsWith('/make-offer'))!;
      expect(JSON.parse(offer.body).offer_amount).toEqual({ currency_code: 'USD', value: '1200.00' });
    });

    it('refuses another amount in the public demo, before asking PayPal', async () => {
      const app = build(PUBLIC);
      const id = await copyWithClaim(app);
      const before = world.fake.calls.length;
      const res = await send(app, `/api/sim/contractor/${id}/offer`, { method: 'POST', body: { amount: '1.00' } });
      expect(res.status).toBe(403);
      expect((await json(res)).error.message).toMatch(/always offers/);
      expect(world.fake.calls.length).toBe(before);
    });
  });
});

describe('outside the public demo (the default)', () => {
  it('still takes cases as JSON and has no daily caps on demo copies', async () => {
    const app = build();
    expect((await send(app, '/api/cases', { method: 'POST', body: ownCase })).status).toBe(201);
    for (let i = 0; i < 30; i += 1) expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') })).status).toBe(201);
  });

  it('keeps the old answer of the photo check without a model', async () => {
    const res = await build().request('/api/cases/analyze', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe('PHOTO_CHECK_NOT_CONFIGURED');
  });

  it('answers 404 for demo copies on a server without the demo files', async () => {
    const res = await send(createApp(service, { log: () => undefined }), '/api/demo/cases', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
