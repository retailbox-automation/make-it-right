// Promised items: what the homeowner paid for, found in the estimate and the contractor's text messages.
import type { PromisedItem, SourceKind } from '../model.js';
import { fromCents, toCents } from '../money.js';
import { ModelError, type VisionModel } from '../models/vision.js';
import { estimateText, type Estimate } from './estimate.js';

export interface PaymentInfo {
  /** YYYY-MM-DD */
  date: string;
  amount: string;
  method: string;
  /** The contractor's name on the payment */
  payee: string;
  transaction_id?: string | null;
}

export interface TextMessage {
  /** YYYY-MM-DD, null when the message has no date */
  date: string | null;
  from: string;
  text: string;
}

export interface Extraction {
  items: PromisedItem[];
  warnings: string[];
  ms: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isIsoDate(s: string): boolean {
  return ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
}

/** "$4,200.00" for prompts and warnings. */
export function usd(amount: string): string {
  const [whole = '0', frac = '00'] = fromCents(toCents(amount)).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** texts.txt: one message per row, "YYYY-MM-DD · Sender: message". Rows without that start continue the message above. */
export function parseTexts(raw: string): TextMessage[] {
  const out: TextMessage[] = [];
  for (const row of raw.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const m = /^(\d{4}-\d{2}-\d{2})\s*·\s*([^:]+?)\s*:\s*(.*)$/.exec(row);
    if (m) out.push({ date: m[1]!, from: m[2]!, text: m[3]!.trim() });
    else if (out.length) out[out.length - 1]!.text += `\n${row.trim()}`;
    else out.push({ date: null, from: '', text: row.trim() });
  }
  return out;
}

export function formatTexts(texts: TextMessage[]): string {
  return texts.map((t) => `${t.date ?? 'no date'} · ${t.from || 'unknown'}: ${t.text}`).join('\n');
}

/** A warning when the promised items do not add up to the payment; null when they do. */
export function sumWarning(items: PromisedItem[], payment: PaymentInfo | undefined): string | null {
  if (!payment) return null;
  const sum = items.reduce((s, i) => s + toCents(i.price), 0);
  const paid = toCents(payment.amount);
  if (sum === paid) return null;
  return `the promised items add up to ${usd(fromCents(sum))}, but the payment was ${usd(payment.amount)}`;
}

// ---------- A0: rules only (the measured lower bound) ----------

const ESTIMATE_ROW = /^(.*\S)\s+(\d{1,4})\s+\$(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;
const NOT_AN_ITEM = /^(sub-?total|total|tax|sales tax|deposit|balance|paid|payment|discount|amount due)\b/i;

/**
 * Rows of a PDF estimate shaped "<title> <qty> $<amount>". Text messages are ignored; an image estimate gives no items.
 */
export function extractA0(estimate: Estimate, payment?: PaymentInfo): Extraction {
  const started = performance.now();
  const warnings: string[] = [];
  const items: PromisedItem[] = [];
  if (estimate.kind === 'image') {
    warnings.push('the estimate is an image; rules read no items from it');
  } else {
    const date = estimate.rows.map((r) => /\b(\d{4}-\d{2}-\d{2})\b/.exec(r.text)?.[1]).find((d) => d && isIsoDate(d)) ?? null;
    for (const row of estimate.rows) {
      const m = ESTIMATE_ROW.exec(row.text);
      if (!m) continue;
      const title = m[1]!.trim();
      const qty = Number(m[2]);
      if (NOT_AN_ITEM.test(title) || qty < 1) continue;
      items.push({
        id: String(items.length + 1),
        title,
        qty,
        price: fromCents(toCents(m[3]!.replace(/,/g, ''))),
        source: { kind: 'estimate', ref: `estimate p.${row.page}`, date, quote: title },
      });
    }
    if (!estimate.rows.length) warnings.push('the PDF estimate has no text layer');
  }
  const w = sumWarning(items, payment);
  if (w) warnings.push(w);
  return { items, warnings, ms: Math.round(performance.now() - started) };
}

// ---------- With a model: one call ----------

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          qty: { type: 'integer' },
          price: { type: 'string' },
          source: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['estimate', 'text'] },
              ref: { type: 'string' },
              date: { type: 'string' },
              quote: { type: 'string' },
            },
            required: ['kind', 'ref', 'date', 'quote'],
          },
        },
        required: ['title', 'qty', 'price', 'source'],
      },
    },
  },
  required: ['items'],
} as const;

export const EXTRACT_SYSTEM =
  "You read a home-improvement contractor's estimate and the text messages between the contractor and the homeowner, " +
  'and you list the promised items the homeowner paid for. Answer only with JSON that matches the schema.';

export function extractPrompt(estimate: Estimate, texts: TextMessage[], payment: PaymentInfo): string {
  const est =
    estimate.kind === 'pdf'
      ? `Estimate (the text of the PDF, page by page):\n${estimateText(estimate)}`
      : 'Estimate: the attached image (a photo of the paper estimate).';
  return [
    `Payment: the homeowner paid ${usd(payment.amount)} to ${payment.payee} on ${payment.date}.`,
    '',
    'List every priced item the homeowner paid for:',
    '- every priced item in the estimate;',
    '- every item the contractor added and priced in a text message (for example "I can also do X, $500, just add it to the total");',
    '- not totals, subtotals, tax, deposits, payments, discounts or notes;',
    '- each item once.',
    'For each item:',
    '- title: a short name of the work, in the contractor\'s words;',
    '- qty: the number of units when it is stated (for example 4 outlets, 6 lights), otherwise 1;',
    '- price: the total for this item in dollars, digits with two decimals, for example "1800.00" (the full amount for the item, not a unit price);',
    '- source.kind: "estimate" or "text";',
    '- source.ref: "estimate p.<page>" for the estimate, or "text <Mon> <d>" for a text message (for example "text Sep 9");',
    '- source.date: the date of the estimate or of the text message, YYYY-MM-DD;',
    "- source.quote: the contractor's own words for this item, copied exactly.",
    '',
    est,
    '',
    'Text messages (date · sender: message):',
    texts.length ? formatTexts(texts) : '(none)',
  ].join('\n');
}

interface RawItem {
  title?: unknown;
  qty?: unknown;
  price?: unknown;
  source?: { kind?: unknown; ref?: unknown; date?: unknown; quote?: unknown };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Model answer → promised items with ids "1".."n". Items without a title or a valid price are dropped with a warning. */
export function itemsFromAnswer(value: unknown, warnings: string[]): PromisedItem[] {
  const list = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) throw new ModelError('invalid_output', 'extraction answer has no "items" array', JSON.stringify(value));
  const items: PromisedItem[] = [];
  list.forEach((entry: RawItem, n) => {
    const title = str(entry?.title);
    if (!title) {
      warnings.push(`item ${n + 1} from the model has no title; dropped`);
      return;
    }
    const rawPrice = typeof entry.price === 'number' ? String(entry.price) : str(entry.price);
    let cents: number;
    try {
      cents = toCents(rawPrice.replace(/^\$/, '').replace(/,/g, ''));
    } catch {
      warnings.push(`item "${title}": price "${rawPrice}" is not an amount; dropped`);
      return;
    }
    let qty = 1;
    if (Number.isInteger(entry.qty) && (entry.qty as number) >= 1) qty = entry.qty as number;
    else if (entry.qty !== undefined && entry.qty !== 1) warnings.push(`item "${title}": qty ${JSON.stringify(entry.qty)} is not a whole number ≥ 1; using 1`);
    const src = entry.source ?? {};
    const ref = str(src.ref);
    let kind: SourceKind;
    if (src.kind === 'estimate' || src.kind === 'text') kind = src.kind;
    else {
      kind = /^text\b/i.test(ref) ? 'text' : 'estimate';
      warnings.push(`item "${title}": source kind ${JSON.stringify(src.kind)} unknown; using ${kind}`);
    }
    const dateRaw = str(src.date);
    const date = isIsoDate(dateRaw) ? dateRaw : null;
    items.push({
      id: String(items.length + 1),
      title,
      qty,
      price: fromCents(cents),
      source: { kind, ref: sourceRef(kind, ref, date), date, quote: str(src.quote) },
    });
  });
  return items;
}

/** "estimate p.1" / "text Sep 9": built from the date when there is one, so every screen shows the same form. */
function sourceRef(kind: SourceKind, ref: string, date: string | null): string {
  if (kind === 'text') {
    if (date) return `text ${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
    return /^text [A-Z][a-z]{2} \d{1,2}$/.test(ref) ? ref : 'text';
  }
  return /^estimate p\.\d+$/.test(ref) ? ref : 'estimate p.1';
}

export async function extractWithModel(model: VisionModel, estimate: Estimate, texts: TextMessage[], payment: PaymentInfo): Promise<Extraction> {
  const warnings: string[] = [];
  if (estimate.kind === 'pdf' && !estimate.rows.length) warnings.push('the PDF estimate has no text layer');
  const { value, ms } = await model.json<unknown>({
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt(estimate, texts, payment),
    images: estimate.kind === 'image' ? [estimate.image] : undefined,
    schema: EXTRACT_SCHEMA,
    maxTokens: 4096,
  });
  const items = itemsFromAnswer(value, warnings);
  const w = sumWarning(items, payment);
  if (w) warnings.push(w);
  return { items, warnings, ms };
}
