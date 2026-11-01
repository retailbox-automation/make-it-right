import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Tracker } from '../src/disputes/tracker.js';
import { KeyedLock } from '../src/lock.js';
import { PayPalClient } from '../src/paypal/client.js';
import { ownershipFrom } from '../src/ownership.js';
import { CaseService } from '../src/service.js';
import { PgliteStore, type Store } from '../src/store.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './helpers/demo.js';
import { fixture } from './helpers/fake-paypal.js';
import { NOW } from './helpers/records.js';
import { CASE_ID, DISPUTE_ID, ORDER_ID, makeWorld, type World } from './helpers/world.js';

let world: World;
let app: Hono;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function build(world: World, store: Store = world.store, client: PayPalClient = world.client) {
  const locks = new KeyedLock();
  const tracker = new Tracker({ store, paypal: client, locks });
  const service = new CaseService({ store, paypal: client, tracker, locks, now: () => NOW, newId: () => CASE_ID, urls: { returnUrl: 'http://localhost:8787/r', cancelUrl: 'http://localhost:8787/c' } });
  return createApp(service, { log: () => undefined });
}

beforeEach(() => {
  world = makeWorld();
  app = build(world);
});

const send = (path: string, method = 'GET', body?: unknown) =>
  app.request(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
const json = async (res: Response) => (await res.json()) as any;
const demo = () => ({ payee_name: 'Ridgeway Electric', promised_items: RIDGEWAY_ITEMS, verdicts: RIDGEWAY_VERDICTS, paid_at: '2026-09-12' });

describe('cases', () => {
  it('POST /api/cases makes a case with its claim', async () => {
    const res = await send('/api/cases', 'POST', demo());
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(['case', 'claim', 'dispute', 'filing', 'offer', 'outcome', 'promised_items', 'verdicts']);
    expect(body.claim).toMatchObject({ amount: '3150.00', proven_done: '1050.00', paid_total: '4200.00', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
    expect(body.case.id).toBe(CASE_ID);
  });

  it('GET /api/cases/:id returns the same view', async () => {
    await send('/api/cases', 'POST', demo());
    const res = await send(`/api/cases/${CASE_ID}`);
    expect(res.status).toBe(200);
    expect((await json(res)).claim.amount).toBe('3150.00');
  });

  it('answers 404 for an unknown case, in JSON', async () => {
    const res = await send('/api/cases/nope');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'NOT_FOUND', message: 'case nope not found' } });
  });

  it('answers 400 for bad input and for a body that is not JSON', async () => {
    const bad = await send('/api/cases', 'POST', { payee_name: '' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe('INVALID_INPUT');
    const notJson = await send('/api/cases', 'POST', '{nope');
    expect(notJson.status).toBe(400);
    expect((await json(notJson)).error.message).toMatch(/JSON/);
    const empty = await app.request('/api/cases', { method: 'POST' });
    expect(empty.status).toBe(400);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await send('/api/nothing-here');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
  });
});

describe('payment and claim', () => {
  beforeEach(async () => {
    await send('/api/cases', 'POST', demo());
  });

  it('POST payment gives the PayPal approval link', async () => {
    const res = await send(`/api/cases/${CASE_ID}/payment`, 'POST');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ order_id: ORDER_ID, approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` });
  });

  it('POST capture is 409 until the homeowner approves', async () => {
    await send(`/api/cases/${CASE_ID}/payment`, 'POST');
    world.approved = false;
    const refused = await send(`/api/cases/${CASE_ID}/capture`, 'POST');
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.code).toBe('ORDER_NOT_APPROVED');
    world.approved = true;
    const done = await send(`/api/cases/${CASE_ID}/capture`, 'POST');
    expect(done.status).toBe(200);
    expect((await json(done)).case.payment).toMatchObject({ status: 'captured', capture_id: '9UA851170T503222E' });
  });

  it('GET dispute is empty until PayPal lists the claim', async () => {
    await send(`/api/cases/${CASE_ID}/payment`, 'POST');
    await send(`/api/cases/${CASE_ID}/capture`, 'POST');
    const res = await send(`/api/cases/${CASE_ID}/dispute`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ dispute: null, offer: null, outcome: null });
  });

  it('turns PayPal being down into 502', async () => {
    await send(`/api/cases/${CASE_ID}/payment`, 'POST');
    world.fake.setRoute(() => ({ status: 503, body: { name: 'SERVICE_UNAVAILABLE' } }));
    const res = await send(`/api/cases/${CASE_ID}/capture`, 'POST');
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe('PAYPAL_UNAVAILABLE');
  });

  it('hides an unexpected failure behind a plain 500', async () => {
    const boom = new Error('secret-looking detail');
    const broken = makeWorld();
    const failingStore = { ...broken.store, get: async () => { throw boom; } } as unknown as Store;
    const res = await build(broken, failingStore).request(`/api/cases/x`);
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });
});

describe('sandbox helpers over HTTP', () => {
  beforeEach(async () => {
    await send('/api/cases', 'POST', demo());
    await send(`/api/cases/${CASE_ID}/payment`, 'POST');
    await send(`/api/cases/${CASE_ID}/capture`, 'POST');
    world.listed = true;
    world.dispute = fixture('dispute-a-waiting-for-seller');
    await send(`/api/cases/${CASE_ID}/dispute`);
  });

  it('POST escalate says it is sandbox only', async () => {
    const res = await send(`/api/cases/${CASE_ID}/escalate`, 'POST');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ sandbox_only: true, note: expect.stringContaining('this helper exists for the sandbox demo') });
  });

  it('POST adjudicate takes BUYER_FAVOR or SELLER_FAVOR and is 409 while PayPal has not opened it', async () => {
    world.postAnswer = () => ({ status: 400, body: fixture('error-adjudicate-not-allowed') });
    const early = await send(`/api/cases/${CASE_ID}/adjudicate`, 'POST', { outcome: 'BUYER_FAVOR' });
    expect(early.status).toBe(409);
    expect((await json(early)).error.message).toBe('PayPal opens this step after a review delay');
    const bad = await send(`/api/cases/${CASE_ID}/adjudicate`, 'POST', { outcome: 'half' });
    expect(bad.status).toBe(400);
    world.postAnswer = null;
    const ok = await send(`/api/cases/${CASE_ID}/adjudicate`, 'POST', { outcome: 'SELLER_FAVOR' });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ sandbox_only: true, action: 'adjudicate' });
  });

  it('POST sim offer and accept-claim carry sandbox_only', async () => {
    const offer = await send(`/api/sim/contractor/${CASE_ID}/offer`, 'POST', { amount: '300.00' });
    expect(offer.status).toBe(200);
    expect(await json(offer)).toMatchObject({ sandbox_only: true, action: 'make-offer', amount: '300.00' });
    const noAmount = await send(`/api/sim/contractor/${CASE_ID}/offer`, 'POST', {});
    expect(noAmount.status).toBe(400);
    const accept = await send(`/api/sim/contractor/${CASE_ID}/accept-claim`, 'POST');
    expect(accept.status).toBe(200);
    expect(await json(accept)).toMatchObject({ sandbox_only: true, action: 'accept-claim' });
  });

  it('the helpers are 404 for an unknown case', async () => {
    for (const [path, body] of [['/escalate', undefined], ['/adjudicate', { outcome: 'BUYER_FAVOR' }]] as const) {
      expect((await send(`/api/cases/nope${path}`, 'POST', body)).status, path).toBe(404);
    }
    expect((await send('/api/sim/contractor/nope/accept-claim', 'POST')).status).toBe(404);
  });
});

describe('a whole case over HTTP, on a database', () => {
  it('goes from the promised items to the money back, and keeps the original claim amount', async () => {
    const store = await PgliteStore.open();
    cleanups.push(() => store.close());
    const w = makeWorld();
    // the world's guard asks its own store; give it the database instead
    const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetch: w.fake.fetch, owns: ownershipFrom(store) });
    const live = build(w, store, client);
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const res = await live.request(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      return { status: res.status, body: (await res.json()) as any };
    };

    expect((await call('/api/cases', 'POST', demo())).status).toBe(201);
    expect((await call(`/api/cases/${CASE_ID}/payment`, 'POST')).body.order_id).toBe(ORDER_ID);
    expect((await call(`/api/cases/${CASE_ID}/capture`, 'POST')).body.case.payment.status).toBe('captured');
    expect((await call(`/api/cases/${CASE_ID}/dispute`)).body.dispute).toBeNull();

    w.listed = true;
    w.dispute = fixture('dispute-a-open');
    let state = (await call(`/api/cases/${CASE_ID}/dispute`)).body;
    expect(state.dispute).toMatchObject({ id: DISPUTE_ID, status: 'OPEN', original_claim_amount: '400.00' });
    expect((await call(`/api/cases/${CASE_ID}`)).body.filing.filing_url).toBe('https://www.sandbox.paypal.com/resolutioncenter/filing/27S431280V029084G');

    w.dispute = fixture('dispute-a-waiting-for-seller');
    w.postAnswer = () => {
      w.dispute = fixture('dispute-a-offer-pending');
      return undefined;
    };
    const offered = await call(`/api/sim/contractor/${CASE_ID}/offer`, 'POST', { amount: '300.00' });
    expect(offered.status).toBe(200);
    expect(offered.body.offer).toMatchObject({ amount: '300.00', status: 'pending' });

    w.dispute = fixture('dispute-a-offer-accepted');
    state = (await call(`/api/cases/${CASE_ID}/dispute`)).body;
    expect(state.offer.status).toBe('accepted');
    expect(state.dispute).toMatchObject({ dispute_amount: '300.00', original_claim_amount: '400.00' });

    w.dispute = fixture('dispute-a-resolved');
    state = (await call(`/api/cases/${CASE_ID}/dispute`)).body;
    expect(state.outcome).toEqual({
      status: 'money_back', amount_refunded: '300.00', refund_destination: 'the payment method you used',
      decided_at: '2026-10-31T18:31:24.502Z', outcome_code: 'RESOLVED_BUYER_FAVOUR', outcome_reason: 'INQUIRY_OFFER_PARTIAL_REFUND',
    });
    const final = (await call(`/api/cases/${CASE_ID}`)).body;
    expect(final.claim.amount).toBe('3150.00'); // our claim, whatever PayPal rewrites
    expect(final.dispute.original_claim_amount).toBe('400.00');
  });
});
