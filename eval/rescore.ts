// Re-score a finished eval run against the current truth, without calling any model again.
// Use it after a correction of truth.json: the model's saved answers stay, only the scoring changes.
//   npx tsx eval/rescore.ts --run <dir with predictions/> --cases <dir> --out <dir>
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCase } from './cases.js';
import { computeMetrics, renderSummary, type JobResult } from './metrics.js';

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' }, cases: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.run || !values.cases || !values.out) throw new Error('usage: npx tsx eval/rescore.ts --run <dir> --cases <dir> --out <dir>');
  const runDir = resolve(values.run);
  const outDir = resolve(values.out);
  const files = (await readdir(join(runDir, 'predictions'))).filter((f) => f.endsWith('.json')).sort();
  const jobs: JobResult[] = [];
  let meta: { approach: string; model: string | null; num_ctx: number | null } | null = null;
  for (const f of files) {
    const p = JSON.parse(await readFile(join(runDir, 'predictions', f), 'utf8'));
    meta ??= { approach: p.approach, model: p.model, num_ctx: p.num_ctx };
    const c = await loadCase(join(resolve(values.cases), p.id));
    jobs.push({
      id: p.id,
      truth: c.truth,
      payment_amount: c.input.payment.amount,
      extracted: p.extraction?.items ?? null,
      verdicts_true: p.judge_true?.verdicts ?? null,
      claim_amount: p.claim?.amount ?? null,
      ms: p.ms ?? null,
      failures: (p.failures ?? []).map(({ raw: _raw, ...rest }: { raw?: string }) => rest),
    });
  }
  const metrics = computeMetrics(jobs);
  const now = new Date().toISOString();
  const m = { approach: `${meta?.approach ?? '?'} (re-scored)`, model: meta?.model ?? null, num_ctx: meta?.num_ctx ?? null, cases: resolve(values.cases), started_at: now, finished_at: now };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'metrics.json'), JSON.stringify({ meta: m, rescored_from: runDir, ...metrics }, null, 1));
  await writeFile(join(outDir, 'summary.md'), renderSummary(metrics, m));
  const v = metrics.verdicts.accuracy;
  console.log(`re-scored ${jobs.length} jobs: verdict accuracy ${v.count}/${v.n} · exact claims ${metrics.claim.exact.count}/${metrics.claim.exact.n} → ${outDir}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
