import { beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { Tracker } from '../src/disputes/tracker.js';
import { KeyedLock } from '../src/lock.js';
import { CaseService } from '../src/service.js';
import { fixture } from './helpers/fake-paypal.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './helpers/demo.js';
import { NOW } from './helpers/records.js';
import { CAPTURE_ID, CASE_ID, DISPUTE_ID, ORDER_ID, makeWorld, type World } from './helpers/world.js';

let world: World;
let service: CaseService;
let logged: string[];

beforeEach(() => {
  world = makeWorld();
  logged = [];
  const locks = new KeyedLock();
  const log = (m: string) => logged.push(m);
  const tracker = new Tracker({ store: world.store, paypal: world.client, locks, log });
  service = new CaseService({
    store: world.store, paypal: world.client, tracker, locks, log,
    now: () => NOW, newId: () => CASE_ID,
    urls: { returnUrl: 'http://localhost:8787/paypal/return', cancelUrl: 'http://localhost:8787/paypal/cancel' },
  });
});

const demoInput = (over: Record<string, unknown> = {}) => ({
  payee_name: 'Ridgeway Electric',
  promised_items: RIDGEWAY_ITEMS,
  verdicts: RIDGEWAY_VERDICTS,
  paid_at: '2026-09-12',
  ...over,
});
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as HttpError;
const posts = () => world.fake.calls.filter((c) => c.method === 'POST');

/** A recorded dispute answer, made to be about our case (the recorded cases B and C had other ids) */
function ours(name: string) {
  const raw = fixture(name);
  raw.dispute_id = DISPUTE_ID;
  raw.disputed_transactions = fixture('dispute-a-open').disputed_transactions;
  return raw;
}

/** Pay and let the claim be listed, so there is something to act on */
async function withClaim(state: string = 'dispute-a-waiting-for-seller') {
  await service.createCase(demoInput());
  await service.startPayment(CASE_ID);
  await service.capture(CASE_ID);
  world.listed = true;
  world.dispute = ours(state);
  await service.getDispute(CASE_ID);
  world.fake.calls.length = 0;
}

describe('creating a case', () => {
  it('computes the claim from the items and the verdicts and makes no PayPal call', async () => {
    const view = await service.createCase(demoInput());
    expect(view.case).toMatchObject({ id: CASE_ID, payee_name: 'Ridgeway Electric', created_at: NOW.toISOString(), paid_at: '2026-09-12', payment: null });
    expect(view.claim).toMatchObject({ amount: '3150.00', proven_done: '1050.00', paid_total: '4200.00', payee_name: 'Ridgeway Electric', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', paid_at: '2026-09-12', day_n: 50 });
    expect(view.promised_items).toHaveLength(6);
    expect(view.verdicts).toHaveLength(6);
    expect(view.filing).toEqual({ filing_url: 'https://www.sandbox.paypal.com/resolutioncenter', proof: [], filed_at: null });
    expect([view.dispute, view.offer, view.outcome]).toEqual([null, null, null]);
    expect(world.fake.calls).toHaveLength(0);
    expect(await world.store.get(CASE_ID)).toBeTruthy();
  });

  it('works without verdicts (nothing proven yet) and without a payment date', async () => {
    const view = await service.createCase({ payee_name: 'X', promised_items: [{ id: '1', title: 'Fan', qty: 1, price: '310.00' }] });
    expect(view.claim).toMatchObject({ amount: '310.00', proven_done: '0.00', paid_at: null, day_n: null });
    expect(view.promised_items[0]?.source).toEqual({ kind: 'estimate', ref: '', date: null, quote: '' });
  });

  it('makes its own case id, safe to use inside a PayPal custom_id', async () => {
    const own = new CaseService({ store: world.store, paypal: world.client, tracker: new Tracker({ store: world.store, paypal: world.client, locks: new KeyedLock() }), locks: new KeyedLock(), urls: { returnUrl: 'r', cancelUrl: 'c' } });
    const view = await own.createCase(demoInput());
    expect(view.case.id).toMatch(/^[a-f0-9]{12}$/);
  });

  it.each([
    ['no contractor name', { payee_name: ' ' }, /payee_name/],
    ['no items', { promised_items: [] }, /promised_items/],
    ['items not a list', { promised_items: 'x' }, /promised_items/],
    ['an item without a title', { promised_items: [{ id: '1', qty: 1, price: '1.00' }] }, /title/],
    ['a price that is not an amount', { promised_items: [{ id: '1', title: 'A', qty: 1, price: '$5' }] }, /price/],
    ['a price of zero', { promised_items: [{ id: '1', title: 'A', qty: 1, price: '0.00' }] }, /price/],
    ['a fractional quantity', { promised_items: [{ id: '1', title: 'A', qty: 1.5, price: '5.00' }] }, /quantity/],
    ['the same item id twice', { promised_items: [{ id: '1', title: 'A', qty: 1, price: '5.00' }, { id: '1', title: 'B', qty: 1, price: '5.00' }] }, /duplicate/],
    ['a verdict for an unknown item', { verdicts: [{ item_id: '99', status: 'done', done_units: 1, fraction: null, photo_ref: 'p', note: '' }] }, /unknown item/],
    ['an impossible verdict', { verdicts: [{ item_id: '1', status: 'done', done_units: 9, fraction: null, photo_ref: 'p', note: '' }] }, /done_units/],
    ['a verdict with a made-up status', { verdicts: [{ item_id: '1', status: 'maybe', done_units: 0, fraction: null, photo_ref: null, note: '' }] }, /status/],
    ['a bad payment date', { paid_at: '12 Sep' }, /paid_at/],
    ['a name too long for PayPal', { promised_items: [{ id: '1', title: 'x'.repeat(130), qty: 1, price: '5.00' }], verdicts: [] }, /127/],
  ])('rejects %s', async (_label, over, message) => {
    const err = await failure(service.createCase(demoInput(over)));
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(err.message).toMatch(message);
    expect(await world.store.list()).toHaveLength(0);
  });

  it('rejects a body that is not an object', async () => {
    expect(await failure(service.createCase(null))).toMatchObject({ status: 400 });
    expect(await failure(service.createCase('x'))).toMatchObject({ status: 400 });
  });
});

describe('payment', () => {
  it('creates the PayPal order from the promised items and remembers it', async () => {
    await service.createCase(demoInput());
    const started = await service.startPayment(CASE_ID);
    expect(started).toEqual({ order_id: ORDER_ID, approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` });
    const body = JSON.parse(posts()[0]!.body);
    expect(body.purchase_units[0].custom_id).toBe(`MIR-${CASE_ID}`);
    expect(body.purchase_units[0].items).toHaveLength(6);
    expect(body.purchase_units[0].amount.value).toBe('4200.00');
    expect(body.payment_source.paypal.experience_context.return_url).toBe('http://localhost:8787/paypal/return');
    const view = await service.getCase(CASE_ID);
    expect(view.case.payment).toMatchObject({ order_id: ORDER_ID, status: 'created', capture_id: null });
  });

  it('gives the same order back when asked twice', async () => {
    await service.createCase(demoInput());
    const first = await service.startPayment(CASE_ID);
    const second = await service.startPayment(CASE_ID);
    expect(second).toEqual(first);
    expect(posts()).toHaveLength(1);
  });

  it('captures after the homeowner approved, and records the capture', async () => {
    await service.createCase(demoInput({ paid_at: undefined }));
    await service.startPayment(CASE_ID);
    const view = await service.capture(CASE_ID);
    expect(view.case.payment).toEqual({
      order_id: ORDER_ID, approve_url: expect.any(String), status: 'captured', capture_id: CAPTURE_ID,
      captured_at: '2026-10-31T18:19:08Z', method: 'PayPal Goods & Services',
    });
    expect(view.case.paid_at).toBe('2026-10-31'); // from the capture, because none was given
    expect(view.claim).toMatchObject({ transaction_id: CAPTURE_ID, method: 'PayPal Goods & Services', paid_at: '2026-10-31', day_n: 1 });
  });

  it('keeps the payment date it was given', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    expect((await service.capture(CASE_ID)).case.paid_at).toBe('2026-09-12');
  });

  it('does not capture twice', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    await service.capture(CASE_ID);
    const callsBefore = posts().length;
    const again = await service.capture(CASE_ID);
    expect(again.case.payment?.status).toBe('captured');
    expect(posts()).toHaveLength(callsBefore);
    expect(await failure(service.startPayment(CASE_ID))).toMatchObject({ status: 409, code: 'ALREADY_PAID' });
  });

  it('says so when there is no payment to capture', async () => {
    await service.createCase(demoInput());
    expect(await failure(service.capture(CASE_ID))).toMatchObject({ status: 409, code: 'NO_PAYMENT' });
  });

  it('says so when the homeowner has not approved yet, and stays unpaid', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    world.approved = false;
    const err = await failure(service.capture(CASE_ID));
    expect(err).toMatchObject({ status: 409, code: 'ORDER_NOT_APPROVED' });
    expect(err.message).toMatch(/approved the payment/);
    expect((await service.getCase(CASE_ID)).case.payment?.status).toBe('created');
    world.approved = true;
    expect((await service.capture(CASE_ID)).case.payment?.status).toBe('captured');
  });

  it('does not call a payment paid while PayPal has not completed it', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    const pending = fixture('order-captured');
    pending.purchase_units[0].payments.captures[0].status = 'PENDING';
    world.fake.setRoute((c) => (c.path.endsWith('/capture') ? { status: 201, body: pending } : undefined));
    expect(await failure(service.capture(CASE_ID))).toMatchObject({ status: 409, code: 'PAYMENT_NOT_COMPLETED' });
    expect((await service.getCase(CASE_ID)).case.payment?.status).toBe('created');
  });

  it('knows nothing about a case that does not exist', async () => {
    for (const run of [() => service.startPayment('nope'), () => service.capture('nope'), () => service.getCase('nope'), () => service.getDispute('nope')]) {
      expect(await failure(run())).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });
});

describe('reading the claim', () => {
  it('reads a case without asking PayPal', async () => {
    await service.createCase(demoInput());
    await service.getCase(CASE_ID);
    expect(world.fake.calls).toHaveLength(0);
  });

  it('looks once at PayPal for the claim; nothing yet before it is filed', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    await service.capture(CASE_ID);
    world.fake.calls.length = 0;
    expect(await service.getDispute(CASE_ID)).toEqual({ dispute: null, offer: null, outcome: null });
    expect(world.disputeCalls().filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('does not look at all for a case that has not been paid', async () => {
    await service.createCase(demoInput());
    expect(await service.getDispute(CASE_ID)).toEqual({ dispute: null, offer: null, outcome: null });
    expect(world.fake.calls).toHaveLength(0);
  });

  it('shows the claim, the offer and the outcome once PayPal has them, and links the filing page to the homeowner\'s transaction', async () => {
    await withClaim('dispute-a-open');
    world.dispute = ours('dispute-a-offer-accepted');
    const result = await service.getDispute(CASE_ID);
    expect(result.dispute).toMatchObject({ id: DISPUTE_ID, dispute_amount: '300.00', original_claim_amount: '400.00' });
    expect(result.offer).toMatchObject({ amount: '300.00', status: 'accepted' });
    expect(result.outcome).toMatchObject({ status: 'money_back', amount_refunded: '300.00' });
    const view = await service.getCase(CASE_ID);
    expect(view.filing).toEqual({
      filing_url: 'https://www.sandbox.paypal.com/resolutioncenter/filing/27S431280V029084G',
      proof: [],
      filed_at: '2026-10-31T18:25:35.592Z',
    });
    expect(view.claim.transaction_id).toBe('27S431280V029084G');
    expect(view.claim.amount).toBe('3150.00'); // our claim does not move with PayPal's rewrite
  });

  it('turns PayPal being down into a 502', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    await service.capture(CASE_ID);
    world.fake.setRoute(() => ({ status: 503, body: { name: 'SERVICE_UNAVAILABLE', message: 'later' } }));
    expect(await failure(service.getDispute(CASE_ID))).toMatchObject({ status: 502, code: 'PAYPAL_UNAVAILABLE' });
  });
});

describe('sandbox helpers: escalate and ask PayPal to decide', () => {
  it('needs a claim first', async () => {
    await service.createCase(demoInput());
    await service.startPayment(CASE_ID);
    await service.capture(CASE_ID);
    expect(await failure(service.escalate(CASE_ID))).toMatchObject({ status: 409, code: 'NO_CLAIM_YET' });
    expect(await failure(service.adjudicate(CASE_ID, 'BUYER_FAVOR'))).toMatchObject({ status: 409, code: 'NO_CLAIM_YET' });
    expect(await failure(service.contractorOffer(CASE_ID, { amount: '1.00' }))).toMatchObject({ status: 409, code: 'NO_CLAIM_YET' });
    expect(await failure(service.contractorAcceptClaim(CASE_ID))).toMatchObject({ status: 409, code: 'NO_CLAIM_YET' });
    expect(posts()).toHaveLength(2); // only the order and its capture
  });

  it('escalates from the contractor\'s side and says it is a sandbox helper', async () => {
    await withClaim();
    world.postAnswer = () => {
      world.dispute = ours('dispute-b-escalated');
      return undefined;
    };
    const result = await service.escalate(CASE_ID);
    expect(result).toMatchObject({
      sandbox_only: true,
      action: 'escalate',
      note: "In the app the main button opens PayPal's Resolution Center so the homeowner escalates; this helper exists for the sandbox demo",
      dispute: { id: DISPUTE_ID, life_cycle_stage: 'CHARGEBACK', escalated_at: '2026-10-31T18:33:55.518Z' },
    });
    const call = posts()[0]!;
    expect(call.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/escalate`);
  });

  it('asks PayPal to decide in the homeowner\'s favour, sandbox only', async () => {
    await withClaim('dispute-b-adjudicatable');
    const result = await service.adjudicate(CASE_ID, 'BUYER_FAVOR');
    expect(result).toMatchObject({ sandbox_only: true, action: 'adjudicate', adjudication: 'BUYER_FAVOR' });
    expect(JSON.parse(posts()[0]!.body)).toEqual({ adjudication_outcome: 'BUYER_FAVOR' });
  });

  it('answers 409 with the reason when PayPal has not opened the decision step yet', async () => {
    await withClaim();
    world.postAnswer = () => ({ status: 400, body: fixture('error-adjudicate-not-allowed') });
    const err = await failure(service.adjudicate(CASE_ID, 'BUYER_FAVOR'));
    expect(err).toMatchObject({ status: 409, code: 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE', message: 'PayPal opens this step after a review delay' });
  });

  it('refuses an outcome that is neither side', async () => {
    await withClaim();
    expect(await failure(service.adjudicate(CASE_ID, 'SPLIT'))).toMatchObject({ status: 400 });
    expect(posts()).toHaveLength(0);
  });

  it('passes on PayPal\'s other refusals as 502 with its words', async () => {
    await withClaim();
    world.postAnswer = () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'The dispute is closed.', details: [{ issue: 'DISPUTE_ALREADY_CLOSED' }] } });
    const err = await failure(service.escalate(CASE_ID));
    expect(err).toMatchObject({ status: 502, code: 'PAYPAL_REFUSED' });
    expect(err.message).toContain('DISPUTE_ALREADY_CLOSED');
  });
});

describe('sandbox contractor', () => {
  it('offers a refund up to the claim and shows the offer', async () => {
    await withClaim();
    world.postAnswer = () => {
      world.dispute = fixture('dispute-a-offer-pending');
      return undefined;
    };
    const result = await service.contractorOffer(CASE_ID, { amount: '300.00' });
    expect(result).toMatchObject({ sandbox_only: true, action: 'make-offer', amount: '300.00', offer: { amount: '300.00', status: 'pending' } });
    expect(JSON.parse(posts()[0]!.body)).toMatchObject({ offer_type: 'REFUND', offer_amount: { value: '300.00' } });
  });

  it('refuses an offer that is not an amount, is zero, or is above the claim', async () => {
    await withClaim();
    for (const amount of ['abc', '0.00', '400.01', '', undefined, 300]) {
      expect(await failure(service.contractorOffer(CASE_ID, { amount: amount as never })), String(amount)).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
    expect(posts()).toHaveLength(0);
    await service.contractorOffer(CASE_ID, { amount: '400.00' }); // the whole claim is fine
    expect(posts()).toHaveLength(1);
  });

  it('accepts the claim', async () => {
    await withClaim();
    const result = await service.contractorAcceptClaim(CASE_ID);
    expect(result).toMatchObject({ sandbox_only: true, action: 'accept-claim' });
    expect(posts()[0]!.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/accept-claim`);
  });

  it('still answers when the look at PayPal after the action fails, and logs it', async () => {
    await withClaim();
    world.postAnswer = () => {
      world.fake.setRoute((c) => (c.method === 'GET' ? { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } } : { body: fixture('action-accepted') }));
      return undefined;
    };
    const result = await service.contractorAcceptClaim(CASE_ID);
    expect(result).toMatchObject({ sandbox_only: true, action: 'accept-claim', dispute: { id: DISPUTE_ID } });
    expect(logged.join('\n')).toMatch(/refresh after accept-claim failed/);
  });
});
