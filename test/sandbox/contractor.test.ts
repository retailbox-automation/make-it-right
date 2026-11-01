import { describe, expect, it } from 'vitest';
import { PayPalClient } from '../../src/paypal/client.js';
import { contractorAcceptsClaim, contractorMakesOffer, contractorProvidesEvidence } from '../../src/sandbox/contractor.js';
import { fakePayPal, fixture } from '../helpers/fake-paypal.js';

const ID = 'PP-R-HAX-10195521';

function setup(owned = [ID]) {
  const fake = fakePayPal(() => ({ body: fixture('action-accepted') }));
  const paypal = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetch: fake.fetch, owns: { order: () => false, dispute: (d) => owned.includes(d) } });
  return { fake, paypal };
}

describe('the sandbox contractor', () => {
  it('offers a refund, and says it is a sandbox stand-in', async () => {
    const { fake, paypal } = setup();
    const result = await contractorMakesOffer(paypal, ID, { amount: '1200.00' });
    expect(result).toEqual({ sandbox_only: true, action: 'make-offer', dispute_id: ID, amount: '1200.00' });
    const call = fake.calls[0]!;
    expect(call.path).toBe(`/v1/customer/disputes/${ID}/make-offer`);
    expect(JSON.parse(call.body)).toMatchObject({ offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '1200.00' } });
    expect(JSON.parse(call.body).note).toContain('1200.00');
  });

  it('uses the contractor\'s own words for the offer when given', async () => {
    const { fake, paypal } = setup();
    await contractorMakesOffer(paypal, ID, { amount: '500.00', note: 'Half now, we will finish the rest.' });
    expect(JSON.parse(fake.calls[0]!.body).note).toBe('Half now, we will finish the rest.');
  });

  it('accepts the claim in full', async () => {
    const { fake, paypal } = setup();
    expect(await contractorAcceptsClaim(paypal, ID, {})).toEqual({ sandbox_only: true, action: 'accept-claim', dispute_id: ID });
    expect(fake.calls[0]!.path).toBe(`/v1/customer/disputes/${ID}/accept-claim`);
    expect(fake.calls[0]!.body).toContain('"accept_claim_type":"REFUND"');
  });

  it('answers PayPal with evidence and a note', async () => {
    const { fake, paypal } = setup();
    expect(await contractorProvidesEvidence(paypal, ID, { note: 'Work log for the panel upgrade.' })).toEqual({ sandbox_only: true, action: 'provide-evidence', dispute_id: ID });
    expect(fake.calls[0]!.body).toContain('Work log for the panel upgrade.');
  });

  it('cannot act on a dispute that is not in our store', async () => {
    const { fake, paypal } = setup([]);
    await expect(contractorMakesOffer(paypal, ID, { amount: '1.00' })).rejects.toThrow(/does not belong/);
    await expect(contractorAcceptsClaim(paypal, ID, {})).rejects.toThrow(/does not belong/);
    await expect(contractorProvidesEvidence(paypal, ID, { note: 'x' })).rejects.toThrow(/does not belong/);
    expect(fake.calls).toHaveLength(0);
  });
});
