// Eval runner: npx tsx eval/run.ts --cases <dir> --approach a0|a0-trust|a1-whole|a1-photo|a1-count
//   [--model gemma4:31b] [--num-ctx 16384] [--only c01,c02] --out <dir>
// Per job: extraction, the judge on the extracted items (end-to-end claim), the judge on the TRUE items (verdict
// accuracy). Writes <out>/predictions/<id>.json, <out>/metrics.json, <out>/summary.md; prints one row per job.
// Model approaches wait while the machine is busy (load average ≥ 14 or a restic backup/prune/forget/check running).
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { claimFor, extractItems, judgeItems, type AnalyzeOptions, type JudgeMode } from '../src/core/analyze.js';
import type { Extraction } from '../src/core/extract.js';
import type { Judgement } from '../src/core/judge.js';
import type { Claim } from '../src/model.js';
import { OllamaVisionModel } from '../src/models/ollama.js';
import { ModelError } from '../src/models/vision.js';
import { listCases, loadCase, type LoadedCase } from './cases.js';
import { computeMetrics, renderSummary, type Failure, type JobResult, type Stage } from './metrics.js';

const APPROACHES: Record<string, { judgeMode: JudgeMode; model: boolean }> = {
  a0: { judgeMode: 'a0', model: false },
  'a0-trust': { judgeMode: 'trust-texts', model: false },
  'a1-whole': { judgeMode: 'whole', model: true },
  'a1-photo': { judgeMode: 'photo', model: true },
  'a1-count': { judgeMode: 'whole-count', model: true },
};

const MAX_LOAD = 14;
const BUSY_WAIT_MS = 60_000;

function usage(msg: string): never {
  console.error(`${msg}\nusage: npx tsx eval/run.ts --cases <dir> --approach ${Object.keys(APPROACHES).join('|')} [--model gemma4:31b] [--num-ctx 16384] [--only c01,c02] --out <dir>`);
  process.exit(2);
}

/** Why the machine is too busy for a model run, or null. */
async function busyReason(): Promise<string | null> {
  const load = loadavg()[0]!;
  if (load >= MAX_LOAD) return `load average ${load.toFixed(2)} ≥ ${MAX_LOAD}`;
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'command=']);
  const restic = stdout.split('\n').find((c) => /(^|\/)restic\s+(.*\s)?(backup|prune|forget|check)\b/.test(c));
  return restic ? `restic is running: ${restic.slice(0, 80)}` : null;
}

async function waitForQuietMachine(): Promise<void> {
  for (let why = await busyReason(); why; why = await busyReason()) {
    console.log(`  waiting ${BUSY_WAIT_MS / 1000} s: ${why}`);
    await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
  }
}

function failure(job: string, stage: Stage, e: unknown): Failure & { raw?: string } {
  const kind = e instanceof ModelError ? e.kind : 'exception';
  const message = e instanceof Error ? e.message : String(e);
  return { job, stage, kind, message: message.slice(0, 500), ...(e instanceof ModelError && e.raw ? { raw: e.raw.slice(0, 4000) } : {}) };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string' },
      approach: { type: 'string' },
      model: { type: 'string', default: 'gemma4:31b' },
      'num-ctx': { type: 'string', default: '16384' },
      only: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  if (!values.cases) usage('--cases is required');
  if (!values.out) usage('--out is required');
  const approach = APPROACHES[values.approach ?? ''];
  if (!approach) usage(`--approach must be one of ${Object.keys(APPROACHES).join(', ')}`);
  const numCtx = Number(values['num-ctx']);
  const model = approach.model ? new OllamaVisionModel({ model: values.model, numCtx }) : undefined;
  const opts: AnalyzeOptions = { model, judgeMode: approach.judgeMode };
  const casesDir = resolve(values.cases);
  const outDir = resolve(values.out);
  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const ids = await listCases(casesDir, only);
  await mkdir(join(outDir, 'predictions'), { recursive: true });

  const started_at = new Date().toISOString();
  console.log(`${values.approach} · model ${model ? `${model.name} num_ctx ${model.numCtx}` : 'none'} · ${ids.length} jobs from ${casesDir}`);
  const jobs: JobResult[] = [];
  for (const id of ids) {
    if (model) await waitForQuietMachine();
    const job: JobResult = { id, truth: null, payment_amount: null, extracted: null, verdicts_true: null, claim_amount: null, ms: null, failures: [] };
    const failures: Array<Failure & { raw?: string }> = [];
    let extraction: Extraction | null = null;
    let judgeTrue: Judgement | null = null;
    let judgeE2e: Judgement | null = null;
    let claim: Claim | null = null;
    let c: LoadedCase | null = null;
    try {
      c = await loadCase(join(casesDir, id));
      job.truth = c.truth;
      job.payment_amount = c.input.payment.amount;
    } catch (e) {
      failures.push(failure(id, 'load', e));
    }
    if (c) {
      const input = c.input;
      let extractMs = 0;
      try {
        const r = await timed(() => extractItems(input, opts));
        extraction = r.value;
        extractMs = r.ms;
        job.extracted = extraction.items;
      } catch (e) {
        failures.push(failure(id, 'extract', e));
      }
      if (extraction) {
        const items = extraction.items;
        try {
          const r = await timed(() => judgeItems(items, input, opts));
          judgeE2e = r.value;
          claim = claimFor(items, judgeE2e.verdicts, input.payment);
          job.claim_amount = claim.amount;
          job.ms = extractMs + r.ms;
        } catch (e) {
          failures.push(failure(id, 'judge_e2e', e));
        }
      }
      try {
        judgeTrue = await judgeItems(c.truth.promised_items, input, opts);
        job.verdicts_true = judgeTrue.verdicts;
      } catch (e) {
        failures.push(failure(id, 'judge_true', e));
      }
    }
    job.failures = failures.map(({ raw: _raw, ...f }) => f);
    jobs.push(job);
    await writeFile(
      join(outDir, 'predictions', `${id}.json`),
      JSON.stringify({ id, approach: values.approach, model: model?.name ?? null, num_ctx: model?.numCtx ?? null, extraction, judge_e2e: judgeE2e, claim, judge_true: judgeTrue, ms: job.ms, failures }, null, 1),
    );
    const row = computeMetrics([job]).rows[0]!;
    console.log(
      `${id}  items ${row.items_matched ?? '—'}/${row.items_true ?? '—'} (pred ${row.items_pred ?? '—'})  ` +
        `verdicts ${row.verdicts_correct ?? '—'}/${row.verdicts_n ?? '—'}  claim ${row.claim_pred ?? '—'} vs ${row.claim_true ?? '—'} ${row.claim_exact ? 'exact' : 'WRONG'}  ` +
        `${job.ms === null ? '—' : `${(job.ms / 1000).toFixed(1)} s`}  failures ${failures.length}${failures.length ? ` (${failures.map((f) => `${f.stage}:${f.kind}`).join(', ')})` : ''}`,
    );
  }

  const metrics = computeMetrics(jobs);
  const meta = { approach: values.approach!, model: model?.name ?? null, num_ctx: model?.numCtx ?? null, cases: casesDir, started_at, finished_at: new Date().toISOString() };
  await writeFile(join(outDir, 'metrics.json'), JSON.stringify({ meta, ...metrics }, null, 1));
  await writeFile(join(outDir, 'summary.md'), renderSummary(metrics, meta));
  const v = metrics.verdicts.accuracy;
  console.log(
    `done: verdict accuracy ${v.count}/${v.n} · exact claims ${metrics.claim.exact.count}/${metrics.claim.exact.n} · item F1 ${metrics.extraction.f1?.toFixed(3) ?? '—'} · failures ${metrics.failures.count} → ${outDir}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
