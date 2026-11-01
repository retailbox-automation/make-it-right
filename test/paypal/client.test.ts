import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FOREIGN_HOLD_IDS,
  PayPalClient,
  PayPalError,
  RefusedRequestError,
  SANDBOX_BASE_URL,
  type JournalEntry,
  type Ownership,
} from '../../src/paypal/client.js';
import { fakePayPal, tokenFor, type Route } from '../helpers/fake-paypal.js';

const CREDS = { clientId: 'client-A', clientSecret: 'secret-A-do-not-leak' };
const ownsNothing: Ownership = { order: () => false, dispute: () => false };
const ok: Route = () => ({ status: 200, body: { ok: true } });

function makeClient(route: Route = ok, extra: Partial<ConstructorParameters<typeof PayPalClient>[0]> = {}) {
  const fake = fakePayPal(route);
  const client = new PayPalClient({ ...CREDS, fetch: fake.fetch, ...extra });
  return { fake, client };
}

describe('sandbox-only guard', () => {
  it('uses the sandbox host by default', async () => {
    const { fake, client } = makeClient();
    await client.request('GET', '/v2/payments/captures/ABC');
    expect(SANDBOX_BASE_URL).toBe('https://api-m.sandbox.paypal.com');
    expect(fake.calls[0]?.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/ABC');
    expect(fake.tokenCalls[0]?.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
  });

  it('accepts the sandbox URL when given explicitly, with or without a trailing slash', () => {
    const fake = fakePayPal();
    expect(() => new PayPalClient({ ...CREDS, baseUrl: SANDBOX_BASE_URL, fetch: fake.fetch })).not.toThrow();
    expect(() => new PayPalClient({ ...CREDS, baseUrl: `${SANDBOX_BASE_URL}/`, fetch: fake.fetch })).not.toThrow();
  });

  it.each([
    'https://api-m.paypal.com',
    'https://api.paypal.com',
    'https://api-m.sandbox.paypal.com.evil.example',
    'https://evil.example/https://api-m.sandbox.paypal.com',
    'http://api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com:8443',
    'https://api-m.sandbox.paypal.com/v1',
    '',
  ])('refuses any other base URL: %s', (baseUrl) => {
    const fake = fakePayPal();
    expect(() => new PayPalClient({ ...CREDS, baseUrl, fetch: fake.fetch })).toThrow(/sandbox/i);
  });

  it('refuses a path that would leave the sandbox host', async () => {
    const { fake, client } = makeClient();
    await expect(client.request('GET', '//evil.example/x')).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('GET', 'https://api-m.paypal.com/v1/x')).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('GET', 'v1/x')).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(0);
    expect(fake.tokenCalls).toHaveLength(0);
  });
});

describe('credentials belong to one client instance', () => {
  it('needs a client id and a secret', () => {
    const fake = fakePayPal();
    expect(() => new PayPalClient({ clientId: '', clientSecret: 'x', fetch: fake.fetch })).toThrow(/client id/i);
    expect(() => new PayPalClient({ clientId: 'x', clientSecret: '', fetch: fake.fetch })).toThrow(/secret/i);
  });

  it('two instances never share a token', async () => {
    const fake = fakePayPal(ok);
    const a = new PayPalClient({ clientId: 'client-A', clientSecret: 'secret-A', fetch: fake.fetch });
    const b = new PayPalClient({ clientId: 'client-B', clientSecret: 'secret-B', fetch: fake.fetch });
    await a.request('GET', '/v2/payments/captures/X1');
    await b.request('GET', '/v2/payments/captures/X2');
    await a.request('GET', '/v2/payments/captures/X3');
    expect(fake.tokenCalls).toHaveLength(2);
    expect(fake.calls.map((c) => c.headers['authorization'])).toEqual([
      `Bearer ${tokenFor('client-A')}`,
      `Bearer ${tokenFor('client-B')}`,
      `Bearer ${tokenFor('client-A')}`,
    ]);
  });

  it('ignores environment variables entirely', async () => {
    vi.stubEnv('PAYPAL_SANDBOX_CLIENT_ID', 'env-client');
    vi.stubEnv('PAYPAL_SANDBOX_CLIENT_SECRET', 'env-secret');
    try {
      const { fake, client } = makeClient();
      await client.request('GET', '/v2/payments/captures/ABC');
      expect(fake.calls[0]?.headers['authorization']).toBe(`Bearer ${tokenFor('client-A')}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps all PayPal code free of process.env and module-level state', () => {
    const dir = new URL('../../src/paypal/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(text, `${file} reads the environment`).not.toMatch(/process\.env/);
      expect(text, `${file} has a module-level mutable binding`).not.toMatch(/^(let|var) /m);
    }
  });

  it('caches the token until shortly before it expires, then fetches a new one', async () => {
    let nowMs = 1_000_000;
    const fake = fakePayPal(ok, { tokenTtlSeconds: 3600 });
    const client = new PayPalClient({ ...CREDS, fetch: fake.fetch, clock: () => nowMs });
    await client.request('GET', '/v2/payments/captures/A');
    nowMs += 3000 * 1000; // 50 min later: still cached
    await client.request('GET', '/v2/payments/captures/B');
    expect(fake.tokenCalls).toHaveLength(1);
    nowMs += 600 * 1000; // 60 min after the first token: inside the safety margin of the expiry
    await client.request('GET', '/v2/payments/captures/C');
    expect(fake.tokenCalls).toHaveLength(2);
  });

  it('asks for one token when several requests start together', async () => {
    const { fake, client } = makeClient();
    await Promise.all([1, 2, 3].map((n) => client.request('GET', `/v2/payments/captures/C${n}`)));
    expect(fake.tokenCalls).toHaveLength(1);
  });

  it('drops the cached token after a 401 so the next call fetches a new one', async () => {
    let first = true;
    const { fake, client } = makeClient(() => {
      if (first) {
        first = false;
        return { status: 401, body: { error: 'invalid_token', error_description: 'token expired' } };
      }
      return { status: 200, body: {} };
    });
    await expect(client.request('GET', '/v2/payments/captures/A')).rejects.toMatchObject({ status: 401 });
    await client.request('GET', '/v2/payments/captures/A');
    expect(fake.tokenCalls).toHaveLength(2);
  });

  it('fails with a PayPalError (and no secret in the message) when the token request fails', async () => {
    const fetchFail: typeof fetch = async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client Authentication failed' }), { status: 401 });
    const client = new PayPalClient({ ...CREDS, fetch: fetchFail });
    const err = await client.request('GET', '/v2/payments/captures/A').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain(CREDS.clientSecret);
    expect(String(err.message)).not.toContain(CREDS.clientId);
  });
});

describe('other projects\' hold ids are refused before any network call', () => {
  it('knows the four holds', () => {
    expect([...FOREIGN_HOLD_IDS].sort()).toEqual(['1CM060836C119894N', '1Y214495HX657682L', '4RR33540BR8604004', '5YP64371F43512053']);
  });

  describe.each(FOREIGN_HOLD_IDS)('hold %s', (id) => {
    it('in the path', async () => {
      const { fake, client } = makeClient();
      await expect(client.request('GET', `/v2/payments/authorizations/${id}`)).rejects.toBeInstanceOf(RefusedRequestError);
      expect(fake.calls).toHaveLength(0);
      expect(fake.tokenCalls).toHaveLength(0);
    });
    it('in the query, in lower case too', async () => {
      const { fake, client } = makeClient();
      await expect(client.request('GET', '/v1/customer/disputes', { query: { disputed_transaction_id: id.toLowerCase() } })).rejects.toBeInstanceOf(RefusedRequestError);
      expect(fake.calls).toHaveLength(0);
    });
    it('in a JSON body, however deep', async () => {
      const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
      await expect(
        client.request('POST', '/v1/customer/disputes/PP-R-1/make-offer', { json: { note: 'x', deeper: [{ ref: `see ${id}` }] } }),
      ).rejects.toBeInstanceOf(RefusedRequestError);
      expect(fake.calls).toHaveLength(0);
    });
    it('in the text part of a multipart body', async () => {
      const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
      await expect(
        client.request('POST', '/v1/customer/disputes/PP-R-1/accept-claim', { multipart: { input: { note: id, accept_claim_type: 'REFUND' } } }),
      ).rejects.toBeInstanceOf(RefusedRequestError);
      expect(fake.calls).toHaveLength(0);
    });
  });

  it('does not refuse ids that merely look similar', async () => {
    const { fake, client } = makeClient();
    await client.request('GET', '/v2/payments/captures/4RR33540BR8604005');
    expect(fake.calls).toHaveLength(1);
  });
});

describe('webhooks are never touched', () => {
  it.each([
    ['GET', '/v1/notifications/webhooks'],
    ['GET', '/v1/notifications/webhooks-events'],
    ['POST', '/v1/notifications/webhooks'],
    ['GET', '/v1/notifications/webhooks/WH-1'],
    ['GET', '/V1/Notifications/Webhooks'],
    ['GET', '/v1/customer/../notifications/webhooks'],
    ['GET', '/v1/notifications/%77ebhooks'],
    ['GET', '/v1//notifications/webhooks'],
    ['GET', '/v1/notifications//webhooks'],
    ['GET', '/v1///notifications///webhooks-events'],
    ['GET', '/v1/customer/%2e%2e/notifications/webhooks'],
    ['GET', '/v1/notifications%2Fwebhooks'],
    ['GET', '/v1/notifications\\webhooks'],
  ] as const)('%s %s is refused', async (method, path) => {
    const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
    await expect(client.request(method, path, method === 'POST' ? { json: {} } : {})).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('mutations only touch our own orders and disputes', () => {
  const orderBody = (custom: string) => ({ intent: 'CAPTURE', purchase_units: [{ custom_id: custom, amount: { currency_code: 'USD', value: '1.00' } }] });

  it('creates an order only when every purchase unit has a MIR- custom_id', async () => {
    const { fake, client } = makeClient();
    await client.request('POST', '/v2/checkout/orders', { json: orderBody('MIR-abc') });
    expect(fake.calls).toHaveLength(1);
    for (const bad of ['', 'LBL-1', 'mir-lower', 'xMIR-1']) {
      await expect(client.request('POST', '/v2/checkout/orders', { json: orderBody(bad) })).rejects.toBeInstanceOf(RefusedRequestError);
    }
    await expect(client.request('POST', '/v2/checkout/orders', { json: { intent: 'CAPTURE', purchase_units: [] } })).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(
      client.request('POST', '/v2/checkout/orders', { json: { purchase_units: [orderBody('MIR-ok').purchase_units[0], { amount: {} }] } }),
    ).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('POST', '/v2/checkout/orders', {})).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(1);
  });

  it('captures only an order that the store knows', async () => {
    const owns: Ownership = { order: (id) => id === 'ORDER1', dispute: () => false };
    const { fake, client } = makeClient(ok, { owns });
    await client.request('POST', '/v2/checkout/orders/ORDER1/capture', { json: {} });
    await expect(client.request('POST', '/v2/checkout/orders/ORDER2/capture', { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('PATCH', '/v2/checkout/orders/ORDER2', { json: [] })).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(1);
  });

  it('acts on a dispute only when the store knows it (offer, accept-claim, escalate, adjudicate, evidence)', async () => {
    const owns: Ownership = { order: () => false, dispute: async (id) => id === 'PP-R-MINE' };
    const { fake, client } = makeClient(ok, { owns });
    for (const action of ['make-offer', 'escalate', 'adjudicate']) {
      await client.request('POST', `/v1/customer/disputes/PP-R-MINE/${action}`, { json: {} });
      await expect(client.request('POST', `/v1/customer/disputes/PP-R-OTHER/${action}`, { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    }
    await client.request('POST', '/v1/customer/disputes/PP-R-MINE/accept-claim', { multipart: { input: { accept_claim_type: 'REFUND' } } });
    await expect(
      client.request('POST', '/v1/customer/disputes/PP-R-OTHER/provide-evidence', { multipart: { input: { evidences: [] } } }),
    ).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('PATCH', '/v1/customer/disputes/PP-R-OTHER', { json: [] })).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(4);
  });

  it('never creates a dispute and refuses any other mutation (deny by default)', async () => {
    const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
    await expect(client.request('POST', '/v1/customer/disputes', { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('POST', '/v2/payments/captures/CAP1/refund', { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('POST', '/v1/payments/payouts', { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(0);
  });

  it('allows reads of any order, capture, dispute or report', async () => {
    const { fake, client } = makeClient(ok, { owns: ownsNothing });
    await client.request('GET', '/v2/checkout/orders/ANY');
    await client.request('GET', '/v2/payments/captures/ANY');
    await client.request('GET', '/v1/customer/disputes/PP-R-ANY');
    await client.request('GET', '/v1/reporting/transactions', { query: { transaction_id: 'ANY' } });
    expect(fake.calls).toHaveLength(4);
  });

  it('refuses every mutation when no ownership check was given', async () => {
    const { fake, client } = makeClient();
    await expect(client.request('POST', '/v2/checkout/orders/ORDER1/capture', { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    await expect(client.request('POST', '/v1/customer/disputes/PP-R-1/escalate', { json: {} })).rejects.toBeInstanceOf(RefusedRequestError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('requests', () => {
  it('sends a JSON body with a content type and the idempotency header on POST', async () => {
    const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
    await client.request('POST', '/v2/checkout/orders/O1/capture', { json: {}, requestId: 'mir-capture-O1' });
    const call = fake.calls[0]!;
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['paypal-request-id']).toBe('mir-capture-O1');
    expect(call.headers['authorization']).toBe(`Bearer ${tokenFor('client-A')}`);
    expect(call.body).toBe('{}');
  });

  it('makes up a request id when none is given, and sends none on GET', async () => {
    const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
    await client.request('POST', '/v1/customer/disputes/PP-R-1/escalate', { json: { note: 'x' } });
    await client.request('POST', '/v1/customer/disputes/PP-R-1/escalate', { json: { note: 'x' } });
    await client.request('GET', '/v1/customer/disputes/PP-R-1');
    expect(fake.calls[0]!.headers['paypal-request-id']).toMatch(/^mir-[0-9a-f-]{20,}$/);
    expect(fake.calls[0]!.headers['paypal-request-id']).not.toBe(fake.calls[1]!.headers['paypal-request-id']);
    expect(fake.calls[2]!.headers['paypal-request-id']).toBeUndefined();
  });

  it('puts query values in the URL, encoded', async () => {
    const { fake, client } = makeClient();
    await client.request('GET', '/v1/customer/disputes', { query: { disputed_transaction_id: 'A B', page_size: '5' } });
    expect(fake.calls[0]!.search).toBe('?disputed_transaction_id=A+B&page_size=5');
  });

  it('builds multipart with the input part as plain JSON (no filename), the way PayPal expects it', async () => {
    const { fake, client } = makeClient(ok, { owns: { order: () => true, dispute: () => true } });
    await client.request('POST', '/v1/customer/disputes/PP-R-1/accept-claim', { multipart: { input: { note: 'ok', accept_claim_type: 'REFUND' } } });
    const call = fake.calls[0]!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(call.headers['content-type'] ?? '')?.[1];
    expect(boundary).toBeTruthy();
    expect(call.body).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n{"note":"ok","accept_claim_type":"REFUND"}\r\n--${boundary}--\r\n`);
    expect(call.body).not.toContain('filename=');
  });

  it('returns the parsed body, and an empty object for an empty answer', async () => {
    const { client } = makeClient((c) => (c.path.endsWith('/EMPTY') ? { status: 204 } : { body: { id: 7 } }));
    expect(await client.request('GET', '/v2/payments/captures/X')).toEqual({ id: 7 });
    expect(await client.request('GET', '/v2/payments/captures/EMPTY')).toEqual({});
  });
});

describe('errors', () => {
  it('turns a PayPal error answer into a PayPalError with status, name, issue and debug id', async () => {
    const { client } = makeClient(() => ({
      status: 400,
      headers: { 'paypal-debug-id': 'hdr123' },
      body: { name: 'INVALID_REQUEST', message: 'Request is not well-formed.', debug_id: 'body456', details: [{ issue: 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE' }] },
    }));
    const err = (await client.request('GET', '/v1/customer/disputes/X').catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(400);
    expect(err.paypalName).toBe('INVALID_REQUEST');
    expect(err.issue).toBe('ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE');
    expect(err.debugId).toBe('hdr123');
    expect(err.message).toContain('ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE');
  });

  it('reads the OAuth style error the spike got for a buyer assertion', async () => {
    const { client } = makeClient(() => ({ status: 400, body: { error: 'invalid_request', error_description: 'No permissions to set target_client_id' } }));
    const err = (await client.request('GET', '/v1/customer/disputes/X').catch((e) => e)) as PayPalError;
    expect(err.paypalName).toBe('invalid_request');
    expect(err.message).toContain('No permissions to set target_client_id');
    expect(err.issue).toBeNull();
  });

  it('turns a network failure into a PayPalError with status 0', async () => {
    const boom: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const client = new PayPalClient({ ...CREDS, fetch: boom });
    const err = (await client.request('GET', '/v2/payments/captures/X').catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(0);
  });
});

describe('call journal', () => {
  it('records method, path, status, duration and debug id, and nothing else', async () => {
    const entries: JournalEntry[] = [];
    let t = 5000;
    const { client } = makeClient(() => ({ status: 200, headers: { 'paypal-debug-id': 'dbg1' }, body: { payer: { email_address: 'someone@example.com' } } }), {
      journal: (e) => entries.push(e),
      clock: () => (t += 7),
    });
    await client.request('GET', '/v1/customer/disputes', { query: { disputed_transaction_id: 'CAP1' } });
    expect(entries).toHaveLength(2); // token call and the request
    expect(entries[0]).toMatchObject({ method: 'POST', path: '/v1/oauth2/token', status: 200 });
    expect(Object.keys(entries[1]!).sort()).toEqual(['debug_id', 'method', 'ms', 'path', 'status', 'ts']);
    expect(entries[1]).toMatchObject({ method: 'GET', path: '/v1/customer/disputes', status: 200, debug_id: 'dbg1' });
    const text = JSON.stringify(entries);
    for (const secret of [CREDS.clientSecret, CREDS.clientId, tokenFor(CREDS.clientId), 'someone@example.com', 'CAP1']) {
      expect(text).not.toContain(secret);
    }
  });

  it('does not fail a PayPal call that worked because the journal callback throws', async () => {
    const { fake, client } = makeClient(ok, { journal: () => { throw new Error('disk full'); }, owns: { order: () => true, dispute: () => true } });
    expect(await client.request('GET', '/v2/payments/captures/X')).toEqual({ ok: true });
    expect(await client.request('POST', '/v2/checkout/orders/O1/capture', { json: {} })).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(2);
  });

  it('also records failed calls', async () => {
    const entries: JournalEntry[] = [];
    const { client } = makeClient(() => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }), { journal: (e) => entries.push(e) });
    await client.request('GET', '/v2/checkout/orders/X').catch(() => undefined);
    expect(entries.at(-1)).toMatchObject({ method: 'GET', path: '/v2/checkout/orders/X', status: 422 });
  });
});
