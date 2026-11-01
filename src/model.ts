// The app's data model. Field names follow design/screens/README.md ("How to wire them").
// Amounts are decimal strings in USD with two digits ("720.00"); arithmetic happens in integer cents (src/money.ts).

export type SourceKind = 'estimate' | 'text' | 'photo';

/** Where a promise was found: the estimate page, a text message, or a photo caption. */
export interface Source {
  kind: SourceKind;
  /** "estimate p.1", "text Sep 9", "photo 3" */
  ref: string;
  /** ISO date (YYYY-MM-DD) of the document or message, when known */
  date: string | null;
  /** The promise in the contractor's own words */
  quote: string;
}

/** One line of the punch list: what the contractor promised and was paid for. */
export interface PromisedItem {
  /** Stable within a case: "1".."n" */
  id: string;
  title: string;
  /** Units promised; 1 for work that cannot be split */
  qty: number;
  price: string;
  source: Source;
}

/**
 * done      — a photo shows the item finished
 * partial   — only for qty > 1: a photo shows some units finished (done_units of qty)
 * not_done  — a photo shows the place without the item, or the item started but not finished
 * unclear   — no photo shows this item; it stays in the claim and the homeowner is asked for a photo
 */
export type VerdictStatus = 'done' | 'partial' | 'not_done' | 'unclear';

export interface Verdict {
  item_id: string;
  status: VerdictStatus;
  /** 0..qty. done → qty; not_done and unclear → 0 */
  done_units: number;
  /** "4/6" for partial, otherwise null */
  fraction: string | null;
  /** Id of the photo that shows the verdict; null when unclear */
  photo_ref: string | null;
  note: string;
}

export const CLAIM_REASON = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' as const;

export interface ClaimLine {
  item_id: string;
  /** What this item adds to the claim: full price, the missing share of a partial item, or 0.00 */
  claim_amount: string;
  /** What the photos prove for this item */
  proven_amount: string;
}

export interface Claim {
  /** Sum of the unfinished work */
  amount: string;
  /** paid_total − amount */
  proven_done: string;
  paid_total: string;
  /** Contractor's name as it appears on the payment */
  payee_name: string;
  reason: typeof CLAIM_REASON;
  transaction_id: string | null;
  paid_at: string | null;
  method: string | null;
  /** Day N of the 180-day window for "not received" claims */
  day_n: number | null;
  eligibility_note: string;
  lines: ClaimLine[];
}

export interface Filing {
  /** PayPal Resolution Center link for the payment */
  filing_url: string | null;
  proof: Array<{ item_id: string; files: string[] }>;
  filed_at: string | null;
}

export interface Dispute {
  id: string;
  status: string;
  life_cycle_stage: string;
  opened_at: string;
  escalated_at: string | null;
  /** As PayPal reports it now (PayPal rewrites it after an accepted offer) */
  dispute_amount: string;
  /** The amount filed, kept on our side */
  original_claim_amount: string;
}

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'canceled';

export interface Offer {
  amount: string;
  type: 'REFUND';
  note: string | null;
  received_at: string;
  status: OfferStatus;
}

export interface Outcome {
  /** money_back | denied | closed */
  status: string;
  amount_refunded: string;
  /** "the payment method you used" unless PayPal names it */
  refund_destination: string;
  decided_at: string | null;
  outcome_code: string | null;
  outcome_reason: string | null;
}

/** The payment for one case: a PayPal order made from the promised items, and its capture. */
export interface PaymentRecord {
  order_id: string;
  /** Where the homeowner approves the payment */
  approve_url: string;
  /** created = waiting for the homeowner's approval; captured = the money moved */
  status: 'created' | 'captured';
  /** The contractor's transaction id; the homeowner sees a different one */
  capture_id: string | null;
  /** ISO time of the capture */
  captured_at: string | null;
  method: string | null;
}

/** Everything the app keeps for one case. The claim is computed from the items and verdicts every time it is read. */
export interface CaseRecord {
  id: string;
  created_at: string;
  payee_name: string;
  promised_items: PromisedItem[];
  verdicts: Verdict[];
  /** YYYY-MM-DD; filled from the capture time when it was not given */
  paid_at: string | null;
  payment: PaymentRecord | null;
  /** The homeowner's own transaction id; known once PayPal lists their claim */
  buyer_transaction_id: string | null;
  dispute: Dispute | null;
  offer: Offer | null;
  outcome: Outcome | null;
}
