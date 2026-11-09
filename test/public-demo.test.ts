import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { callsPayPal, createApp, type AppOptions } from '../src/app.js';
import { RefundCap } from '../src/caps.js';
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

/** The public demo's limits with their defaults (src/config.ts) */
const LIMITS = { perAddressPerDay: 25, perDay: 60, actionsPerAddress: 30, actionsWindowMinutes: 10, refundsPerDay: 5 };

function build(options: Partial<AppOptions> = {}): Hono {
  const refunds = options.publicDemo ? { refunds: new RefundCap(world.store, options.publicDemo.refundsPerDay, () => now) } : {};
  return createApp(service, { log: () => undefined, demo, trustForwardedFor: true, now: () => now, ...refunds, ...options });
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

const PUBLIC = { publicDemo: LIMITS };
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
    const app = build({ publicDemo: { ...LIMITS, perAddressPerDay: 2, perDay: 3 } });
    for (const address of ['a', 'b', 'c']) expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from(address) })).status).toBe(201);
    const over = await send(app, '/api/demo/cases', { method: 'POST', headers: from('d') });
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe('DEMO_DAILY_LIMIT');
  });

  it('counts the address from X-Forwarded-For only when the proxy is trusted', async () => {
    const app = build({ publicDemo: { ...LIMITS, perAddressPerDay: 1, perDay: 10 }, trustForwardedFor: false });
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('a') })).status).toBe(201);
    // Without trust every request counts as the same (unknown) address, whatever the header says
    expect((await send(app, '/api/demo/cases', { method: 'POST', headers: from('b') })).status).toBe(429);
  });

  it('gives the place back when the copy cannot be made', async () => {
    let reads = 0;
    const failsOnce = { ...demo, get input() { reads += 1; return reads === 1 ? { ...demo.input, payee_name: '' } : demo.input; } };
    const app = build({ publicDemo: { ...LIMITS, perAddressPerDay: 1, perDay: 1 }, demo: failsOnce });
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

describe('limits on PayPal steps in the public demo', () => {
  async function paidCopy(app: Hono, dispute?: Record<string, unknown>) {
    const { case: made } = await json(await send(app, '/api/demo/cases', { method: 'POST', headers: from('setup') }));
    await send(app, `/api/cases/${made.id}/payment`, { method: 'POST', headers: from('setup') });
    await send(app, `/api/cases/${made.id}/capture`, { method: 'POST', headers: from('setup') });
    if (dispute) {
      world.dispute = { ...fixture('dispute-a-open'), dispute_amount: { currency_code: 'USD', value: '2650.00' }, ...dispute };
      world.listed = true;
    }
    return made.id as string;
  }
  const refundCalls = () => world.fake.calls.filter((c) => c.path.endsWith('/accept-claim') || c.path.endsWith('/adjudicate')).length;

  describe('refunds the app sets off', () => {
    it('allows 5 a day in all, PayPal deciding and the stand-in accepting together, then answers 429 without asking PayPal', async () => {
      const app = build(PUBLIC);
      const inquiry = await paidCopy(app, {});
      for (let i = 0; i < 3; i += 1) expect((await send(app, `/api/sim/contractor/${inquiry}/accept-claim`, { method: 'POST', headers: from(`j${i}`) })).status).toBe(200);
      world.dispute = { ...world.dispute!, dispute_life_cycle_stage: 'CHARGEBACK', status: 'UNDER_REVIEW' };
      for (let i = 0; i < 2; i += 1) expect((await send(app, `/api/cases/${inquiry}/adjudicate`, { method: 'POST', headers: from(`k${i}`), body: { outcome: 'BUYER_FAVOR' } })).status).toBe(200);
      expect(refundCalls()).toBe(5);

      const over = await send(app, `/api/cases/${inquiry}/adjudicate`, { method: 'POST', headers: from('k9'), body: { outcome: 'BUYER_FAVOR' } });
      expect(over.status).toBe(429);
      expect((await json(over)).error).toEqual({ code: 'DEMO_REFUND_LIMIT', message: expect.stringMatching(/made its 5 refunds for today/) });
      expect(over.headers.get('retry-after')).toBe(String(9 * 3600));
      expect((await send(app, `/api/sim/contractor/${inquiry}/accept-claim`, { method: 'POST', headers: from('k10') })).status).toBe(429);
      expect(refundCalls()).toBe(5);

      now = new Date('2026-11-10T00:00:01.000Z');
      expect((await send(app, `/api/sim/contractor/${inquiry}/accept-claim`, { method: 'POST', headers: from('k11') })).status).toBe(200);
    });

    it('counts only the steps PayPal took: a refusal gives the place back, an unanswered call keeps it', async () => {
      const app = build({ publicDemo: { ...LIMITS, refundsPerDay: 2 } });
      const id = await paidCopy(app, {});
      world.postAnswer = () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSUFFICIENT_FUNDS' }] } });
      for (let i = 0; i < 3; i += 1) expect((await send(app, `/api/sim/contractor/${id}/accept-claim`, { method: 'POST', headers: from(`r${i}`) })).status).toBe(409);
      world.postAnswer = () => ({ status: 503, body: { name: 'SERVICE_UNAVAILABLE' } });
      expect((await send(app, `/api/sim/contractor/${id}/accept-claim`, { method: 'POST', headers: from('u') })).status).toBe(502);
      world.postAnswer = null;
      expect((await send(app, `/api/sim/contractor/${id}/accept-claim`, { method: 'POST', headers: from('ok') })).status).toBe(200);
      expect((await send(app, `/api/sim/contractor/${id}/accept-claim`, { method: 'POST', headers: from('ok2') })).status).toBe(429);
    });

    it('does not let requests at the same moment pass the cap together', async () => {
      const app = build({ publicDemo: { ...LIMITS, refundsPerDay: 3 } });
      const id = await paidCopy(app, {});
      const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => send(app, `/api/sim/contractor/${id}/accept-claim`, { method: 'POST', headers: from(`p${i}`) })));
      expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
      expect(refundCalls()).toBe(3);
    });

    it('is not needed outside the public demo, and the public demo refuses to run without it', () => {
      expect(() => createApp(service, { log: () => undefined, demo, publicDemo: LIMITS })).toThrow(/needs the daily refund cap/);
      expect(() => createApp(service, { log: () => undefined, demo })).not.toThrow();
    });
  });

  describe('steps per address', () => {
    it('allows so many PayPal steps per address in the window, then 429 until it passes', async () => {
      const app = build({ publicDemo: { ...LIMITS, actionsPerAddress: 3, actionsWindowMinutes: 10 } });
      const id = await paidCopy(app);
      const steps = [
        () => send(app, `/api/cases/${id}/escalate`, { method: 'POST', headers: from('x') }),
        () => send(app, `/api/cases/${id}/dispute`, { headers: from('x') }),
        () => send(app, `/api/sim/contractor/${id}/evidence`, { method: 'POST', headers: from('x') }),
      ];
      for (const step of steps) expect((await step()).status).not.toBe(429);
      const over = await send(app, `/api/cases/${id}/payment`, { method: 'POST', headers: from('x') });
      expect(over.status).toBe(429);
      expect((await json(over)).error).toEqual({ code: 'TOO_MANY_PAYPAL_STEPS', message: expect.stringMatching(/Too many PayPal steps from this address/) });
      expect(over.headers.get('retry-after')).toBe('600');
      // reading the case and starting a copy are not PayPal steps; another address has its own allowance
      expect((await send(app, `/api/cases/${id}`, { headers: from('x') })).status).toBe(200);
      expect((await send(app, `/api/cases/${id}/dispute`, { headers: from('y') })).status).toBe(200);

      now = new Date(now.getTime() + 10 * 60_000);
      expect((await send(app, `/api/cases/${id}/dispute`, { headers: from('x') })).status).toBe(200);
    });

    it('counts a route however it is spelled', () => {
      for (const [method, path] of [
        ['POST', '/api/cases/abc/escalate'], ['POST', '/api/cases/abc/escalate/'], ['POST', '/api/cases/abc/ADJUDICATE'], ['POST', '/API/cases/abc/payment'],
        ['POST', '/api/sim/contractor/abc/offer'], ['POST', '/api/SIM/contractor/abc/accept-claim/'], ['GET', '/api/cases/abc/dispute'], ['GET', '/api/cases/abc/dispute//'],
      ] as const) expect(callsPayPal(method, path), `${method} ${path}`).toBe(true);
      for (const [method, path] of [['GET', '/api/cases/abc'], ['POST', '/api/cases'], ['POST', '/api/demo/cases'], ['POST', '/api/cases/analyze'], ['GET', '/api/cases/abc/photos/photo-1.png']] as const) {
        expect(callsPayPal(method, path), `${method} ${path}`).toBe(false);
      }
    });

    it('lets no spelling of POST /api/cases make a case from JSON', async () => {
      const app = build(PUBLIC);
      for (const path of ['/api/cases', '/api/cases?x=1', '/api/cases/', '/API/CASES', '/Api/Cases']) {
        const res = await send(app, path, { method: 'POST', body: ownCase });
        expect([403, 404], path).toContain(res.status);
      }
      expect(await world.store.list()).toHaveLength(1); // the walkthrough only
    });
  });

  describe('"no claim filed yet" is remembered for 30 seconds per case', () => {
    it('does not ask PayPal for the list of claims on every click before the claim is filed', async () => {
      const locks = new KeyedLock();
      const remembering = new CaseService({
        store: world.store, paypal: world.client, tracker: new Tracker({ store: world.store, paypal: world.client, locks }), locks,
        now: () => now, newId: () => 'memo1', noClaimMemoryMs: 30_000,
        urls: { returnUrl: 'https://demo.example/paypal/return', cancelUrl: 'https://demo.example/paypal/cancel' },
      });
      const app = createApp(remembering, { log: () => undefined, demo, now: () => now });
      const id = await paidCopy(app);
      const lists = () => world.fake.calls.filter((c) => c.path === '/v1/customer/disputes').length;

      expect((await send(app, `/api/sim/contractor/${id}/offer`, { method: 'POST' })).status).toBe(409);
      expect((await send(app, `/api/cases/${id}/escalate`, { method: 'POST' })).status).toBe(409);
      now = new Date(now.getTime() + 20_000);
      expect((await json(await send(app, `/api/cases/${id}/dispute`))).dispute).toBeNull();
      expect(lists()).toBe(1);

      world.dispute = { ...fixture('dispute-a-open'), dispute_amount: { currency_code: 'USD', value: '2650.00' } };
      world.listed = true;
      now = new Date(now.getTime() + 11_000);
      expect((await json(await send(app, `/api/cases/${id}/dispute`))).dispute).toMatchObject({ status: 'OPEN' });
      expect(lists()).toBe(2);
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
