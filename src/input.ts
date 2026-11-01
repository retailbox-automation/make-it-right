// Reads the body of POST /api/cases. Anything wrong is a 400 that says what.
import { invalid } from './errors.js';
import type { PromisedItem, Source, SourceKind, Verdict, VerdictStatus } from './model.js';
import { computeClaim, fromCents } from './money.js';

/** Limits that keep one request small and every amount exact (price x quantity stays below 2^53 cents) */
export const LIMITS = { maxItems: 50, maxVerdicts: 50, maxString: 500, maxId: 64, maxDigits: 10, maxQty: 1000 } as const;
const AMOUNT = new RegExp(`^\\d{1,${LIMITS.maxDigits}}(\\.\\d{1,2})?$`);

export interface CaseInput {
  payee_name: string;
  promised_items: PromisedItem[];
  verdicts: Verdict[];
  paid_at: string | null;
}

const SOURCE_KINDS: SourceKind[] = ['estimate', 'text', 'photo'];
const VERDICT_STATUSES: VerdictStatus[] = ['done', 'partial', 'not_done', 'unclear'];
const EMPTY_SOURCE: Source = { kind: 'estimate', ref: '', date: null, quote: '' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A string field within the length limit; `max` is 500 unless the field has a smaller one */
export function short(value: string, label: string, max: number = LIMITS.maxString): string {
  if (value.length > max) throw invalid(`${label} is longer than ${max} characters`);
  return value;
}

/** A USD amount like "720.00" in cents: at most 10 digits before the decimal point, at most two after */
export function parseAmount(value: unknown, label: string): number {
  const bad = () => invalid(`${label} must be an amount like "720.00", with at most ${LIMITS.maxDigits} digits before the decimal point`);
  if (typeof value !== 'string' || !AMOUNT.test(value)) throw bad();
  const [whole = '0', fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw bad();
  return cents;
}

/** A note the caller may leave out; when given it must be 1 to 500 characters of text */
export function parseNote(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.maxString) throw invalid(`note must be text of 1 to ${LIMITS.maxString} characters`);
  return value;
}

/** YYYY-MM-DD that is a real calendar day: it must survive a round trip through a date */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function parseCaseInput(body: unknown): CaseInput {
  if (!isObject(body)) throw invalid('the request body must be a JSON object');
  if (!text(body.payee_name)) throw invalid('payee_name is required');
  short(body.payee_name, 'payee_name');
  const promised_items = parseItems(body.promised_items);
  const verdicts = parseVerdicts(body.verdicts, promised_items);

  let paid_at: string | null = null;
  if (body.paid_at !== undefined && body.paid_at !== null) {
    if (!isCalendarDay(body.paid_at)) throw invalid('paid_at must be a date like 2026-09-12');
    paid_at = body.paid_at;
  }

  try {
    computeClaim(promised_items, verdicts, { payee_name: body.payee_name }); // rejects verdicts that cannot be
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'the verdicts do not fit the items');
  }
  return { payee_name: body.payee_name.trim(), promised_items, verdicts, paid_at };
}

function parseItems(value: unknown): PromisedItem[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid('promised_items must be a non-empty list');
  if (value.length > LIMITS.maxItems) throw invalid(`promised_items has at most ${LIMITS.maxItems} items`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isObject(raw)) throw invalid(`promised_items[${index}] must be an object`);
    const id = raw.id === undefined ? String(index + 1) : raw.id;
    if (!text(id)) throw invalid(`promised_items[${index}]: id must be a non-empty string`);
    short(id, `promised_items[${index}]: id`, LIMITS.maxId);
    if (seen.has(id)) throw invalid(`duplicate item id "${id}"`);
    seen.add(id);
    if (!text(raw.title)) throw invalid(`item ${id}: title is required`);
    short(raw.title, `item ${id}: title`);
    if (typeof raw.qty !== 'number' || !Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > LIMITS.maxQty) {
      throw invalid(`item ${id}: quantity must be a whole number from 1 to ${LIMITS.maxQty}`);
    }
    const cents = parseAmount(raw.price, `item ${id}: price`);
    if (cents < 1) throw invalid(`item ${id}: price must be more than zero`);
    return { id, title: raw.title.trim(), qty: raw.qty, price: fromCents(cents), source: parseSource(raw.source, id) };
  });
}

function parseSource(value: unknown, itemId: string): Source {
  if (value === undefined) return { ...EMPTY_SOURCE };
  if (!isObject(value) || !SOURCE_KINDS.includes(value.kind as SourceKind)) throw invalid(`item ${itemId}: source.kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const date = value.date ?? null;
  if (date !== null && typeof date !== 'string') throw invalid(`item ${itemId}: source.date must be a date string or null`);
  const ref = typeof value.ref === 'string' ? value.ref : '';
  const quote = typeof value.quote === 'string' ? value.quote : '';
  short(ref, `item ${itemId}: source.ref`);
  short(quote, `item ${itemId}: source.quote`);
  if (date !== null) short(date, `item ${itemId}: source.date`);
  return { kind: value.kind as SourceKind, ref, date, quote };
}

function parseVerdicts(value: unknown, items: PromisedItem[]): Verdict[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('verdicts must be a list');
  if (value.length > LIMITS.maxVerdicts) throw invalid(`verdicts has at most ${LIMITS.maxVerdicts} entries`);
  const ids = new Set(items.map((i) => i.id));
  return value.map((raw, index) => {
    if (!isObject(raw)) throw invalid(`verdicts[${index}] must be an object`);
    if (typeof raw.item_id !== 'string' || !ids.has(raw.item_id)) throw invalid(`verdicts[${index}]: unknown item "${String(raw.item_id)}"`);
    if (!VERDICT_STATUSES.includes(raw.status as VerdictStatus)) throw invalid(`verdict for item ${raw.item_id}: status must be one of ${VERDICT_STATUSES.join(', ')}`);
    if (typeof raw.done_units !== 'number' || !Number.isInteger(raw.done_units) || raw.done_units < 0) throw invalid(`verdict for item ${raw.item_id}: done_units must be a whole number, 0 or more`);
    const label = `verdict for item ${raw.item_id}`;
    const fraction = typeof raw.fraction === 'string' ? short(raw.fraction, `${label}: fraction`) : null;
    const photo_ref = typeof raw.photo_ref === 'string' ? short(raw.photo_ref, `${label}: photo_ref`) : null;
    const note = typeof raw.note === 'string' ? short(raw.note, `${label}: note`) : '';
    return { item_id: raw.item_id, status: raw.status as VerdictStatus, done_units: raw.done_units, fraction, photo_ref, note };
  });
}
