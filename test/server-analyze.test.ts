// The photo check through the real server: environment settings, a real HTTP upload, a fake Ollama, a fake PayPal, a temp MIR_DATA_DIR.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { start, type RunningServer } from '../src/server.js';
import { fakePayPal } from './helpers/fake-paypal.js';
import { MINI_EXTRACTED, MINI_JOB, MINI_JUDGED, miniForm } from './helpers/upload.js';

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface OllamaCall {
  url: string;
  body: { model: string; options: { num_ctx: number }; messages: Array<{ images?: string[] }> };
}

/** Answers the model's calls in order with the given JSON values, or with an HTTP error when the value is a number */
function fakeOllama(answers: Array<unknown>) {
  const calls: OllamaCall[] = [];
  const queue = [...answers];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: JSON.parse(init!.body as string) });
    const answer = queue.shift();
    if (typeof answer === 'number') return new Response('model unavailable', { status: answer });
    return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) } }), { status: 200 });
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

async function boot(env: Record<string, string> = {}, answers: Array<unknown> = [MINI_EXTRACTED, MINI_JUDGED], dir?: string) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'mir-server-analyze-'));
  if (!dir) dirs.push(root);
  const ollama = fakeOllama(answers);
  const server = await start(
    { PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret-value', PORT: '0', MIR_DATA_DIR: join(root, 'db'), ...env },
    { fetch: fakePayPal().fetch, modelFetch: ollama.fetch, log: () => undefined },
  );
  running.push(server);
  return { server, ollama, root, dataDir: join(root, 'db'), base: `http://127.0.0.1:${server.port}` };
}

const analyze = (base: string, form: FormData = miniForm()) => fetch(`${base}/api/cases/analyze`, { method: 'POST', body: form });
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe('POST /api/cases/analyze on the running server', () => {
  it('reads the model from MIR_VISION_MODEL, passes the context size explicitly and answers with the case', async () => {
    const { base, ollama } = await boot({ MIR_VISION_MODEL: 'ollama:test-model:7b', MIR_OLLAMA_URL: 'http://ollama.test:11434' });
    const res = await analyze(base);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.claim).toMatchObject({ amount: '1050.00', proven_done: '1150.00', paid_total: '2200.00' });
    expect(body.photos.map((p: any) => p.url)).toEqual([`/api/cases/${body.case.id}/photos/photo-1.png`, `/api/cases/${body.case.id}/photos/photo-2.png`]);

    expect(ollama.calls.map((c) => c.url)).toEqual(['http://ollama.test:11434/api/chat', 'http://ollama.test:11434/api/chat']);
    expect(ollama.calls.map((c) => c.body.model)).toEqual(['test-model:7b', 'test-model:7b']);
    expect(ollama.calls.map((c) => c.body.options.num_ctx)).toEqual([16384, 16384]); // always sent, never left to Ollama's default
    expect(ollama.calls[0]!.body.messages[1]!.images).toBeUndefined(); // a PDF estimate goes in as text
    expect(ollama.calls[1]!.body.messages[1]!.images).toEqual(MINI_JOB.photos.map((p) => p.toString('base64')));
  });

  it('takes the context size from MIR_NUM_CTX', async () => {
    const { base, ollama } = await boot({ MIR_VISION_MODEL: 'ollama:m', MIR_NUM_CTX: '8192' });
    expect((await analyze(base)).status).toBe(201);
    expect(ollama.calls.map((c) => c.body.options.num_ctx)).toEqual([8192, 8192]);
    expect(ollama.calls[0]!.url).toBe('http://localhost:11434/api/chat');
  });

  it('serves the uploaded files over HTTP, byte for byte', async () => {
    const { base } = await boot({ MIR_VISION_MODEL: 'ollama:m' });
    const { case: made } = (await (await analyze(base)).json()) as { case: { id: string } };
    const photo = await fetch(`${base}/api/cases/${made.id}/photos/photo-2.png`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/png');
    expect(await bytes(photo)).toEqual(MINI_JOB.photos[1]);
    const estimate = await fetch(`${base}/api/cases/${made.id}/estimate`);
    expect(estimate.headers.get('content-type')).toBe('application/pdf');
    expect(await bytes(estimate)).toEqual(MINI_JOB.estimate);
    expect((await fetch(`${base}/api/cases/${made.id}/photos/photo-3.png`)).status).toBe(404);
  });

  it('answers 502 when Ollama fails and leaves no case and no files', async () => {
    const { base, dataDir } = await boot({ MIR_VISION_MODEL: 'ollama:m' }, [500]);
    const res = await analyze(base);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.code).toBe('PHOTO_CHECK_FAILED');
    expect(existsSync(join(dataDir, 'uploads'))).toBe(false);
  });

  it('answers 503 when MIR_VISION_MODEL is not set, and writes nothing', async () => {
    const { base, ollama, dataDir } = await boot();
    const res = await analyze(base);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe('PHOTO_CHECK_NOT_CONFIGURED');
    expect(ollama.calls).toEqual([]);
    expect(existsSync(join(dataDir, 'uploads'))).toBe(false);
  });

  it('keeps the case and its files across a restart, also when the model is no longer set', async () => {
    const first = await boot({ MIR_VISION_MODEL: 'ollama:m' });
    const { case: made } = (await (await analyze(first.base)).json()) as { case: { id: string } };
    expect(readdirSync(join(first.dataDir, 'uploads', made.id)).sort()).toEqual(['estimate.pdf', 'photo-1.png', 'photo-2.png']);
    await first.server.stop();
    running.pop();

    const second = await boot({}, [], first.root);
    const view = (await (await fetch(`${second.base}/api/cases/${made.id}`)).json()) as any;
    expect(view.claim.amount).toBe('1050.00');
    expect(view.photos).toHaveLength(2);
    expect(await bytes(await fetch(`${second.base}${view.photos[0].url}`))).toEqual(MINI_JOB.photos[0]);
    expect((await analyze(second.base)).status).toBe(503);
  });

  it('refuses to start with a model setting it cannot read, before anything is opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-server-analyze-'));
    dirs.push(dir);
    await expect(
      start({ PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 's', PORT: '0', MIR_DATA_DIR: join(dir, 'db'), MIR_VISION_MODEL: 'gemma4:31b' }, { log: () => undefined }),
    ).rejects.toThrow(/MIR_VISION_MODEL/);
    expect(existsSync(join(dir, 'db'))).toBe(false);
  });
});
