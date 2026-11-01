// Eval jobs on disk (built by docs/2026-11-01-mir-core/tools/build_cases.py):
//   <case>/estimate.pdf | estimate.jpg, texts.txt, payment.json, photos/photo-N.<png|jpg> — what the core sees;
//   <case>/truth.json — the answer key, read separately and never passed to a model.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CaseInput } from '../src/core/analyze.js';
import { readEstimate } from '../src/core/estimate.js';
import { parseTexts, type PaymentInfo } from '../src/core/extract.js';
import type { Photo } from '../src/core/judge.js';
import type { PromisedItem, VerdictStatus } from '../src/model.js';
import { toCents } from '../src/money.js';

export interface TruthVerdict {
  item_id: string;
  status: VerdictStatus;
  done_units: number;
  photo_refs: string[];
  why?: string;
}

export interface Truth {
  promised_items: PromisedItem[];
  verdicts: TruthVerdict[];
  claim_amount: string;
  proven_done: string;
  paid_total: string;
  traps?: string[];
}

export interface LoadedCase {
  id: string;
  input: CaseInput;
  truth: Truth;
}

const ESTIMATE_FILES = ['estimate.pdf', 'estimate.jpg', 'estimate.jpeg', 'estimate.png'];
const PHOTO_FILE = /^photo-(\d+)\.(png|jpe?g)$/i;

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Case directories under root (those with a payment.json), sorted; `only` must name existing cases. */
export async function listCases(root: string, only?: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isDirectory() && (await exists(join(root, e.name, 'payment.json')))) ids.push(e.name);
  }
  ids.sort();
  if (!only?.length) return ids;
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`no such case in ${root}: ${missing.join(', ')}`);
  return ids.filter((id) => only.includes(id));
}

export function checkPayment(raw: unknown): PaymentInfo {
  const p = raw as Partial<PaymentInfo> | null;
  if (!p || typeof p !== 'object') throw new Error('payment.json is not an object');
  if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error(`payment.json: date ${JSON.stringify(p.date)} is not YYYY-MM-DD`);
  if (typeof p.amount !== 'string') throw new Error('payment.json: amount must be a string like "4200.00"');
  toCents(p.amount);
  if (typeof p.payee !== 'string' || !p.payee.trim()) throw new Error('payment.json: payee is missing');
  return { date: p.date, amount: p.amount, method: typeof p.method === 'string' ? p.method : '', payee: p.payee, transaction_id: p.transaction_id ?? null };
}

export async function loadPhotos(dir: string): Promise<Photo[]> {
  if (!(await exists(dir))) return [];
  const files = (await readdir(dir))
    .map((f) => ({ f, n: Number(PHOTO_FILE.exec(f)?.[1]) }))
    .filter((x) => Number.isInteger(x.n) && x.n > 0)
    .sort((a, b) => a.n - b.n);
  return Promise.all(files.map(async ({ f, n }) => ({ id: `photo-${n}`, image: await readFile(join(dir, f)) })));
}

export async function loadCase(dir: string): Promise<LoadedCase> {
  const found = [];
  for (const f of ESTIMATE_FILES) if (await exists(join(dir, f))) found.push(f);
  if (found.length !== 1) throw new Error(`${dir}: expected one estimate file (${ESTIMATE_FILES.join(' / ')}), found ${found.length}`);
  const input: CaseInput = {
    estimate: await readEstimate(join(dir, found[0]!)),
    texts: (await exists(join(dir, 'texts.txt'))) ? parseTexts(await readFile(join(dir, 'texts.txt'), 'utf8')) : [],
    payment: checkPayment(JSON.parse(await readFile(join(dir, 'payment.json'), 'utf8'))),
    photos: await loadPhotos(join(dir, 'photos')),
  };
  const truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8')) as Truth;
  if (!Array.isArray(truth.promised_items) || !Array.isArray(truth.verdicts) || typeof truth.claim_amount !== 'string') {
    throw new Error(`${dir}/truth.json: needs promised_items, verdicts and claim_amount`);
  }
  return { id: basename(dir), input, truth };
}
