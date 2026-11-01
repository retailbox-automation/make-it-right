// Verdicts for the promised items: done / partial / not_done / unclear, decided only by the job-site photos.
import type { PromisedItem, Verdict, VerdictStatus } from '../model.js';
import { ModelError, type VisionModel } from '../models/vision.js';
import type { TextMessage } from './extract.js';

export interface Photo {
  /** "photo-1".."photo-N", in the order the homeowner added them */
  id: string;
  image: Buffer;
}

export interface Judgement {
  verdicts: Verdict[];
  warnings: string[];
  ms: number;
  calls: number;
}

const STATUSES: readonly VerdictStatus[] = ['done', 'partial', 'not_done', 'unclear'];

/** The verdict rule (plan.md §1), in the words the model reads. */
export const VERDICT_RULE = [
  'Decide each promised item only from what the photos show:',
  '- done: a photo shows this item finished (for an item with qty > 1: all of its units finished).',
  '- partial: only for an item with qty > 1, when a photo shows some of its units finished and you can count them; done_units = how many units you can see finished (fewer than qty).',
  '- not_done: a photo shows the place for this item without it, or the item started but not finished. An item with qty 1 that is started but not finished is not_done, never partial.',
  '- unclear: no photo shows this item.',
  'Photos of work that is not on the punch list are ignored.',
  "The contractor's words are never proof; only the photos count.",
].join('\n');

export const JUDGE_SYSTEM =
  "You check a contractor's job-site photos against the punch list of promised items the homeowner paid for. " +
  'Answer only with JSON that matches the schema.';

function itemList(items: PromisedItem[]): string {
  return items.map((i) => `- id ${i.id}: ${i.title} (qty ${i.qty})`).join('\n');
}

// ---------- shared: one verdict that keeps the rule ----------

function photoRefFrom(raw: unknown, photos: Photo[]): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim().toLowerCase().replace(/\.(png|jpe?g)$/, '').replace(/\s+/g, '-');
  if (!s) return null;
  const exact = photos.find((p) => p.id.toLowerCase() === s);
  if (exact) return exact.id;
  const n = /(\d+)/.exec(s)?.[1];
  return photos.find((p) => p.id === `photo-${n}`)?.id ?? null;
}

/** Turns a proposed status into a verdict that obeys the rule; every correction is a warning. */
export function settleVerdict(
  item: PromisedItem,
  proposed: { status: unknown; done_units?: unknown; photo_ref: string | null; note?: unknown },
  warnings: string[],
): Verdict {
  const note = typeof proposed.note === 'string' ? proposed.note.trim() : '';
  let status: VerdictStatus;
  if (STATUSES.includes(proposed.status as VerdictStatus)) status = proposed.status as VerdictStatus;
  else {
    warnings.push(`item ${item.id}: status ${JSON.stringify(proposed.status)} unknown; unclear`);
    status = 'unclear';
  }
  let photo_ref = proposed.photo_ref;
  if (status !== 'unclear' && !photo_ref) {
    warnings.push(`item ${item.id}: ${status} without a photo; unclear`);
    status = 'unclear';
  }
  let units = 0;
  if (status === 'partial') {
    const u = proposed.done_units;
    if (item.qty < 2) {
      warnings.push(`item ${item.id}: partial on an item that cannot be split; not_done`);
      status = 'not_done';
    } else if (!Number.isInteger(u)) {
      warnings.push(`item ${item.id}: partial without a count of finished units; not_done`);
      status = 'not_done';
    } else if ((u as number) >= item.qty) {
      warnings.push(`item ${item.id}: partial with ${u} of ${item.qty} units; done`);
      status = 'done';
    } else if ((u as number) <= 0) {
      warnings.push(`item ${item.id}: partial with ${u} finished units; not_done`);
      status = 'not_done';
    } else units = u as number;
  }
  if (status === 'done') units = item.qty;
  if (status === 'unclear') photo_ref = null;
  return {
    item_id: item.id,
    status,
    done_units: units,
    fraction: status === 'partial' ? `${units}/${item.qty}` : null,
    photo_ref,
    note,
  };
}

function unclear(item: PromisedItem, note: string): Verdict {
  return { item_id: item.id, status: 'unclear', done_units: 0, fraction: null, photo_ref: null, note };
}

// ---------- whole job: one call with all photos ----------

export const WHOLE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          photo_ref: { type: 'string' },
          note: { type: 'string' },
          status: { type: 'string', enum: [...STATUSES] },
          done_units: { type: 'integer' },
        },
        required: ['item_id', 'photo_ref', 'note', 'status', 'done_units'],
      },
    },
  },
  required: ['verdicts'],
} as const;

export function wholePrompt(items: PromisedItem[], photos: Photo[]): string {
  return [
    'Punch list (promised items):',
    itemList(items),
    '',
    `${photos.length} job-site photos are attached, in this order: ${photos.map((p) => p.id).join(', ')}.`,
    '',
    VERDICT_RULE,
    '',
    'Give exactly one verdict for every promised item:',
    '- item_id: the id from the punch list;',
    `- photo_ref: the photo that shows your verdict (for example "${photos[0]?.id ?? 'photo-1'}"); "" when unclear;`,
    '- note: one short sentence on what that photo shows about this item;',
    '- status: done, partial, not_done or unclear;',
    '- done_units: qty for done, the counted finished units for partial, 0 for not_done and unclear.',
  ].join('\n');
}

export async function judgeWhole(model: VisionModel, items: PromisedItem[], photos: Photo[]): Promise<Judgement> {
  const warnings: string[] = [];
  if (!items.length) return { verdicts: [], warnings, ms: 0, calls: 0 };
  if (!photos.length) return { verdicts: items.map((i) => unclear(i, 'no photos')), warnings: ['no photos to check'], ms: 0, calls: 0 };
  const { value, ms } = await model.json<unknown>({
    system: JUDGE_SYSTEM,
    prompt: wholePrompt(items, photos),
    images: photos.map((p) => p.image),
    schema: WHOLE_SCHEMA,
    maxTokens: 4096,
  });
  const list = (value as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) throw new ModelError('invalid_output', 'judge answer has no "verdicts" array', JSON.stringify(value));
  const byId = new Map<string, Verdict>();
  for (const raw of list as Array<Record<string, unknown>>) {
    const id = raw && (typeof raw.item_id === 'string' || typeof raw.item_id === 'number') ? String(raw.item_id).trim() : '';
    const item = items.find((i) => i.id === id);
    if (!item) {
      warnings.push(`verdict for unknown item ${JSON.stringify(raw?.item_id)} ignored`);
      continue;
    }
    if (byId.has(id)) {
      warnings.push(`second verdict for item ${id} ignored`);
      continue;
    }
    const ref = photoRefFrom(raw.photo_ref, photos);
    if (raw.photo_ref && !ref) warnings.push(`item ${id}: photo ${JSON.stringify(raw.photo_ref)} is not one of the photos`);
    byId.set(id, settleVerdict(item, { status: raw.status, done_units: raw.done_units, photo_ref: ref, note: raw.note }, warnings));
  }
  const verdicts = items.map((i) => {
    const v = byId.get(i.id);
    if (v) return v;
    warnings.push(`no verdict for item ${i.id}; unclear`);
    return unclear(i, 'no verdict returned');
  });
  return { verdicts, warnings, ms, calls: 1 };
}

// ---------- one call per photo, combined in code ----------

export const PHOTO_SCHEMA = {
  type: 'object',
  properties: {
    shows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          note: { type: 'string' },
          state: { type: 'string', enum: ['finished', 'not_finished'] },
          finished_units: { type: 'integer' },
        },
        required: ['item_id', 'note', 'state', 'finished_units'],
      },
    },
  },
  required: ['shows'],
} as const;

export function photoPrompt(items: PromisedItem[], photo: Photo): string {
  return [
    'Punch list (promised items):',
    itemList(items),
    '',
    `One job-site photo is attached: ${photo.id}.`,
    '',
    'List the promised items this photo shows, each once:',
    '- item_id: the id from the punch list;',
    '- note: one short sentence on what the photo shows about this item;',
    '- state: "finished" when the item is finished in this photo (for qty > 1: at least one unit finished); "not_finished" when the photo shows the place for this item without it, or the item started but not finished;',
    '- finished_units: how many units of this item you can see finished in this photo (1 for a finished item with qty 1; 0 when not_finished).',
    'Leave out items the photo does not show; answer with an empty list when it shows none of them.',
    'Work in the photo that is not on the punch list is ignored.',
    "The contractor's words are never proof; only the photo counts.",
  ].join('\n');
}

interface Seen {
  photo: string;
  finished: boolean;
  units: number;
  note: string;
}

/**
 * Per-photo observations → one verdict per item:
 * the largest finished count seen in one photo decides (≥ qty → done, 0 < count < qty → partial);
 * only not-finished photos → not_done; no photo → unclear. photo_ref is the photo that decided it.
 */
export function combineSeen(item: PromisedItem, seen: Seen[]): Verdict {
  if (!seen.length) return unclear(item, 'no photo shows this item');
  let best: Seen | undefined;
  for (const s of seen) if (s.finished && s.units > 0 && (!best || s.units > best.units)) best = s;
  if (best) {
    const units = Math.min(best.units, item.qty);
    if (units >= item.qty) return { item_id: item.id, status: 'done', done_units: item.qty, fraction: null, photo_ref: best.photo, note: best.note };
    return { item_id: item.id, status: 'partial', done_units: units, fraction: `${units}/${item.qty}`, photo_ref: best.photo, note: best.note };
  }
  const first = seen.find((s) => !s.finished) ?? seen[0]!;
  return { item_id: item.id, status: 'not_done', done_units: 0, fraction: null, photo_ref: first.photo, note: first.note };
}

export async function judgePerPhoto(model: VisionModel, items: PromisedItem[], photos: Photo[]): Promise<Judgement> {
  const warnings: string[] = [];
  if (!items.length) return { verdicts: [], warnings, ms: 0, calls: 0 };
  if (!photos.length) return { verdicts: items.map((i) => unclear(i, 'no photos')), warnings: ['no photos to check'], ms: 0, calls: 0 };
  const seen = new Map<string, Seen[]>(items.map((i) => [i.id, []]));
  let ms = 0;
  for (const photo of photos) {
    const answer = await model.json<unknown>({
      system: JUDGE_SYSTEM,
      prompt: photoPrompt(items, photo),
      images: [photo.image],
      schema: PHOTO_SCHEMA,
      maxTokens: 2048,
    });
    ms += answer.ms;
    const list = (answer.value as { shows?: unknown } | null)?.shows;
    if (!Array.isArray(list)) throw new ModelError('invalid_output', `${photo.id}: answer has no "shows" array`, answer.raw);
    const here = new Set<string>();
    for (const raw of list as Array<Record<string, unknown>>) {
      const id = raw && (typeof raw.item_id === 'string' || typeof raw.item_id === 'number') ? String(raw.item_id).trim() : '';
      const item = items.find((i) => i.id === id);
      if (!item) {
        warnings.push(`${photo.id}: unknown item ${JSON.stringify(raw?.item_id)} ignored`);
        continue;
      }
      if (here.has(id)) {
        warnings.push(`${photo.id}: item ${id} listed twice; second ignored`);
        continue;
      }
      here.add(id);
      if (raw.state !== 'finished' && raw.state !== 'not_finished') {
        warnings.push(`${photo.id}: item ${id} state ${JSON.stringify(raw.state)} unknown; ignored`);
        continue;
      }
      const finished = raw.state === 'finished';
      let units = 0;
      if (finished) {
        if (item.qty === 1) units = 1;
        else if (Number.isInteger(raw.finished_units) && (raw.finished_units as number) >= 0) units = raw.finished_units as number;
        else warnings.push(`${photo.id}: item ${id} finished_units ${JSON.stringify(raw.finished_units)} is not a count; 0`);
        if (units > item.qty) {
          warnings.push(`${photo.id}: item ${id} ${units} finished units of ${item.qty}; ${item.qty}`);
          units = item.qty;
        }
      }
      seen.get(id)!.push({ photo: photo.id, finished, units, note: typeof raw.note === 'string' ? raw.note.trim() : '' });
    }
  }
  return { verdicts: items.map((i) => combineSeen(i, seen.get(i.id)!)), warnings, ms, calls: photos.length };
}

// ---------- lower bounds without a model ----------

/** What a homeowner files without checking: everything not done. */
export function judgeA0(items: PromisedItem[]): Judgement {
  return {
    verdicts: items.map((i) => ({ item_id: i.id, status: 'not_done', done_units: 0, fraction: null, photo_ref: null, note: 'not checked against the photos' })),
    warnings: [],
    ms: 0,
    calls: 0,
  };
}

const STOP = new Set(['and', 'the', 'with', 'for', 'new', 'over', 'into', 'onto', 'from', 'all', 'our', 'your', 'are', 'was', 'too', 'per', 'each', 'one', 'two']);

/** Lowercase words of a title, 3+ letters, no filler words, plural "s" dropped: for string matching only. */
export function titleWords(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

const ALL_DONE = /\b(all|everything)\b[^.!?\n]*\b(done|finished|complete|completed)\b|\beverything'?s (done|finished|complete)\b|\bjob(?:'s| is) (done|finished|complete)\b/i;
const DONE_WORD = /\b(done|finished|installed|complete|completed|are in|is in)\b/i;

/**
 * Believe the contractor's texts (string match): a blanket "all done" makes every item done; otherwise an item is done
 * when one clause of a contractor text has a done word and a word of the item's title. The rest is not_done.
 */
export function judgeTrustTexts(items: PromisedItem[], texts: TextMessage[], contractor: string): Judgement {
  const who = contractor.trim().toLowerCase();
  const theirs = texts.filter((t) => t.from.trim().toLowerCase() === who);
  const allDone = theirs.some((t) => ALL_DONE.test(t.text));
  const doneWords = new Set<string>();
  for (const t of theirs) for (const clause of t.text.split(/[.!?;,\n]+/)) if (DONE_WORD.test(clause)) for (const w of titleWords(clause)) doneWords.add(w);
  const verdicts: Verdict[] = items.map((i) => {
    const said = allDone || [...titleWords(i.title)].some((w) => doneWords.has(w));
    return said
      ? { item_id: i.id, status: 'done', done_units: i.qty, fraction: null, photo_ref: null, note: "the contractor's text calls it done" }
      : { item_id: i.id, status: 'not_done', done_units: 0, fraction: null, photo_ref: null, note: "the contractor's texts do not call it done" };
  });
  return { verdicts, warnings: [], ms: 0, calls: 0 };
}
