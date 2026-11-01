// Reads the body of POST /api/cases. Anything wrong is a 400 that says what.
import { invalid } from './errors.js';
import type { PromisedItem, Source, SourceKind, Verdict, VerdictStatus } from './model.js';
import { computeClaim, fromCents, toCents } from './money.js';

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

export function parseCaseInput(body: unknown): CaseInput {
  if (!isObject(body)) throw invalid('the request body must be a JSON object');
  if (!text(body.payee_name)) throw invalid('payee_name is required');
  const promised_items = parseItems(body.promised_items);
  const verdicts = parseVerdicts(body.verdicts, promised_items);

  let paid_at: string | null = null;
  if (body.paid_at !== undefined && body.paid_at !== null) {
    if (typeof body.paid_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.paid_at) || Number.isNaN(Date.parse(`${body.paid_at}T00:00:00Z`))) {
      throw invalid('paid_at must be a date like 2026-09-12');
    }
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
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isObject(raw)) throw invalid(`promised_items[${index}] must be an object`);
    const id = raw.id === undefined ? String(index + 1) : raw.id;
    if (!text(id)) throw invalid(`promised_items[${index}]: id must be a non-empty string`);
    if (seen.has(id)) throw invalid(`duplicate item id "${id}"`);
    seen.add(id);
    if (!text(raw.title)) throw invalid(`item ${id}: title is required`);
    if (typeof raw.qty !== 'number' || !Number.isInteger(raw.qty) || raw.qty < 1) throw invalid(`item ${id}: quantity must be a whole number, 1 or more`);
    if (typeof raw.price !== 'string') throw invalid(`item ${id}: price must be an amount like "720.00"`);
    let cents: number;
    try {
      cents = toCents(raw.price);
    } catch {
      throw invalid(`item ${id}: price must be an amount like "720.00"`);
    }
    if (cents < 1) throw invalid(`item ${id}: price must be more than zero`);
    return { id, title: raw.title.trim(), qty: raw.qty, price: fromCents(cents), source: parseSource(raw.source, id) };
  });
}

function parseSource(value: unknown, itemId: string): Source {
  if (value === undefined) return { ...EMPTY_SOURCE };
  if (!isObject(value) || !SOURCE_KINDS.includes(value.kind as SourceKind)) throw invalid(`item ${itemId}: source.kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const date = value.date ?? null;
  if (date !== null && typeof date !== 'string') throw invalid(`item ${itemId}: source.date must be a date string or null`);
  return { kind: value.kind as SourceKind, ref: typeof value.ref === 'string' ? value.ref : '', date, quote: typeof value.quote === 'string' ? value.quote : '' };
}

function parseVerdicts(value: unknown, items: PromisedItem[]): Verdict[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('verdicts must be a list');
  const ids = new Set(items.map((i) => i.id));
  return value.map((raw, index) => {
    if (!isObject(raw)) throw invalid(`verdicts[${index}] must be an object`);
    if (typeof raw.item_id !== 'string' || !ids.has(raw.item_id)) throw invalid(`verdicts[${index}]: unknown item "${String(raw.item_id)}"`);
    if (!VERDICT_STATUSES.includes(raw.status as VerdictStatus)) throw invalid(`verdict for item ${raw.item_id}: status must be one of ${VERDICT_STATUSES.join(', ')}`);
    if (typeof raw.done_units !== 'number' || !Number.isInteger(raw.done_units) || raw.done_units < 0) throw invalid(`verdict for item ${raw.item_id}: done_units must be a whole number, 0 or more`);
    return {
      item_id: raw.item_id,
      status: raw.status as VerdictStatus,
      done_units: raw.done_units,
      fraction: typeof raw.fraction === 'string' ? raw.fraction : null,
      photo_ref: typeof raw.photo_ref === 'string' ? raw.photo_ref : null,
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  });
}
