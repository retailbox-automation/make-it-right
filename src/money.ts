// Money in integer cents. Every amount on screen comes from here, never from a model.
import { CLAIM_REASON, type Claim, type ClaimLine, type PromisedItem, type Verdict } from './model.js';

const AMOUNT = /^\d+(\.\d{1,2})?$/;

export function toCents(amount: string): number {
  if (!AMOUNT.test(amount)) throw new Error(`not a USD amount: "${amount}"`);
  const [whole, frac = ''] = amount.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`not a non-negative whole number of cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** The part of an item's price that stays in the claim. Partial items are rounded down to the cent. */
export function claimCents(item: PromisedItem, verdict: Verdict | undefined): number {
  const price = toCents(item.price);
  if (!verdict) return price; // no verdict = nothing proven
  if (!Number.isInteger(verdict.done_units) || verdict.done_units < 0 || verdict.done_units > item.qty) {
    throw new Error(`item ${item.id}: done_units ${verdict.done_units} outside 0..${item.qty}`);
  }
  switch (verdict.status) {
    case 'done':
      return 0;
    case 'partial':
      if (item.qty < 2) throw new Error(`item ${item.id}: partial needs qty > 1`);
      return Math.floor((price * (item.qty - verdict.done_units)) / item.qty);
    case 'not_done':
    case 'unclear':
      return price;
  }
}

export interface ClaimContext {
  payee_name: string;
  transaction_id?: string | null;
  paid_at?: string | null; // YYYY-MM-DD
  method?: string | null;
  today?: string; // YYYY-MM-DD, for day_n
  eligibility_note?: string;
}

const DAY_MS = 86_400_000;

export function dayN(paidAt: string | null | undefined, today: string | undefined): number | null {
  if (!paidAt || !today) return null;
  const n = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${paidAt}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Claim for exactly the unfinished work. proven_done + amount = paid_total, always. */
export function computeClaim(items: PromisedItem[], verdicts: Verdict[], ctx: ClaimContext): Claim {
  const byItem = new Map(verdicts.map((v) => [v.item_id, v]));
  const lines: ClaimLine[] = items.map((item) => {
    const claim = claimCents(item, byItem.get(item.id));
    return { item_id: item.id, claim_amount: fromCents(claim), proven_amount: fromCents(toCents(item.price) - claim) };
  });
  const paid = items.reduce((s, i) => s + toCents(i.price), 0);
  const amount = lines.reduce((s, l) => s + toCents(l.claim_amount), 0);
  return {
    amount: fromCents(amount),
    proven_done: fromCents(paid - amount),
    paid_total: fromCents(paid),
    payee_name: ctx.payee_name,
    reason: CLAIM_REASON,
    transaction_id: ctx.transaction_id ?? null,
    paid_at: ctx.paid_at ?? null,
    method: ctx.method ?? null,
    day_n: dayN(ctx.paid_at, ctx.today),
    eligibility_note: ctx.eligibility_note ?? 'May be eligible for PayPal Purchase Protection · PayPal decides',
    lines,
  };
}
