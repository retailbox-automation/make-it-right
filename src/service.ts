// What the HTTP API does, one method per route. Everything PayPal says goes through here and comes out as a plain answer or an HttpError.
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Tracker } from './disputes/tracker.js';
import { conflict, HttpError, invalid, notFound } from './errors.js';
import { parseAmount, parseCaseInput, parseNote } from './input.js';
import type { KeyedLock } from './lock.js';
import type { CaseRecord, Claim, Dispute, Filing, Offer, Outcome, PaymentRecord, PromisedItem, Uploads, Verdict } from './model.js';
import { computeClaim, remainder, toCents } from './money.js';
import { PayPalError, RefusedRequestError, type PayPalClient } from './paypal/client.js';
import { adjudicate, escalate, isActionNotYetAllowed } from './paypal/disputes.js';
import { buildOrderBody, captureOrder, createOrder, readCapture } from './paypal/orders.js';
import { contractorAcceptsClaim, contractorMakesOffer, contractorProvidesEvidence } from './sandbox/contractor.js';
import type { Store } from './store.js';

export const RESOLUTION_CENTER_URL = 'https://www.sandbox.paypal.com/resolutioncenter';
/** How long GET .../dispute answers from memory before it looks at PayPal again */
export const DISPUTE_CACHE_MS = 15_000;
export const ESCALATE_NOTE =
  "In the app the main button opens PayPal's Resolution Center so the homeowner escalates; this helper exists for the sandbox demo";

export interface ServiceDeps {
  store: Store;
  paypal: PayPalClient;
  tracker: Tracker;
  /** The same lock the tracker uses */
  locks: KeyedLock;
  urls: { returnUrl: string; cancelUrl: string };
  now?: () => Date;
  newId?: () => string;
  log?: (message: string) => void;
  /** How long a paid case's "no claim filed yet" is remembered before PayPal is asked again; 0 (the default) = not remembered */
  noClaimMemoryMs?: number;
  /** The public demo's daily cap on steps that can refund the homeowner from the shared sandbox contractor (src/caps.ts RefundCap) */
  refunds?: RefundPlaces;
}

export interface RefundPlaces {
  /** One of the day's places, or a 429 when they are all taken */
  take(caseId: string, action: string): Promise<{ giveBack(): Promise<void> }>;
}

export interface CaseView {
  case: {
    id: string;
    created_at: string;
    payee_name: string;
    paid_at: string | null;
    /** What the homeowner said they paid; only for cases made by the photo check */
    paid_amount?: string;
    payment: PaymentRecord | null;
    /** The demo template the case was made from; its analysis is the recorded one (demo/<template>/PROVENANCE.md) */
    template?: string;
    /** The walkthrough case: it cannot be paid or changed */
    read_only?: true;
  };
  promised_items: PromisedItem[];
  verdicts: Verdict[];
  claim: Claim;
  /** Amounts that depend on PayPal's answers, computed here like every other amount */
  amounts: {
    /** The claim as filed (kept on our side when PayPal rewrites it), or the claim ready to file */
    filed_claim: string;
    /** What the contractor's offer leaves unpaid of the filed claim; null without an offer */
    offer_gap: string | null;
    /** What the contractor keeps: the payment less the refund once there is one, otherwise the work the photos prove */
    kept_by_contractor: string;
  };
  /** Short names of the promised items for the screens, by item id; the full title stays in promised_items */
  item_titles: Record<string, ItemTitle>;
  filing: Filing;
  dispute: Dispute | null;
  offer: Offer | null;
  outcome: Outcome | null;
  /** The job-site photos uploaded for the photo check, in the order they were added; absent for cases made from JSON. `id` is what verdict.photo_ref says. */
  photos?: Array<{ id: string; name: string; url: string }>;
  /** Where the estimate the photo check read can be fetched; absent for cases made from JSON */
  estimate_url?: string;
  /** What the photo check noted while reading the job; only for cases made by the photo check */
  analysis?: { warnings: string[]; text_count?: number };
}

/** What a case made from files carries besides its punch list: given by the photo check, and by the copies of the demo case */
export interface CaseFiles {
  /** The id the files were saved under (from newCaseId()), or the fixed id of the walkthrough case */
  id: string;
  uploads: Uploads;
  paid_amount: string;
  warnings: string[];
  /** How many text messages were read, when the caller knows it */
  text_count?: number;
  /** The files are those of this demo template (demo/<template>/), not in the upload store */
  template?: string;
  read_only?: boolean;
}

const readOnly = () =>
  new HttpError(403, 'READ_ONLY_CASE', 'This is the walkthrough case everyone sees; it cannot be paid or changed. Start your own copy to try the PayPal steps.');

export interface DisputeState {
  dispute: Dispute | null;
  offer: Offer | null;
  outcome: Outcome | null;
}

export type SandboxAnswer = DisputeState & { sandbox_only: true; action: string; [extra: string]: unknown };

export function caseView(record: CaseRecord, now: Date): CaseView {
  // A demo copy shares the template's files, served as they are from demo/<template>/; uploaded files are served per case.
  const files = record.template ? `/demo/${record.template}` : `/api/cases/${record.id}`;
  const claim = computeClaim(record.promised_items, record.verdicts, {
    payee_name: record.payee_name,
    transaction_id: record.buyer_transaction_id, // the homeowner's own id; our capture id means nothing to them
    paid_at: record.paid_at,
    method: record.payment?.method ?? null,
    today: now.toISOString().slice(0, 10),
  });
  return {
    case: {
      id: record.id,
      created_at: record.created_at,
      payee_name: record.payee_name,
      paid_at: record.paid_at,
      ...(record.paid_amount === undefined ? {} : { paid_amount: record.paid_amount }),
      payment: record.payment,
      ...(record.template ? { template: record.template } : {}),
      ...(record.read_only ? { read_only: true as const } : {}),
    },
    promised_items: record.promised_items,
    verdicts: record.verdicts,
    claim,
    amounts: amountsOf(record, claim),
    item_titles: Object.fromEntries(record.promised_items.map((item) => [item.id, shortTitle(item.title, item.qty)])),
    filing: {
      filing_url: record.buyer_transaction_id ? `${RESOLUTION_CENTER_URL}/filing/${record.buyer_transaction_id}` : RESOLUTION_CENTER_URL,
      proof: [],
      filed_at: record.dispute?.opened_at ?? null,
    },
    dispute: record.dispute,
    offer: record.offer,
    outcome: record.outcome,
    ...(record.uploads
      ? {
          photos: record.uploads.photos.map((name) => ({ id: name.replace(/\.[^.]+$/, ''), name, url: `${files}/photos/${name}` })),
          estimate_url: record.template ? `${files}/${record.uploads.estimate}` : `${files}/estimate`,
        }
      : {}),
    ...(record.analysis ? { analysis: record.analysis } : {}),
  };
}

export interface ItemTitle {
  /** The title up to its first comma, with the quantity when there is more than one: "Recessed LED lights (6)" */
  short: string;
  /** The same without the quantity, for lines that give a count themselves ("2 of 6 · Recessed LED lights") */
  name: string;
}

/** The model's titles are long ("Recessed LED lights, kitchen ceiling"); the screens show the part before the first comma */
export function shortTitle(title: string, qty: number): ItemTitle {
  const full = title.trim();
  const name = full.split(',')[0]!.trim() || full;
  return { name, short: name && qty > 1 ? `${name} (${qty})` : name };
}

function amountsOf(record: CaseRecord, claim: Claim): CaseView['amounts'] {
  const filed = record.dispute?.original_claim_amount ?? claim.amount;
  return {
    filed_claim: filed,
    offer_gap: record.offer ? remainder(filed, record.offer.amount) : null,
    kept_by_contractor: record.outcome ? remainder(claim.paid_total, record.outcome.amount_refunded) : claim.proven_done,
  };
}

const stateOf = (r: CaseRecord): DisputeState => ({ dispute: r.dispute, offer: r.offer, outcome: r.outcome });

/** PayPal's errors and our own guards, told as HTTP answers */
function asHttp(error: unknown): unknown {
  if (error instanceof RefusedRequestError) return new HttpError(403, 'GUARD_REFUSED', error.message);
  if (error instanceof PayPalError) {
    if (error.issue === 'ORDER_NOT_APPROVED') return conflict('ORDER_NOT_APPROVED', 'The homeowner has not approved the payment on PayPal yet');
    if (error.issue === 'INSUFFICIENT_FUNDS') return conflict('CONTRACTOR_INSUFFICIENT_FUNDS', "The contractor's PayPal balance cannot cover this refund right now");
    if (isActionNotYetAllowed(error)) return conflict('ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE', 'PayPal opens this step after a review delay');
    if (error.status === 0 || error.status >= 500) return new HttpError(502, 'PAYPAL_UNAVAILABLE', error.message);
    return new HttpError(502, 'PAYPAL_REFUSED', error.message);
  }
  return error;
}

async function viaPayPal<T>(job: Promise<T>): Promise<T> {
  try {
    return await job;
  } catch (error) {
    throw asHttp(error);
  }
}

export class CaseService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (message: string) => void;
  /** What GET .../dispute last learned about each case, for DISPUTE_CACHE_MS */
  private readonly seen = new Map<string, { at: number; state: DisputeState }>();
  /** Paid cases PayPal listed no claim for, and until when that answer stands (noClaimMemoryMs) */
  private readonly noClaimUntil = new Map<string, number>();

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomBytes(6).toString('hex'));
    this.log = deps.log ?? (() => undefined);
  }

  /** An id for a case that is not stored yet, for callers that need it before the case exists (the uploads are saved under it) */
  newCaseId(): string {
    return this.newId();
  }

  /** `saved` is given by the photo check (the id it took from newCaseId(), the files it saved under that id, and what it noted) and by the demo copies */
  async createCase(body: unknown, saved?: CaseFiles): Promise<CaseView> {
    const record = this.newRecord(body, saved);
    await this.deps.store.put(record);
    return caseView(record, this.now());
  }

  /**
   * A case with a fixed id, made from the same input at every start (the walkthrough case). A stored case with the same
   * content is left alone; anything else under that id is replaced, keeping its first creation time.
   */
  async seedCase(body: unknown, saved: CaseFiles): Promise<{ view: CaseView; changed: boolean }> {
    const fresh = this.newRecord(body, saved);
    const existing = await this.deps.store.get(saved.id);
    if (existing && isDeepStrictEqual({ ...existing, created_at: fresh.created_at }, fresh)) return { view: caseView(existing, this.now()), changed: false };
    const record = existing ? { ...fresh, created_at: existing.created_at } : fresh;
    await this.deps.store.put(record);
    this.seen.delete(record.id);
    return { view: caseView(record, this.now()), changed: true };
  }

  /** The case that recorded this PayPal order (PayPal sends the order id back as `token` when the homeowner returns) */
  async caseIdForOrder(orderId: string): Promise<string | null> {
    return (await this.deps.store.caseIdForOrder(orderId)) ?? null;
  }

  private newRecord(body: unknown, saved: CaseFiles | undefined): CaseRecord {
    const input = parseCaseInput(body);
    const id = saved?.id ?? this.newId();
    try {
      buildOrderBody({ case_id: id, payee_name: input.payee_name, promised_items: input.promised_items, return_url: this.deps.urls.returnUrl, cancel_url: this.deps.urls.cancelUrl });
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : 'PayPal could not take this punch list');
    }
    return {
      id,
      created_at: this.now().toISOString(),
      ...input,
      payment: null,
      buyer_transaction_id: null,
      dispute: null,
      offer: null,
      outcome: null,
      ...(saved
        ? {
            uploads: saved.uploads,
            paid_amount: saved.paid_amount,
            analysis: { warnings: saved.warnings, ...(saved.text_count === undefined ? {} : { text_count: saved.text_count }) },
            ...(saved.template ? { template: saved.template } : {}),
            ...(saved.read_only ? { read_only: true } : {}),
          }
        : {}),
    };
  }

  async getCase(id: string): Promise<CaseView> {
    return caseView(await this.mustGet(id), this.now());
  }

  /** Makes the PayPal order once; asking again returns the same order */
  startPayment(id: string): Promise<{ order_id: string; approve_url: string }> {
    return this.deps.locks.run(id, async () => {
      const record = await this.mustGet(id);
      if (record.read_only) throw readOnly();
      if (record.payment?.status === 'captured') throw conflict('ALREADY_PAID', 'This case is already paid');
      if (record.payment?.status === 'pending') throw conflict('PAYMENT_PENDING', 'PayPal is still completing this payment');
      if (record.payment) return { order_id: record.payment.order_id, approve_url: record.payment.approve_url };
      const created = await viaPayPal(
        createOrder(this.deps.paypal, {
          case_id: record.id, payee_name: record.payee_name, promised_items: record.promised_items,
          return_url: this.deps.urls.returnUrl, cancel_url: this.deps.urls.cancelUrl,
        }),
      );
      const payment: PaymentRecord = { order_id: created.order_id, approve_url: created.approve_url, status: 'created', capture_id: null, capture_status: null, captured_at: null, method: null };
      await this.deps.store.put({ ...record, payment });
      this.seen.delete(id);
      this.noClaimUntil.delete(id);
      return { order_id: created.order_id, approve_url: created.approve_url };
    });
  }

  /**
   * Takes the money after the homeowner approved the payment on PayPal's page. If PayPal answers with a capture that is not
   * COMPLETED (PENDING), its id is kept and later calls ask PayPal about that capture instead of capturing again.
   */
  capture(id: string): Promise<CaseView> {
    return this.deps.locks.run(id, async () => {
      const record = await this.mustGet(id);
      if (record.read_only) throw readOnly();
      const payment = record.payment;
      if (!payment) throw conflict('NO_PAYMENT', 'Start the payment first');
      if (payment.status === 'captured') return caseView(record, this.now());

      const capture = await viaPayPal(payment.capture_id ? readCapture(this.deps.paypal, payment.capture_id) : captureOrder(this.deps.paypal, payment.order_id));
      const done = capture.status === 'COMPLETED';
      const next: CaseRecord = {
        ...record,
        paid_at: done ? (record.paid_at ?? capture.captured_at.slice(0, 10)) : record.paid_at,
        payment: {
          ...payment,
          status: done ? 'captured' : 'pending',
          capture_id: capture.capture_id,
          capture_status: capture.status,
          captured_at: done ? capture.captured_at : null,
          method: done ? capture.method : null,
        },
      };
      await this.deps.store.put(next);
      this.seen.delete(id);
      this.noClaimUntil.delete(id);
      if (!done) throw conflict('PAYMENT_NOT_COMPLETED', `PayPal has not completed the payment (status ${capture.status})`);
      return caseView(next, this.now());
    });
  }

  /** One look at PayPal, then what we know about the claim */
  async getDispute(id: string): Promise<DisputeState> {
    const hit = this.seen.get(id);
    if (hit && this.now().getTime() - hit.at < DISPUTE_CACHE_MS) return hit.state;
    return stateOf(await this.tick(id));
  }

  async escalate(id: string): Promise<SandboxAnswer> {
    const record = await this.withClaim(id);
    await viaPayPal(escalate(this.deps.paypal, record.dispute!.id, { note: 'Escalating to PayPal for a decision (sandbox demo).' }));
    return { sandbox_only: true, action: 'escalate', note: ESCALATE_NOTE, ...stateOf(await this.refresh(id, 'escalate')) };
  }

  async adjudicate(id: string, outcome: unknown): Promise<SandboxAnswer> {
    if (outcome !== 'BUYER_FAVOR' && outcome !== 'SELLER_FAVOR') throw invalid('outcome must be BUYER_FAVOR or SELLER_FAVOR');
    const record = await this.withClaim(id);
    if (record.dispute!.life_cycle_stage === 'CHARGEBACK' && record.dispute!.status === 'WAITING_FOR_SELLER_RESPONSE') {
      throw conflict('CONTRACTOR_MUST_ANSWER_FIRST', 'The contractor has to answer PayPal first');
    }
    const decide = () => adjudicate(this.deps.paypal, record.dispute!.id, outcome);
    // Only a decision for the homeowner moves money out of the contractor's balance
    await (outcome === 'BUYER_FAVOR' ? this.refundStep(id, 'adjudicate', decide) : viaPayPal(decide()));
    return { sandbox_only: true, action: 'adjudicate', adjudication: outcome, ...stateOf(await this.refresh(id, 'adjudicate')) };
  }

  async contractorOffer(id: string, body: { amount?: unknown }): Promise<SandboxAnswer> {
    const cents = parseAmount(body?.amount, 'amount');
    if (cents < 1) throw invalid('amount must be more than zero');
    const record = await this.withClaim(id);
    if (cents > toCents(record.dispute!.original_claim_amount)) throw invalid(`amount cannot be more than the claim ($${record.dispute!.original_claim_amount})`);
    // The homeowner accepts an offer on PayPal's own site, which the app never sees, so the offer itself takes the refund place
    const sim = await this.refundStep(id, 'offer', () => contractorMakesOffer(this.deps.paypal, record.dispute!.id, { amount: body.amount as string }));
    return { ...sim, ...stateOf(await this.refresh(id, sim.action)) };
  }

  async contractorAcceptClaim(id: string): Promise<SandboxAnswer> {
    const record = await this.withClaim(id);
    const sim = await this.refundStep(id, 'accept-claim', () => contractorAcceptsClaim(this.deps.paypal, record.dispute!.id, {}));
    return { ...sim, ...stateOf(await this.refresh(id, sim.action)) };
  }

  /** Sandbox only: the contractor answers PayPal. After an escalation PayPal opens its own decision only after this. */
  async contractorEvidence(id: string, body: { note?: unknown }): Promise<SandboxAnswer> {
    const note = parseNote(body?.note, 'The contractor sends the work log and photos of the finished items.');
    const record = await this.withClaim(id);
    const sim = await viaPayPal(contractorProvidesEvidence(this.deps.paypal, record.dispute!.id, { note }));
    return { ...sim, ...stateOf(await this.refresh(id, sim.action)) };
  }

  /** True when steps that can refund the homeowner are capped (the public demo needs this) */
  get capsRefunds(): boolean {
    return this.deps.refunds !== undefined;
  }

  /**
   * A PayPal step that can refund the homeowner from the shared sandbox contractor's balance. With a cap, it takes one of
   * the day's places first: callers reach this only after the claim was read, so a failed look-up never takes a place.
   * PayPal refusing the step gives the place back; PayPal not answering keeps it, since PayPal may have acted.
   */
  private async refundStep<T>(id: string, action: string, run: () => Promise<T>): Promise<T> {
    const place = this.deps.refunds ? await this.deps.refunds.take(id, action) : null;
    try {
      return await viaPayPal(run());
    } catch (error) {
      if (place && !(error instanceof HttpError && error.code === 'PAYPAL_UNAVAILABLE')) {
        await place.giveBack().catch((giveBackError) => this.log(`could not give back a refund place: ${giveBackError instanceof Error ? giveBackError.message : String(giveBackError)}`));
      }
      throw error;
    }
  }

  private async mustGet(id: string): Promise<CaseRecord> {
    const record = await this.deps.store.get(id);
    if (!record) throw notFound(`case ${id}`);
    return record;
  }

  private async tick(id: string): Promise<CaseRecord> {
    const memoryMs = this.deps.noClaimMemoryMs ?? 0;
    const at = this.now().getTime();
    const until = this.noClaimUntil.get(id);
    if (until !== undefined && at < until) {
      const stored = await this.mustGet(id);
      if (!stored.dispute) return stored;
    }
    const record = await viaPayPal(this.deps.tracker.tick(id));
    this.remember(record);
    for (const [key, end] of this.noClaimUntil) if (end <= at) this.noClaimUntil.delete(key);
    if (memoryMs > 0 && !record.dispute && record.payment?.status === 'captured') this.noClaimUntil.set(id, at + memoryMs);
    else this.noClaimUntil.delete(id);
    return record;
  }

  private remember(record: CaseRecord): void {
    const at = this.now().getTime();
    for (const [key, entry] of this.seen) if (at - entry.at >= DISPUTE_CACHE_MS) this.seen.delete(key);
    this.seen.set(record.id, { at, state: stateOf(record) });
  }

  /** The case after a fresh look; the action is then known to PayPal, so a failed look must not hide that it happened */
  private async refresh(id: string, action: string): Promise<CaseRecord> {
    try {
      const record = await this.deps.tracker.tick(id);
      this.remember(record);
      return record;
    } catch (error) {
      this.log(`refresh after ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.mustGet(id);
    }
  }

  private async withClaim(id: string): Promise<CaseRecord> {
    if ((await this.mustGet(id)).read_only) throw readOnly();
    const record = await this.tick(id);
    if (!record.dispute) throw conflict('NO_CLAIM_YET', 'The claim has not been filed on PayPal yet, or PayPal has not listed it yet');
    return record;
  }
}
