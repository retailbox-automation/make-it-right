import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { start, type RunningServer } from '../src/server.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './helpers/demo.js';
import { fakePayPal, fixture } from './helpers/fake-paypal.js';

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(extraEnv: (dir: string) => Record<string, string> = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'mir-server-'));
  dirs.push(dir);
  const fake = fakePayPal((c) => (c.method === 'POST' && c.path === '/v2/checkout/orders' ? { body: fixture('order-created') } : undefined));
  const server = await start(
    { PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret-value', PORT: '0', MIR_DATA_DIR: join(dir, 'db'), ...extraEnv(dir) },
    { fetch: fake.fetch, log: () => undefined },
  );
  running.push(server);
  return { server, fake, dir, base: `http://127.0.0.1:${server.port}` };
}

const caseBody = () => JSON.stringify({ payee_name: 'Ridgeway Electric', promised_items: RIDGEWAY_ITEMS, verdicts: RIDGEWAY_VERDICTS });
const post = (url: string, body?: string) => fetch(url, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}) });

describe('the server', () => {
  it('serves the API over HTTP and starts the payment at PayPal', async () => {
    const { fake, base } = await boot();
    const created = await post(`${base}/api/cases`, caseBody());
    expect(created.status).toBe(201);
    const { case: made } = (await created.json()) as { case: { id: string } };
    const payment = await post(`${base}/api/cases/${made.id}/payment`);
    expect(payment.status).toBe(200);
    expect(((await payment.json()) as { order_id: string }).order_id).toBe('5X6481368Y377541C');
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v2/checkout/orders']);
    expect((await fetch(`${base}/api/cases/nope`)).status).toBe(404);
  });

  it('keeps cases in the data directory across restarts', async () => {
    const first = await boot();
    const { case: made } = (await (await post(`${first.base}/api/cases`, caseBody())).json()) as { case: { id: string } };
    await first.server.stop();
    running.pop();

    const fake = fakePayPal();
    const second = await start(
      { PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret-value', PORT: '0', MIR_DATA_DIR: join(first.dir, 'db') },
      { fetch: fake.fetch, log: () => undefined },
    );
    running.push(second);
    const again = await fetch(`http://127.0.0.1:${second.port}/api/cases/${made.id}`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { claim: { amount: string } }).claim.amount).toBe('3150.00');
  });

  it('writes a call journal when asked: method, path, status, time and debug id only', async () => {
    const { base, dir } = await boot((d) => ({ MIR_CALL_JOURNAL: join(d, 'paypal.calls.jsonl') }));
    const { case: made } = (await (await post(`${base}/api/cases`, caseBody())).json()) as { case: { id: string } };
    await post(`${base}/api/cases/${made.id}/payment`);
    const text = readFileSync(join(dir, 'paypal.calls.jsonl'), 'utf8');
    const entries = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.map((l) => `${l.method} ${l.path}`)).toEqual(['POST /v1/oauth2/token', 'POST /v2/checkout/orders']);
    for (const secret of ['secret-value', 'tok-id', 'Bearer', 'Basic']) expect(text).not.toContain(secret);
  });

  it('writes no journal unless asked', async () => {
    const { dir } = await boot();
    expect(existsSync(join(dir, 'paypal.calls.jsonl'))).toBe(false);
  });

  it('fails at start, before anything is opened, when the journal path is bad', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-server-'));
    dirs.push(dir);
    await expect(
      start(
        { PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret-value', PORT: '0', MIR_DATA_DIR: join(dir, 'db'), MIR_CALL_JOURNAL: join(dir, 'no-such-dir', 'calls.jsonl') },
        { log: () => undefined },
      ),
    ).rejects.toThrow(/ENOENT/);
    expect(existsSync(join(dir, 'db'))).toBe(false);
  });

  it('fails cleanly when the port is taken', async () => {
    const first = await boot();
    const dir = mkdtempSync(join(tmpdir(), 'mir-server-'));
    dirs.push(dir);
    await expect(
      start({ PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret-value', PORT: String(first.server.port), MIR_DATA_DIR: join(dir, 'db') }, { log: () => undefined }),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  it('refuses to start without PayPal credentials', async () => {
    await expect(start({ PORT: '0' }, { log: () => undefined })).rejects.toThrow(/PAYPAL_SANDBOX_CLIENT_ID/);
  });

  it('stops cleanly twice', async () => {
    const { server } = await boot();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
    running.pop();
  });
});
