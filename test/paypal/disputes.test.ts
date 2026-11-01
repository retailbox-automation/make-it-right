import { describe, expect, it } from 'vitest';
import type { Dispute } from '../../src/model.js';
import { PayPalClient, PayPalError } from '../../src/paypal/client.js';
import {
  REFUND_DESTINATION,
  acceptClaim,
  adjudicate,
  belongsToCase,
  buyerTransactionId,
  escalate,
  getDispute,
  isActionNotYetAllowed,
  listDisputes,
  makeOffer,
  mapDispute,
  mapOffer,
  mapOutcome,
  provideEvidence,
} from '../../src/paypal/disputes.js';
import { fakePayPal, fixture, type Route } from '../helpers/fake-paypal.js';

// Case A of the spike: capture 9UA851170T503222E, custom_id MIR-B1-A, claim $400.00, offer $300.00 accepted.
const CASE_A = { capture_id: '9UA851170T503222E', custom_id: 'MIR-B1-A' };
const ctx = (previous: Dispute | null = null) => ({ previous, claim_amount: '400.00' });

describe('mapDispute', () => {
  it('maps a claim that was just filed', () => {
    expect(mapDispute(fixture('dispute-a-open'), ctx())).toEqual({
      id: 'PP-R-HAX-10195521',
      status: 'OPEN',
      life_cycle_stage: 'INQUIRY',
      opened_at: '2026-10-31T18:25:35.592Z',
      escalated_at: null,
      dispute_amount: '400.00',
      original_claim_amount: '400.00',
    });
  });

  it('keeps the original claim amount after PayPal rewrites the amount with the accepted offer', () => {
    const open = mapDispute(fixture('dispute-a-open'), ctx());
    const accepted = mapDispute(fixture('dispute-a-offer-accepted'), ctx(open));
    expect(accepted.dispute_amount).toBe('300.00'); // as PayPal reports it now
    expect(accepted.original_claim_amount).toBe('400.00'); // what was filed
    const resolved = mapDispute(fixture('dispute-a-resolved'), ctx(accepted));
    expect(resolved).toMatchObject({ status: 'RESOLVED', dispute_amount: '300.00', original_claim_amount: '400.00' });
  });

  it('falls back to our own claim amount when the first sighting is already after the rewrite', () => {
    const late = mapDispute(fixture('dispute-a-resolved'), ctx());
    expect(late.dispute_amount).toBe('300.00');
    expect(late.original_claim_amount).toBe('400.00');
  });

  it('does not move the original amount when the same answer is mapped again', () => {
    const once = mapDispute(fixture('dispute-a-offer-pending'), ctx());
    expect(mapDispute(fixture('dispute-a-offer-pending'), ctx(once))).toEqual(once);
  });

  it('takes the escalation time from the escalate action PayPal records (seller side)', () => {
    const d = mapDispute(fixture('dispute-b-escalated'), ctx());
    expect(d).toMatchObject({ life_cycle_stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE', escalated_at: '2026-10-31T18:33:55.518Z' });
  });

  it('uses the time the chargeback stage is first seen when the buyer escalated on the site (no marker in the answer)', () => {
    const d = mapDispute(fixture('dispute-c-escalated'), ctx());
    expect(d.escalated_at).toBe('2026-10-31T19:32:44.003Z');
  });

  it('never moves an escalation time once it was recorded', () => {
    const first = mapDispute(fixture('dispute-c-escalated'), ctx());
    const later = mapDispute(fixture('dispute-b-under-review'), ctx({ ...first, id: 'PP-R-GWA-10195522' }));
    expect(later.escalated_at).toBe('2026-10-31T19:32:44.003Z');
  });

  it('leaves the escalation time empty when a chargeback is first seen already resolved (nothing tells when)', () => {
    const d = mapDispute(fixture('dispute-c-resolved'), ctx());
    expect(d).toMatchObject({ life_cycle_stage: 'CHARGEBACK', status: 'RESOLVED', escalated_at: null });
  });

  it('has no escalation time before the chargeback stage', () => {
    expect(mapDispute(fixture('dispute-b-waiting-for-seller'), ctx()).escalated_at).toBeNull();
  });
});

describe('mapOffer', () => {
  it('has no offer until the contractor makes one', () => {
    expect(mapOffer(fixture('dispute-a-open'))).toBeNull();
    expect(mapOffer(fixture('dispute-a-waiting-for-seller'))).toBeNull();
    expect(mapOffer(fixture('dispute-b-escalated'))).toBeNull();
  });

  it('reads a pending offer: amount, the note the contractor sent, and when it arrived', () => {
    expect(mapOffer(fixture('dispute-a-offer-pending'))).toEqual({
      amount: '300.00',
      type: 'REFUND',
      note: 'Contractor offer (sandbox spike): refund $300.00 instead of the claimed amount.',
      received_at: '2026-10-31T18:30:35.489Z',
      status: 'pending',
    });
  });

  it('reads an accepted offer', () => {
    expect(mapOffer(fixture('dispute-a-offer-accepted'))).toMatchObject({ amount: '300.00', status: 'accepted' });
    expect(mapOffer(fixture('dispute-a-resolved'))).toMatchObject({ amount: '300.00', status: 'accepted' });
  });

  const withHistory = (...events: Array<Record<string, unknown>>) => {
    const raw = fixture('dispute-a-offer-pending');
    raw.offer.history.push(...events);
    return raw;
  };
  const buyer = (event_type: string, offer_time = '2026-10-31T18:31:00.000Z') => ({ offer_time, actor: 'BUYER', event_type });

  it.each([
    ['DENIED', 'declined'],
    ['DECLINED', 'declined'],
    ['CANCELED', 'canceled'],
    ['CANCELLED', 'canceled'],
  ])('maps the event %s to %s', (event, status) => {
    expect(mapOffer(withHistory(buyer(event)))?.status).toBe(status);
  });

  it('ignores events it does not know', () => {
    expect(mapOffer(withHistory(buyer('SOMETHING_NEW')))?.status).toBe('pending');
  });

  it('follows the newest proposal after an earlier one was declined', () => {
    const raw = withHistory(buyer('DENIED'), { offer_time: '2026-10-31T18:40:00.000Z', actor: 'SELLER', event_type: 'PROPOSED', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '350.00' } });
    expect(mapOffer(raw)).toMatchObject({ amount: '350.00', status: 'pending', received_at: '2026-10-31T18:40:00.000Z', note: null });
  });

  it('calls an offer canceled when the case went to PayPal (chargeback) or was closed without it', () => {
    const escalated = fixture('dispute-a-offer-pending');
    escalated.dispute_life_cycle_stage = 'CHARGEBACK';
    expect(mapOffer(escalated)?.status).toBe('canceled');
    const closed = fixture('dispute-a-offer-pending');
    closed.status = 'RESOLVED';
    expect(mapOffer(closed)?.status).toBe('canceled');
  });
});

describe('mapOutcome', () => {
  it('has no outcome while nothing was decided or paid', () => {
    for (const name of ['dispute-a-open', 'dispute-a-offer-pending', 'dispute-b-escalated', 'dispute-c-escalated']) expect(mapOutcome(fixture(name)), name).toBeNull();
  });

  it('shows the money as soon as PayPal moves it, before the case is closed', () => {
    expect(mapOutcome(fixture('dispute-a-offer-accepted'))).toEqual({
      status: 'money_back',
      amount_refunded: '300.00',
      refund_destination: REFUND_DESTINATION,
      decided_at: '2026-10-31T18:31:24.502Z',
      outcome_code: null,
      outcome_reason: null,
    });
  });

  it('fills in PayPal\'s own outcome once the case is resolved', () => {
    expect(mapOutcome(fixture('dispute-a-resolved'))).toEqual({
      status: 'money_back',
      amount_refunded: '300.00',
      refund_destination: 'the payment method you used',
      decided_at: '2026-10-31T18:31:24.502Z',
      outcome_code: 'RESOLVED_BUYER_FAVOUR',
      outcome_reason: 'INQUIRY_OFFER_PARTIAL_REFUND',
    });
  });

  it('counts only the buyer\'s credit, not the contractor\'s fees (decision by PayPal)', () => {
    expect(mapOutcome(fixture('dispute-b-resolved'))).toMatchObject({
      status: 'money_back',
      amount_refunded: '400.00',
      decided_at: '2026-10-31T19:58:05.461Z',
      outcome_reason: 'INELIGIBLE_SELLER_PROTECTION_POLICY',
    });
  });

  it('reads the contractor accepting the claim', () => {
    expect(mapOutcome(fixture('dispute-c-resolved'))).toMatchObject({ status: 'money_back', amount_refunded: '400.00', outcome_reason: 'SELLER_ISSUED_REFUND' });
  });

  it('says "denied" with no money when PayPal decides for the contractor', () => {
    const raw = fixture('dispute-b-resolved');
    raw.dispute_outcome = { outcome_code: 'RESOLVED_SELLER_FAVOUR', outcome_reason: 'SELLER_PROVIDED_PROOF' };
    delete raw.money_movements;
    expect(mapOutcome(raw)).toEqual({
      status: 'denied',
      amount_refunded: '0.00',
      refund_destination: REFUND_DESTINATION,
      decided_at: raw.update_time,
      outcome_code: 'RESOLVED_SELLER_FAVOUR',
      outcome_reason: 'SELLER_PROVIDED_PROOF',
    });
  });

  it('calls any other closing "closed"', () => {
    const raw = fixture('dispute-b-resolved');
    raw.dispute_outcome = { outcome_code: 'CANCELED_BY_BUYER' };
    delete raw.money_movements;
    expect(mapOutcome(raw)).toMatchObject({ status: 'closed', amount_refunded: '0.00', outcome_code: 'CANCELED_BY_BUYER' });
  });
});

describe('matching a dispute to a case', () => {
  it('matches on the capture id PayPal calls seller_transaction_id', () => {
    expect(belongsToCase(fixture('dispute-a-open'), CASE_A)).toBe(true);
    expect(belongsToCase(fixture('dispute-a-open'), { capture_id: '9UA851170T503222E', custom_id: 'MIR-OTHER' })).toBe(true);
  });
  it('matches on the custom_id', () => {
    expect(belongsToCase(fixture('dispute-a-open'), { capture_id: 'SOMETHINGELSE', custom_id: 'MIR-B1-A' })).toBe(true);
  });
  it('does not match another case\'s dispute', () => {
    expect(belongsToCase(fixture('dispute-b-open'), CASE_A)).toBe(false);
    expect(belongsToCase({}, CASE_A)).toBe(false);
  });
  it('reads the buyer\'s own transaction id (it differs from the capture id)', () => {
    expect(buyerTransactionId(fixture('dispute-a-open'), CASE_A)).toBe('27S431280V029084G');
    expect(buyerTransactionId(fixture('dispute-b-open'), CASE_A)).toBeNull();
  });
});

function clientFor(route: Route, ownedDisputes: string[] = ['PP-R-HAX-10195521']) {
  const fake = fakePayPal(route);
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetch: fake.fetch, owns: { order: () => false, dispute: (d) => ownedDisputes.includes(d) } });
  return { fake, client };
}

describe('reading disputes', () => {
  it('lists the disputes for one capture', async () => {
    const { fake, client } = clientFor(() => ({ body: fixture('disputes-list-by-capture') }));
    const items = await listDisputes(client, { disputed_transaction_id: '9UA851170T503222E' });
    expect(items.map((i) => i.dispute_id)).toEqual(['PP-R-HAX-10195521']);
    expect(fake.calls[0]!.search).toBe('?disputed_transaction_id=9UA851170T503222E&page_size=20');
  });

  it('returns an empty list when PayPal has not listed the dispute yet', async () => {
    const { client } = clientFor(() => ({ body: { items: [], links: [] } }));
    expect(await listDisputes(client, { disputed_transaction_id: 'X' })).toEqual([]);
    const { client: client2 } = clientFor(() => ({ body: {} }));
    expect(await listDisputes(client2, { disputed_transaction_id: 'X' })).toEqual([]);
  });

  it('gets one dispute by its id', async () => {
    const { fake, client } = clientFor(() => ({ body: fixture('dispute-a-open') }));
    expect((await getDispute(client, 'PP-R-HAX-10195521')).dispute_id).toBe('PP-R-HAX-10195521');
    expect(fake.calls[0]!.path).toBe('/v1/customer/disputes/PP-R-HAX-10195521');
  });

  it('refuses an id that is not shaped like a dispute id', async () => {
    const { fake, client } = clientFor(() => ({ body: {} }));
    await expect(getDispute(client, '../orders/X')).rejects.toThrow(/dispute id/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('seller-side actions', () => {
  const ok: Route = () => ({ body: fixture('action-accepted') });

  it('makes a REFUND offer (the only type PayPal allows for a service not received)', async () => {
    const { fake, client } = clientFor(ok);
    await makeOffer(client, 'PP-R-HAX-10195521', { amount: '300.00', note: 'We can refund $300.00.' });
    const call = fake.calls[0]!;
    expect([call.method, call.path]).toEqual(['POST', '/v1/customer/disputes/PP-R-HAX-10195521/make-offer']);
    expect(JSON.parse(call.body)).toEqual({ note: 'We can refund $300.00.', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '300.00' } });
  });

  it('rejects a bad offer amount before calling PayPal', async () => {
    const { fake, client } = clientFor(ok);
    await expect(makeOffer(client, 'PP-R-HAX-10195521', { amount: '0.00', note: 'x' })).rejects.toThrow(/amount/);
    await expect(makeOffer(client, 'PP-R-HAX-10195521', { amount: '$3', note: 'x' })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts the claim as multipart, asking for a full REFUND', async () => {
    const { fake, client } = clientFor(ok);
    await acceptClaim(client, 'PP-R-HAX-10195521', { note: 'Contractor accepts.' });
    const call = fake.calls[0]!;
    expect(call.path).toBe('/v1/customer/disputes/PP-R-HAX-10195521/accept-claim');
    expect(call.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.body).toContain('{"note":"Contractor accepts.","accept_claim_type":"REFUND"}');
  });

  it('escalates with a note', async () => {
    const { fake, client } = clientFor(ok);
    await escalate(client, 'PP-R-HAX-10195521', { note: 'Please decide.' });
    expect(fake.calls[0]!.path).toBe('/v1/customer/disputes/PP-R-HAX-10195521/escalate');
    expect(JSON.parse(fake.calls[0]!.body)).toEqual({ note: 'Please decide.' });
  });

  it('asks PayPal to decide, for either side, and nothing else', async () => {
    const { fake, client } = clientFor(ok);
    await adjudicate(client, 'PP-R-HAX-10195521', 'BUYER_FAVOR');
    expect(JSON.parse(fake.calls[0]!.body)).toEqual({ adjudication_outcome: 'BUYER_FAVOR' });
    await adjudicate(client, 'PP-R-HAX-10195521', 'SELLER_FAVOR');
    expect(JSON.parse(fake.calls[1]!.body)).toEqual({ adjudication_outcome: 'SELLER_FAVOR' });
    await expect(adjudicate(client, 'PP-R-HAX-10195521', 'SPLIT' as never)).rejects.toThrow(/outcome/);
    expect(fake.calls).toHaveLength(2);
  });

  it('provides evidence with a note as multipart', async () => {
    const { fake, client } = clientFor(ok);
    await provideEvidence(client, 'PP-R-HAX-10195521', { note: 'Photo log attached.' });
    const call = fake.calls[0]!;
    expect(call.path).toBe('/v1/customer/disputes/PP-R-HAX-10195521/provide-evidence');
    expect(call.body).toContain('{"evidences":[{"evidence_type":"OTHER","notes":"Photo log attached."}]}');
  });

  it('every action stops at the client guard when the dispute is not one of ours', async () => {
    const { fake, client } = clientFor(ok, []);
    await expect(escalate(client, 'PP-R-HAX-10195521', { note: 'x' })).rejects.toThrow(/does not belong/);
    await expect(makeOffer(client, 'PP-R-HAX-10195521', { amount: '1.00', note: 'x' })).rejects.toThrow(/does not belong/);
    expect(fake.calls).toHaveLength(0);
  });

  it('tells "PayPal has not opened this step yet" from other refusals', async () => {
    const { client } = clientFor(() => ({ status: 400, body: fixture('error-adjudicate-not-allowed') }));
    const err = (await adjudicate(client, 'PP-R-HAX-10195521', 'BUYER_FAVOR').catch((e) => e)) as PayPalError;
    expect(isActionNotYetAllowed(err)).toBe(true);
    expect(isActionNotYetAllowed(new PayPalError({ status: 400, paypalName: 'X', issue: 'OTHER', debugId: null, message: 'm' }))).toBe(false);
    expect(isActionNotYetAllowed(new Error('boom'))).toBe(false);
  });
});
