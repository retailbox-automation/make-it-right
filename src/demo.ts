// The demo case, Ridgeway Electric. Its photo check was run with Gemma 4 31B on our own machine and recorded
// (demo/ridgeway/PROVENANCE.md); the hosted demo has no model and replays that answer. Every amount is still computed
// by the app from the promised items and the verdicts (src/money.ts); the amounts in the recorded file are never read.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTexts } from './core/extract.js';
import { HttpError } from './errors.js';
import { parseAmount, parseCaseInput, type CaseInput } from './input.js';
import { fromCents } from './money.js';
import type { CaseFiles, CaseService, CaseView } from './service.js';
import { PHOTO_NAME } from './uploads.js';

export const DEMO_TEMPLATE = 'ridgeway';
export const DEMO_DIR = fileURLToPath(new URL(`../demo/${DEMO_TEMPLATE}/`, import.meta.url));
/** The fixed id of the read-only walkthrough case everyone sees */
export const WALKTHROUGH_ID = 'demo-ridgeway';
/** What the contractor stand-in offers on a demo case: below the claim, so the homeowner has a real choice */
export const DEMO_OFFER_AMOUNT = '1200.00';
const ESTIMATE = 'estimate.pdf';

export interface DemoTemplate {
  name: string;
  /** The walkthrough's input: the payee and the payment date come from payment.json */
  input: CaseInput;
  /** Everything a case made from these files carries besides its id */
  files: Omit<CaseFiles, 'id' | 'read_only'>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : []);

/**
 * The case input the recorded answer gives: `extraction.items` are the promised items, `judge_e2e.verdicts` the verdicts,
 * and the payee and payment date come from payment.json. Checked like any case sent to POST /api/cases.
 */
export function demoInput(recorded: unknown, payment: unknown): CaseInput {
  if (!isObject(recorded) || !isObject(recorded.extraction) || !isObject(recorded.judge_e2e)) throw new Error('the recorded analysis has no extraction or judge_e2e part');
  if (!isObject(payment)) throw new Error('payment.json is not a JSON object');
  try {
    return parseCaseInput({
      payee_name: payment.payee,
      paid_at: payment.date,
      promised_items: recorded.extraction.items,
      verdicts: recorded.judge_e2e.verdicts,
    });
  } catch (error) {
    throw new Error(`the recorded analysis is not a usable case: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What the model noted while reading and judging the job, in the recorded answer */
export function demoWarnings(recorded: unknown): string[] {
  if (!isObject(recorded)) return [];
  const part = (key: string) => (isObject(recorded[key]) ? strings((recorded[key] as Record<string, unknown>).warnings) : []);
  return [...part('extraction'), ...part('judge_e2e')];
}

/** Reads the demo files once at start. Anything missing or inconsistent stops the start: the screens would show a broken case. */
export function loadDemo(dir: string = DEMO_DIR, name: string = DEMO_TEMPLATE): DemoTemplate {
  const where = (file: string) => `demo/${name}/${file}`;
  const json = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      throw new Error(`${where(file)} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const recorded = json('recorded-analysis.json');
  const payment = json('payment.json');
  let input: CaseInput;
  try {
    input = demoInput(recorded, payment);
  } catch (error) {
    throw new Error(`${where('recorded-analysis.json')}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(join(dir, ESTIMATE))) throw new Error(`${where(ESTIMATE)} is missing`);

  const photos = readdirSync(join(dir, 'photos'))
    .filter((file) => PHOTO_NAME.test(file))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  const ids = new Set(photos.map((file) => file.replace(/\.[^.]+$/, '')));
  for (const verdict of input.verdicts) {
    if (verdict.photo_ref !== null && !ids.has(verdict.photo_ref)) throw new Error(`${where('recorded-analysis.json')}: item ${verdict.item_id} names photo "${verdict.photo_ref}", which is not in ${where('photos/')}`);
  }

  const amount = isObject(payment) ? payment.amount : undefined;
  let paid_amount: string;
  try {
    paid_amount = fromCents(parseAmount(amount, 'amount'));
  } catch {
    throw new Error(`${where('payment.json')}: amount must look like "3700.00"`);
  }
  const text_count = parseTexts(readFileSync(join(dir, 'texts.txt'), 'utf8')).length;

  return {
    name,
    input,
    files: { uploads: { estimate: ESTIMATE, photos }, paid_amount, warnings: demoWarnings(recorded), text_count, template: name },
  };
}

/** The walkthrough case under its fixed id: made again at every start, left alone when nothing changed */
export function seedWalkthrough(service: CaseService, demo: DemoTemplate): Promise<{ view: CaseView; changed: boolean }> {
  return service.seedCase(demo.input, { ...demo.files, id: WALKTHROUGH_ID, read_only: true });
}

/**
 * A judge's own copy of the demo case, made on the server from the same recorded input; nothing in it comes from the request.
 * It has no payment date: the judge pays now in the sandbox, and the capture sets the date.
 */
export function createDemoCopy(service: CaseService, demo: DemoTemplate): Promise<CaseView> {
  return service.createCase({ ...demo.input, paid_at: null }, { ...demo.files, id: service.newCaseId() });
}

/**
 * The amount the contractor stand-in offers. In the public demo it is always DEMO_OFFER_AMOUNT and only on demo cases;
 * otherwise the caller's amount, or DEMO_OFFER_AMOUNT on a demo case when none is given.
 */
export function standInOfferAmount(options: { publicDemo: boolean; template: string | undefined; requested: unknown }): unknown {
  const { publicDemo, template, requested } = options;
  if (!publicDemo) return requested ?? (template ? DEMO_OFFER_AMOUNT : undefined);
  if (!template) throw new HttpError(403, 'PUBLIC_DEMO', 'In the hosted demo the contractor stand-in answers only on copies of the demo case');
  if (requested !== undefined && requested !== DEMO_OFFER_AMOUNT) {
    throw new HttpError(403, 'PUBLIC_DEMO', `In the hosted demo the contractor stand-in always offers $${DEMO_OFFER_AMOUNT}; leave the amount out`);
  }
  return DEMO_OFFER_AMOUNT;
}
