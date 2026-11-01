// PayPal's Customer Disputes API, read from the contractor's (seller's) side.
// What each field means here was recorded in the 31 Oct 2026 sandbox spike; see docs/paypal-notes.md.
import type { Dispute, Offer, OfferStatus, Outcome } from '../model.js';
import { fromCents, toCents } from '../money.js';
import { PayPalError, type PayPalClient } from './client.js';

export const REFUND_DESTINATION = 'the payment method you used';
const NOT_YET_ALLOWED = 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE';
const DISPUTE_ID = /^[A-Za-z0-9-]+$/;

interface RawMoney {
  currency_code?: string;
  value: string;
}

/** The parts of a PayPal dispute answer that we read. Everything else is ignored. */
export interface RawDispute {
  dispute_id?: string;
  create_time?: string;
  update_time?: string;
  status?: string;
  dispute_life_cycle_stage?: string;
  dispute_amount?: RawMoney;
  dispute_outcome?: { outcome_code?: string; outcome_reason?: string; amount_refunded?: RawMoney };
  disputed_transactions?: Array<{ buyer_transaction_id?: string; seller_transaction_id?: string; custom?: string }>;
  evidences?: Array<{ date?: string; action_info?: { action?: string } }>;
  messages?: Array<{ posted_by?: string; time_posted?: string; content?: string }>;
  money_movements?: Array<{ affected_party?: string; type?: string; reason?: string; amount: RawMoney; initiated_time?: string }>;
  offer?: { history?: Array<{ offer_time: string; actor?: string; event_type?: string; offer_amount?: RawMoney }> };
}

export interface DisputeListItem {
  dispute_id: string;
  create_time?: string;
  status?: string;
}

const money = (m: RawMoney | undefined): string | null => (m?.value ? fromCents(toCents(m.value)) : null);

function checkId(id: string): string {
  if (!DISPUTE_ID.test(id)) throw new Error(`not a dispute id: "${id}"`);
  return id;
}

// ---------------------------------------------------------------- reading

/** PayPal lists a dispute minutes after it exists, so an empty list means "not yet", not "no claim". */
export async function listDisputes(client: PayPalClient, filter: { disputed_transaction_id: string; page_size?: number }): Promise<DisputeListItem[]> {
  const response = await client.request<{ items?: DisputeListItem[] }>('GET', '/v1/customer/disputes', {
    query: { disputed_transaction_id: filter.disputed_transaction_id, page_size: String(filter.page_size ?? 20) },
  });
  return response.items ?? [];
}

export async function getDispute(client: PayPalClient, id: string): Promise<RawDispute> {
  return client.request<RawDispute>('GET', `/v1/customer/disputes/${checkId(id)}`);
}

/** The list does not carry the seller's transaction id or the custom_id, so a dispute is checked on its own answer. */
export function belongsToCase(raw: RawDispute, ids: { capture_id: string; custom_id: string }): boolean {
  return (raw.disputed_transactions ?? []).some((t) => t.seller_transaction_id === ids.capture_id || t.custom === ids.custom_id);
}

/** The id the homeowner sees in their own PayPal activity. It is not the capture id. */
export function buyerTransactionId(raw: RawDispute, ids: { capture_id: string; custom_id: string }): string | null {
  const tx = (raw.disputed_transactions ?? []).find((t) => t.seller_transaction_id === ids.capture_id || t.custom === ids.custom_id);
  return tx?.buyer_transaction_id ?? null;
}

// ---------------------------------------------------------------- mapping

const hasAcceptedOffer = (raw: RawDispute) => (raw.offer?.history ?? []).some((e) => e.event_type === 'ACCEPTED');

export interface MapContext {
  /** What we stored on the last look */
  previous: Dispute | null;
  /** The claim amount we prepared; used only if the first look comes after PayPal rewrote the amount */
  claim_amount: string;
}

/**
 * - The claim amount we keep is the first one we saw: PayPal rewrites `dispute_amount` once an offer is accepted.
 * - The escalation time is the escalate action PayPal records when the contractor's side escalates. When the homeowner
 *   escalates on the site PayPal leaves no marker, so it is the moment we first see the chargeback stage. It never moves.
 */
export function mapDispute(raw: RawDispute, context: MapContext): Dispute {
  const amount = money(raw.dispute_amount);
  if (!raw.dispute_id || !raw.create_time || !raw.status || !raw.dispute_life_cycle_stage || !amount) throw new Error('PayPal sent a dispute without id, time, status, stage or amount');
  const action = raw.evidences?.find((e) => e.action_info?.action === 'ESCALATE')?.date;
  const chargebackSeen = raw.dispute_life_cycle_stage === 'CHARGEBACK' && raw.status !== 'RESOLVED' ? (raw.update_time ?? null) : null;
  return {
    id: raw.dispute_id,
    status: raw.status,
    life_cycle_stage: raw.dispute_life_cycle_stage,
    opened_at: raw.create_time,
    escalated_at: context.previous?.escalated_at ?? action ?? chargebackSeen,
    dispute_amount: amount,
    original_claim_amount: context.previous?.original_claim_amount ?? (hasAcceptedOffer(raw) ? context.claim_amount : amount),
  };
}

const DECLINED = new Set(['DENIED', 'DECLINED', 'REJECTED']);
const CANCELED = new Set(['CANCELED', 'CANCELLED']);

/** The newest proposal, and what happened to it. Events we do not know leave it pending. */
export function mapOffer(raw: RawDispute): Offer | null {
  const history = raw.offer?.history ?? [];
  const at = history.map((e) => e.event_type).lastIndexOf('PROPOSED');
  const proposal = history[at];
  const amount = money(proposal?.offer_amount);
  if (!proposal || !amount) return null;

  let status: OfferStatus = 'pending';
  for (const event of history.slice(at + 1)) {
    if (event.event_type === 'ACCEPTED') status = 'accepted';
    else if (event.event_type && DECLINED.has(event.event_type)) status = 'declined';
    else if (event.event_type && CANCELED.has(event.event_type)) status = 'canceled';
  }
  // Going to PayPal cancels open offers (PayPal's escalate dialog says so); a closed case has none open either.
  if (status === 'pending' && (raw.dispute_life_cycle_stage === 'CHARGEBACK' || raw.status === 'RESOLVED')) status = 'canceled';

  const note = raw.messages?.find((m) => m.posted_by === 'SELLER' && m.time_posted === proposal.offer_time)?.content ?? null;
  return { amount, type: 'REFUND', note, received_at: proposal.offer_time, status };
}

/**
 * Money to the homeowner is read from PayPal's money movements (the buyer's credits), so it shows as soon as PayPal moves it,
 * before the case is closed. Fees charged to the contractor are not part of it.
 */
export function mapOutcome(raw: RawDispute): Outcome | null {
  const credits = (raw.money_movements ?? [])
    .filter((m) => m.affected_party === 'BUYER' && m.type === 'CREDIT')
    .sort((a, b) => (a.initiated_time ?? '').localeCompare(b.initiated_time ?? ''));
  const decision = raw.dispute_outcome;
  if (!decision && credits.length === 0) return null;

  const refunded = money(decision?.amount_refunded) ?? fromCents(credits.reduce((sum, c) => sum + toCents(c.amount.value), 0));
  const code = decision?.outcome_code ?? null;
  const status = code === null || code === 'RESOLVED_BUYER_FAVOUR' ? 'money_back' : code === 'RESOLVED_SELLER_FAVOUR' ? 'denied' : 'closed';
  return {
    status,
    amount_refunded: refunded,
    refund_destination: REFUND_DESTINATION,
    decided_at: credits[0]?.initiated_time ?? raw.update_time ?? null,
    outcome_code: code,
    outcome_reason: decision?.outcome_reason ?? null,
  };
}

// ---------------------------------------------------------------- actions of the contractor's side

type Answer = Record<string, unknown>;

function amountOf(value: string): { currency_code: 'USD'; value: string } {
  const cents = toCents(value);
  if (cents < 1) throw new Error('amount must be more than zero');
  return { currency_code: 'USD', value: fromCents(cents) };
}

/** PayPal allows only REFUND for a service not received. */
export async function makeOffer(client: PayPalClient, id: string, offer: { amount: string; note: string }): Promise<Answer> {
  const offer_amount = amountOf(offer.amount);
  return client.request('POST', `/v1/customer/disputes/${checkId(id)}/make-offer`, { json: { note: offer.note, offer_type: 'REFUND', offer_amount } });
}

export async function acceptClaim(client: PayPalClient, id: string, accept: { note: string }): Promise<Answer> {
  return client.request('POST', `/v1/customer/disputes/${checkId(id)}/accept-claim`, { multipart: { input: { note: accept.note, accept_claim_type: 'REFUND' } } });
}

export async function escalate(client: PayPalClient, id: string, escalation: { note: string }): Promise<Answer> {
  return client.request('POST', `/v1/customer/disputes/${checkId(id)}/escalate`, { json: { note: escalation.note } });
}

/** Sandbox only: asks PayPal to decide. PayPal opens this step some time after the contractor's response. */
export async function adjudicate(client: PayPalClient, id: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR'): Promise<Answer> {
  if (outcome !== 'BUYER_FAVOR' && outcome !== 'SELLER_FAVOR') throw new Error(`unknown adjudication outcome: ${String(outcome)}`);
  return client.request('POST', `/v1/customer/disputes/${checkId(id)}/adjudicate`, { json: { adjudication_outcome: outcome } });
}

export async function provideEvidence(client: PayPalClient, id: string, evidence: { note: string }): Promise<Answer> {
  return client.request('POST', `/v1/customer/disputes/${checkId(id)}/provide-evidence`, {
    multipart: { input: { evidences: [{ evidence_type: 'OTHER', notes: evidence.note }] } },
  });
}

/** PayPal's answer while it has not opened a step yet (adjudicate comes about 28 minutes after the contractor responds). */
export function isActionNotYetAllowed(error: unknown): boolean {
  return error instanceof PayPalError && error.issue === NOT_YET_ALLOWED;
}
