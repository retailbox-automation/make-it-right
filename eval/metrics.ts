// Numbers of one eval run (docs/2026-11-01-mir-core/plan.md §2). Every number is printed with its n.
import { titleWords } from '../src/core/judge.js';
import type { PromisedItem, Verdict, VerdictStatus } from '../src/model.js';
import { toCents } from '../src/money.js';
import type { Truth, TruthVerdict } from './cases.js';

export type Stage = 'load' | 'extract' | 'judge_true' | 'judge_e2e';

export interface Failure {
  job: string;
  stage: Stage;
  /** timeout / invalid_json / invalid_output / http / network / exception */
  kind: string;
  message: string;
}

export interface JobResult {
  id: string;
  truth: Truth | null;
  payment_amount: string | null;
  /** null when extraction failed */
  extracted: PromisedItem[] | null;
  /** The judge on the TRUE items (verdict accuracy without extraction errors); null when it failed */
  verdicts_true: Verdict[] | null;
  /** End to end: extracted items → judge → claim; null when any step failed */
  claim_amount: string | null;
  /** Wall time of the end-to-end path (extraction + judge on the extracted items) */
  ms: number | null;
  failures: Failure[];
}

export interface Ratio {
  count: number;
  n: number;
  /** count / n, null when n = 0 */
  share: number | null;
}

const ratio = (count: number, n: number): Ratio => ({ count, n, share: n ? count / n : null });

// ---------- item matching ----------

/** Shared title words / all title words of the two titles (Jaccard). */
export function titleOverlap(a: string, b: string): number {
  const A = titleWords(a);
  const B = titleWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

export const MIN_TITLE_OVERLAP = 0.25;

export interface ItemMatch {
  pred: number;
  truth: number;
  by: 'price' | 'title';
}

/**
 * Greedy one-to-one: first pairs with the exact price in cents (best title overlap first), then the rest by title
 * word overlap (≥ MIN_TITLE_OVERLAP, best first). Ties go to the earlier item.
 */
export function matchItems(pred: PromisedItem[], truth: PromisedItem[]): ItemMatch[] {
  const usedP = new Set<number>();
  const usedT = new Set<number>();
  const out: ItemMatch[] = [];
  const pick = (cands: Array<{ p: number; t: number; score: number }>, by: ItemMatch['by']) => {
    cands.sort((x, y) => y.score - x.score || x.p - y.p || x.t - y.t);
    for (const c of cands) {
      if (usedP.has(c.p) || usedT.has(c.t)) continue;
      usedP.add(c.p);
      usedT.add(c.t);
      out.push({ pred: c.p, truth: c.t, by });
    }
  };
  const byPrice: Array<{ p: number; t: number; score: number }> = [];
  pred.forEach((p, i) => truth.forEach((t, j) => {
    if (toCents(p.price) === toCents(t.price)) byPrice.push({ p: i, t: j, score: titleOverlap(p.title, t.title) });
  }));
  pick(byPrice, 'price');
  const byTitle: Array<{ p: number; t: number; score: number }> = [];
  pred.forEach((p, i) => truth.forEach((t, j) => {
    if (usedP.has(i) || usedT.has(j)) return;
    const score = titleOverlap(p.title, t.title);
    if (score >= MIN_TITLE_OVERLAP) byTitle.push({ p: i, t: j, score });
  }));
  pick(byTitle, 'title');
  return out.sort((a, b) => a.truth - b.truth);
}

// ---------- verdicts ----------

export function verdictCorrect(truth: TruthVerdict, pred: Verdict | undefined): boolean {
  if (!pred || pred.status !== truth.status) return false;
  return truth.status !== 'partial' || pred.done_units === truth.done_units;
}

const STATUSES: VerdictStatus[] = ['done', 'partial', 'not_done', 'unclear'];
type PredStatus = VerdictStatus | 'none';

export interface JobRow {
  id: string;
  items_true: number | null;
  items_pred: number | null;
  items_matched: number | null;
  adds_up: boolean | null;
  verdicts_correct: number | null;
  verdicts_n: number | null;
  claim_true: string | null;
  claim_pred: string | null;
  claim_exact: boolean;
  ms: number | null;
  failures: number;
}

export interface Metrics {
  jobs: number;
  extraction: {
    /** Over all jobs; a failed extraction predicts nothing */
    true_items: number;
    predicted_items: number;
    matched: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    /** True items whose matched predicted item has the exact price (to the cent) */
    exact_price: Ratio;
    /** Jobs whose predicted items add up to the payment */
    adds_up: Ratio;
  };
  verdicts: {
    /** Over all true items; items of a job whose judge failed count as wrong ("none") */
    accuracy: Ratio;
    /** truth status → predicted status → count */
    confusion: Record<VerdictStatus, Record<PredStatus, number>>;
    /** Harm to an honest contractor: done items called not_done or unclear */
    done_called_unfinished: Ratio;
    /** Harm to the homeowner: not_done items called done */
    not_done_called_done: Ratio;
  };
  claim: { exact: Ratio };
  time: { ms_per_job: { n: number; mean: number | null; median: number | null; max: number | null } };
  failures: { count: number; jobs_with_failures: Ratio; by_kind: Record<string, number>; list: Failure[] };
  rows: JobRow[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function computeMetrics(jobs: JobResult[]): Metrics {
  let trueItems = 0, predItems = 0, matched = 0, exactPrice = 0, addsUp = 0;
  let vCorrect = 0, vN = 0, doneN = 0, doneHarm = 0, notDoneN = 0, notDoneHarm = 0, claimExact = 0;
  const confusion = Object.fromEntries(STATUSES.map((s) => [s, Object.fromEntries([...STATUSES, 'none'].map((p) => [p, 0]))])) as Metrics['verdicts']['confusion'];
  const times: number[] = [];
  const failures: Failure[] = [];
  const rows: JobRow[] = [];

  for (const job of jobs) {
    failures.push(...job.failures);
    const row: JobRow = {
      id: job.id, items_true: null, items_pred: null, items_matched: null, adds_up: null, verdicts_correct: null, verdicts_n: null,
      claim_true: job.truth?.claim_amount ?? null, claim_pred: job.claim_amount, claim_exact: false, ms: job.ms, failures: job.failures.length,
    };
    rows.push(row);
    if (job.ms !== null) times.push(job.ms);
    if (!job.truth) continue; // the job did not load: counted in jobs and failures only
    const truth = job.truth;

    // extraction
    const pred = job.extracted ?? [];
    const m = matchItems(pred, truth.promised_items);
    trueItems += truth.promised_items.length;
    predItems += pred.length;
    matched += m.length;
    exactPrice += m.filter((x) => toCents(pred[x.pred]!.price) === toCents(truth.promised_items[x.truth]!.price)).length;
    row.items_true = truth.promised_items.length;
    row.items_pred = job.extracted ? pred.length : null;
    row.items_matched = m.length;
    if (job.extracted && job.payment_amount !== null) {
      row.adds_up = pred.reduce((s, i) => s + toCents(i.price), 0) === toCents(job.payment_amount);
      if (row.adds_up) addsUp++;
    }

    // verdicts on the true items
    const byItem = new Map((job.verdicts_true ?? []).map((v) => [v.item_id, v]));
    let correct = 0;
    for (const tv of truth.verdicts) {
      const pv = byItem.get(tv.item_id);
      const ps: PredStatus = pv?.status ?? 'none';
      confusion[tv.status][ps]++;
      if (verdictCorrect(tv, pv)) correct++;
      if (tv.status === 'done') {
        doneN++;
        if (ps === 'not_done' || ps === 'unclear') doneHarm++;
      }
      if (tv.status === 'not_done') {
        notDoneN++;
        if (ps === 'done') notDoneHarm++;
      }
    }
    vCorrect += correct;
    vN += truth.verdicts.length;
    row.verdicts_correct = job.verdicts_true ? correct : null;
    row.verdicts_n = truth.verdicts.length;

    // end-to-end claim
    row.claim_exact = job.claim_amount !== null && toCents(job.claim_amount) === toCents(truth.claim_amount);
    if (row.claim_exact) claimExact++;
  }

  const precision = predItems ? matched / predItems : null;
  const recall = trueItems ? matched / trueItems : null;
  // 2·TP / (predicted + true): the same as 2PR/(P+R), and defined (0) when nothing was predicted
  const f1 = predItems + trueItems ? (2 * matched) / (predItems + trueItems) : null;
  const byKind: Record<string, number> = {};
  for (const f of failures) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return {
    jobs: jobs.length,
    extraction: {
      true_items: trueItems, predicted_items: predItems, matched, precision, recall, f1,
      exact_price: ratio(exactPrice, trueItems),
      adds_up: ratio(addsUp, jobs.length),
    },
    verdicts: {
      accuracy: ratio(vCorrect, vN),
      confusion,
      done_called_unfinished: ratio(doneHarm, doneN),
      not_done_called_done: ratio(notDoneHarm, notDoneN),
    },
    claim: { exact: ratio(claimExact, jobs.length) },
    time: {
      ms_per_job: {
        n: times.length,
        mean: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
        median: median(times),
        max: times.length ? Math.max(...times) : null,
      },
    },
    failures: { count: failures.length, jobs_with_failures: ratio(jobs.filter((j) => j.failures.length).length, jobs.length), by_kind: byKind, list: failures },
    rows,
  };
}

// ---------- summary.md ----------

const pct = (r: Ratio) => (r.share === null ? '—' : `${(r.share * 100).toFixed(1)} % (${r.count}/${r.n})`);
const num = (x: number | null, digits = 3) => (x === null ? '—' : x.toFixed(digits));
const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export interface RunMeta {
  approach: string;
  model: string | null;
  num_ctx: number | null;
  cases: string;
  started_at: string;
  finished_at: string;
}

export function renderSummary(m: Metrics, meta: RunMeta): string {
  const e = m.extraction;
  const v = m.verdicts;
  const out: string[] = [
    `# Eval run: ${meta.approach}`,
    '',
    `Model: ${meta.model ?? 'none'} · num_ctx: ${meta.num_ctx ?? '—'} · cases: ${meta.cases} · ${meta.started_at} → ${meta.finished_at}`,
    '',
    '| Number | Value | n |',
    '|---|---|---|',
    `| Item F1 | ${num(e.f1)} | ${e.matched} matched of ${e.predicted_items} predicted, ${e.true_items} true |`,
    `| Item precision | ${num(e.precision)} | ${e.predicted_items} predicted items |`,
    `| Item recall | ${num(e.recall)} | ${e.true_items} true items |`,
    `| True items with the exact price | ${pct(e.exact_price)} | ${e.exact_price.n} true items |`,
    `| Jobs whose items add up to the payment | ${pct(e.adds_up)} | ${e.adds_up.n} jobs |`,
    `| Verdict accuracy (true items) | ${pct(v.accuracy)} | ${v.accuracy.n} true items |`,
    `| Done items called not_done / unclear | ${pct(v.done_called_unfinished)} | ${v.done_called_unfinished.n} done items |`,
    `| Not-done items called done | ${pct(v.not_done_called_done)} | ${v.not_done_called_done.n} not-done items |`,
    `| Jobs with the exact claim (to the cent) | ${pct(m.claim.exact)} | ${m.claim.exact.n} jobs |`,
    `| Time per job, mean / median / max | ${sec(m.time.ms_per_job.mean)} / ${sec(m.time.ms_per_job.median)} / ${sec(m.time.ms_per_job.max)} | ${m.time.ms_per_job.n} jobs timed |`,
    `| Failures | ${m.failures.count} | ${pct(m.failures.jobs_with_failures)} jobs with a failure |`,
    '',
    '## Verdicts on the true items (rows: truth, columns: predicted)',
    '',
    `| truth \\ predicted | ${[...STATUSES, 'none'].join(' | ')} | n |`,
    `|---|${[...STATUSES, 'none'].map(() => '---').join('|')}|---|`,
    ...STATUSES.map((s) => {
      const r = v.confusion[s];
      const n = Object.values(r).reduce((a, b) => a + b, 0);
      return `| ${s} | ${[...STATUSES, 'none'].map((p) => r[p as PredStatus]).join(' | ')} | ${n} |`;
    }),
    '',
    '## Jobs',
    '',
    '| Job | Items matched / true (predicted) | Adds up | Verdicts correct / n | Claim predicted / true | Exact | Time | Failures |',
    '|---|---|---|---|---|---|---|---|',
    ...m.rows.map((r) =>
      `| ${r.id} | ${r.items_matched ?? '—'} / ${r.items_true ?? '—'} (${r.items_pred ?? '—'}) | ${r.adds_up === null ? '—' : r.adds_up ? 'yes' : 'no'} | ` +
      `${r.verdicts_correct ?? '—'} / ${r.verdicts_n ?? '—'} | ${r.claim_pred ?? '—'} / ${r.claim_true ?? '—'} | ${r.claim_exact ? 'yes' : 'no'} | ${sec(r.ms)} | ${r.failures} |`),
    '',
    '## Failures',
    '',
  ];
  if (!m.failures.list.length) out.push('None.');
  else {
    out.push(`By kind: ${Object.entries(m.failures.by_kind).map(([k, c]) => `${k} ${c}`).join(', ')}`, '', '| Job | Stage | Kind | Message |', '|---|---|---|---|');
    for (const f of m.failures.list) out.push(`| ${f.job} | ${f.stage} | ${f.kind} | ${cell(f.message.slice(0, 200))} |`);
  }
  return out.join('\n') + '\n';
}
