// A fake PayPal for unit tests: no network. It answers the OAuth call itself and hands every other call to a route function.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Call {
  method: string;
  url: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  /** Text of a JSON or form body; multipart bodies are decoded as text too */
  body: string;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = (call: Call) => FakeResponse | undefined | Promise<FakeResponse | undefined>;

export interface FakePayPal {
  fetch: typeof fetch;
  /** Every call except the OAuth token request */
  calls: Call[];
  tokenCalls: Call[];
  /** Replace the route function (for tests that change PayPal's answers over time) */
  setRoute(route: Route): void;
}

/** client id → token handed out, so tests can tell whose token a call carried */
export function tokenFor(clientId: string): string {
  return `tok-${clientId}`;
}

export function fakePayPal(initialRoute: Route = () => undefined, opts: { tokenTtlSeconds?: number } = {}): FakePayPal {
  let route = initialRoute;
  const calls: Call[] = [];
  const tokenCalls: Call[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const raw = init?.body;
    const body = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
    const call: Call = { method: (init?.method ?? 'GET').toUpperCase(), url: url.href, path: url.pathname, search: url.search, headers, body };
    if (call.method === 'POST' && call.path === '/v1/oauth2/token') {
      tokenCalls.push(call);
      const basic = Buffer.from((headers['authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString('utf8');
      const clientId = basic.split(':')[0] ?? '';
      return json(200, { access_token: tokenFor(clientId), token_type: 'Bearer', expires_in: opts.tokenTtlSeconds ?? 32_400 }, {});
    }
    calls.push(call);
    const answer = (await route(call)) ?? { status: 404, body: { name: 'RESOURCE_NOT_FOUND', message: `no fake route for ${call.method} ${call.path}` } };
    return json(answer.status ?? 200, answer.body ?? {}, answer.headers ?? {});
  };
  return { fetch: fakeFetch as typeof fetch, calls, tokenCalls, setRoute: (r) => (route = r) };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const FIXTURES = fileURLToPath(new URL('../fixtures/paypal/', import.meta.url));

/** A real (scrubbed) PayPal sandbox response recorded in the 31 Oct 2026 spike */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as T;
}
