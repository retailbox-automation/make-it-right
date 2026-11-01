// The contractor, played by our sandbox Business account, so the demo can show an offer or a refund without a real contractor.
// Nothing here works against anything but the sandbox; every answer says so.
import type { PayPalClient } from '../paypal/client.js';
import { acceptClaim, makeOffer, provideEvidence } from '../paypal/disputes.js';

export interface SimResult {
  sandbox_only: true;
  action: 'make-offer' | 'accept-claim' | 'provide-evidence';
  dispute_id: string;
  amount?: string;
}

export async function contractorMakesOffer(paypal: PayPalClient, disputeId: string, offer: { amount: string; note?: string }): Promise<SimResult> {
  await makeOffer(paypal, disputeId, { amount: offer.amount, note: offer.note ?? `We can refund $${offer.amount} for the work we did not finish.` });
  return { sandbox_only: true, action: 'make-offer', dispute_id: disputeId, amount: offer.amount };
}

export async function contractorAcceptsClaim(paypal: PayPalClient, disputeId: string, accept: { note?: string }): Promise<SimResult> {
  await acceptClaim(paypal, disputeId, { note: accept.note ?? 'We accept the claim and refund it in full.' });
  return { sandbox_only: true, action: 'accept-claim', dispute_id: disputeId };
}

export async function contractorProvidesEvidence(paypal: PayPalClient, disputeId: string, evidence: { note: string }): Promise<SimResult> {
  await provideEvidence(paypal, disputeId, { note: evidence.note });
  return { sandbox_only: true, action: 'provide-evidence', dispute_id: disputeId };
}
