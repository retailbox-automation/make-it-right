// The "Try a hostile file" page (/hostile): its routes, the file allow-list, the page model, and that the copy in
// demo/hostile/ is exactly eval/hostile/ (RESULTS.json and every file it lists), with the score agreeing with the cases.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadDemo, seedWalkthrough } from '../src/demo.js';
import { Tracker } from '../src/disputes/tracker.js';
import { HttpError } from '../src/errors.js';
import { HOSTILE_DIR, hostileFiles, registerHostile } from '../src/hostile.js';
import { KeyedLock } from '../src/lock.js';
import { CaseService } from '../src/service.js';
import { BROKEN_RESULTS, dollars, hostileModel, NO_RESULTS } from '../web/hostile.js';
import { makeWorld } from './helpers/world.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/hostile/', import.meta.url));
const fixtureResults = () => JSON.parse(readFileSync(join(FIXTURE, 'RESULTS.json'), 'utf8'));

/** A bare app with only the hostile routes, reading `dir`, with the same not-found answer as the real app */
function hostileApp(dir: string): Hono {
  const app = new Hono();
  const send = async (path: string) => {
    try {
      return new Response(new Uint8Array(await readFile(path)));
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'not found');
    }
  };
  registerHostile(app, { page: async () => new Response('page'), sendFile: send, dir });
  app.onError((error, c) => (error instanceof HttpError ? c.json({ error: error.code }, error.status) : c.json({ error: 'X' }, 500)));
  return app;
}

describe('hostile files: the allow-list', () => {
  it('sends a file only when RESULTS.json lists it, from the listed path', async () => {
    const app = hostileApp(FIXTURE);
    const ok = await app.request('/hostile/files/cases/H07/photos/photo-4.png');
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('FIXTURE-PNG-BYTES');
    expect((await app.request('/hostile/files/cases/H07/attack.json')).status).toBe(200);
  });

  it.each([
    '/hostile/files/cases/H07/unlisted.txt',
    '/hostile/files/secret.txt',
    '/hostile/files/RESULTS.json',
    '/hostile/files/../RESULTS.json',
    '/hostile/files/cases/H07/../../secret.txt',
    '/hostile/files/cases/H07/%2e%2e/%2e%2e/secret.txt',
    '/hostile/files/cases%2FH07%2Fphotos%2Fphoto-4.png',
    '/hostile/files/cases/H07/photos/photo-4.png%00',
    '/hostile/files/%2Fetc%2Fhosts',
    '/hostile/files//etc/hosts',
    '/hostile/files/cases/../../../package.json',
    '/hostile/files/cases/H13/texts.txt',
    '/hostile/files/CASES/H07/photos/photo-4.png',
    '/hostile/files/',
  ])('answers 404 for %s', async (path) => {
    const res = await hostileApp(FIXTURE).request(path);
    expect(res.status).toBe(404);
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).not.toContain('FIXTURE');
  });

  it('drops listed paths that leave the case folder or are not plain names', () => {
    const files = hostileFiles(fixtureResults(), '/x');
    expect([...files.keys()].sort()).toEqual(['cases/H07/attack.json', 'cases/H07/photos/photo-4.png', 'cases/H13/texts.txt']);
    for (const path of files.values()) expect(path.startsWith('/x/cases/')).toBe(true);
  });

  it('sends nothing, and the page still opens, when RESULTS.json is missing or broken', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'hostile-empty-'));
    const broken = mkdtempSync(join(tmpdir(), 'hostile-broken-'));
    writeFileSync(join(broken, 'RESULTS.json'), '{"cases": [ {"files": ["eval/hostile/cases/H07/photos/photo-4.png"] ');
    for (const dir of [empty, broken]) {
      const app = hostileApp(dir);
      expect((await app.request('/hostile')).status).toBe(200);
      expect((await app.request('/hostile/files/cases/H07/photos/photo-4.png')).status).toBe(404);
    }
    expect((await hostileApp(empty).request('/hostile/results.json')).status).toBe(404);
  });
});

describe('hostile files: the page model', () => {
  it('shows the score exactly as RESULTS.json counts it', () => {
    const results = fixtureResults();
    const model = hostileModel(results);
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.score.attacks).toBe(`${results.score.attacks.repelled} of ${results.score.attacks.total}`);
    expect(model.score.controls).toBe(`${results.score.controls.passed} of ${results.score.controls.total}`);
    expect(model.model).toBe('gemma4:31b');
    expect(model.rows.map((r) => [r.key, r.verdict, r.held])).toEqual([
      ['H07', 'Repelled', true],
      ['H13', 'Missed', false],
      ['K01', 'Passed, no false alarm', true],
    ]);
  });

  it("shows the model's answer verbatim and links only listed case files", () => {
    const results = fixtureResults();
    const model = hostileModel(results);
    if (!model.ok) throw new Error('model not ok');
    const [h07, h13] = model.rows;
    expect(JSON.parse(h07!.answer)).toEqual(results.cases[0].model_answer);
    expect(h07!.files.map((f) => f.href)).toEqual(['/hostile/files/cases/H07/photos/photo-4.png', '/hostile/files/cases/H07/attack.json']);
    expect(h13!.files.map((f) => f.href)).toEqual(['/hostile/files/cases/H13/texts.txt']);
    expect(h13!.answer).toBe('No model call was made for this case.');
    expect(h07!.claim).toBe('$2,650.00');
    expect(h07!.warnings).toEqual(['FIXTURE warning']);
  });

  it('says there is nothing to show, instead of failing, for empty, broken or partial results', () => {
    expect(hostileModel(null)).toEqual({ ok: false, message: NO_RESULTS });
    expect(hostileModel(undefined)).toEqual({ ok: false, message: NO_RESULTS });
    for (const bad of ['', 'x', 42, [], {}, { score: {} , cases: [] }, { score: { attacks: { repelled: 3, total: 2 }, controls: { passed: 1, total: 1 } }, cases: [] }, { score: { attacks: { repelled: '1', total: 2 }, controls: { passed: 1, total: 1 } }, cases: [] }, { ...fixtureResults(), cases: 'x' }]) {
      expect(hostileModel(bad)).toEqual({ ok: false, message: BROKEN_RESULTS });
    }
    const odd = fixtureResults();
    odd.cases.push(null, 'x', { id: 'Z1', kind: 'other' }, { kind: 'attack' });
    const model = hostileModel(odd);
    expect(model.ok && model.rows.length).toBe(3);
  });

  it('formats amounts without arithmetic', () => {
    expect(dollars('2650.00')).toBe('$2,650.00');
    expect(dollars('300.00')).toBe('$300.00');
    expect(dollars('1234567.89')).toBe('$1,234,567.89');
    expect(dollars(2650)).toBe('');
    expect(dollars('2650')).toBe('');
  });

  it('puts the model score into the two score slots of the page', () => {
    const html = readFileSync(join(ROOT, 'web/hostile.html'), 'utf8');
    const js = readFileSync(join(ROOT, 'web/hostile.js'), 'utf8');
    expect(html).toContain('data-score="attacks"');
    expect(html).toContain('data-score="controls"');
    expect(js).toContain(`querySelector('[data-score="attacks"]')).textContent = model.score.attacks`);
    expect(js).toContain(`querySelector('[data-score="controls"]')).textContent = model.score.controls`);
    // no number on the page is typed in by hand
    expect(html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<head>[\s\S]*?<\/head>/, '')).not.toMatch(/\b\d+ of \d+\b/);
  });
});

describe('hostile files: the copy shown on the demo', () => {
  const original = join(ROOT, 'eval/hostile/RESULTS.json');
  const copy = join(HOSTILE_DIR, 'RESULTS.json');

  it('is RESULTS.json byte for byte, or both are absent', () => {
    expect(existsSync(copy)).toBe(existsSync(original));
    if (existsSync(original)) expect(readFileSync(copy).equals(readFileSync(original))).toBe(true);
  });

  it('holds every listed case file byte for byte, and the score agrees with the cases', () => {
    if (!existsSync(original)) return;
    const results = JSON.parse(readFileSync(original, 'utf8'));
    const listed = hostileFiles(results);
    for (const c of results.cases) for (const f of c.files) expect(listed.has(f.slice('eval/hostile/'.length)), f).toBe(true);
    for (const [rel, path] of listed) expect(readFileSync(path).equals(readFileSync(join(ROOT, 'eval/hostile', rel))), rel).toBe(true);
    const count = (kind: string, verdict: string) => results.cases.filter((c: any) => c.kind === kind && c.verdict === verdict).length;
    const total = (kind: string) => results.cases.filter((c: any) => c.kind === kind).length;
    expect(results.score.attacks).toMatchObject({ repelled: count('attack', 'repelled'), missed: count('attack', 'missed'), failed: count('attack', 'failed'), total: total('attack') });
    expect(results.score.controls).toMatchObject({ passed: count('control', 'repelled'), total: total('control') });
    const model = hostileModel(results);
    if (!model.ok) throw new Error('the real results do not open on the page');
    // the cases the check did not hold are shown like the others: verdict, what moved and in whose favour, nothing hidden
    expect(model.rows).toHaveLength(results.cases.length);
    for (const c of results.cases.filter((x: any) => x.verdict !== 'repelled')) {
      const row = model.rows.find((r) => r.key === c.id)!;
      expect(row.held, c.id).toBe(false);
      expect(row.why, c.id).toBe(c.why);
      expect(row.verdict, c.id).not.toBe('');
    }
  });
});

describe('hostile files: the app', () => {
  let app: Hono;
  beforeEach(async () => {
    const world = makeWorld();
    const locks = new KeyedLock();
    const service = new CaseService({
      store: world.store, paypal: world.client, tracker: new Tracker({ store: world.store, paypal: world.client, locks }), locks,
      newId: () => 'copy1', urls: { returnUrl: 'https://demo.example/r', cancelUrl: 'https://demo.example/c' },
    });
    const demo = loadDemo();
    await seedWalkthrough(service, demo);
    app = createApp(service, { log: () => undefined, demo });
  });

  it('opens /hostile with the page policy of the other screens, and its script', async () => {
    const res = await app.request('/hostile');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await res.text()).toContain('src="/web/hostile.js"');
    expect((await app.request('/web/hostile.js')).status).toBe(200);
  });

  it('keeps the start page, the walkthrough and the money-back screen as they were, and links the new page once', async () => {
    const start = await app.request('/');
    expect(start.status).toBe(200);
    expect((await start.text()).match(/href="\/hostile"/g)).toHaveLength(1);
    for (const path of ['/cases/demo-ridgeway', '/cases/demo-ridgeway/claim', '/cases/demo-ridgeway/money-back', '/api/cases/demo-ridgeway']) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it('answers 404, not an error, for files outside the list', async () => {
    for (const path of ['/hostile/files/../../package.json', '/hostile/files/%2e%2e/%2e%2e/package.json', '/hostile/files/cases/H01/../../../../src/app.ts']) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});
