// A small PayPal REST client for the SANDBOX only. One instance = one set of credentials = one token.
// It reads no environment variables and keeps no module-level state: whoever builds it passes everything in.
import { randomUUID } from 'node:crypto';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

/** Hold ids that belong to another project sharing this PayPal app. Never touched, never mentioned in a request. */
export const FOREIGN_HOLD_IDS: readonly string[] = ['4RR33540BR8604004', '5YP64371F43512053', '1CM060836C119894N', '1Y214495HX657682L'];

/** Every order we create carries a custom_id that starts with this. */
export const CUSTOM_ID_PREFIX = 'MIR-';

const TOKEN_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export type Method = 'GET' | 'POST' | 'PATCH';

/** PayPal answered with an error, or did not answer (status 0). */
export class PayPalError extends Error {
  readonly status: number;
  readonly paypalName: string | null;
  readonly issue: string | null;
  readonly debugId: string | null;
  constructor(init: { status: number; paypalName: string | null; issue: string | null; debugId: string | null; message: string }) {
    super(init.message);
    this.name = 'PayPalError';
    this.status = init.status;
    this.paypalName = init.paypalName;
    this.issue = init.issue;
    this.debugId = init.debugId;
  }
}

/** One of our own guards stopped the request before it left the process. */
export class RefusedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedRequestError';
  }
}

type MaybePromise<T> = T | Promise<T>;

/** Which orders and disputes belong to a case in our store. Mutations are allowed on those only. */
export interface Ownership {
  order(id: string): MaybePromise<boolean>;
  dispute(id: string): MaybePromise<boolean>;
}

export interface JournalEntry {
  ts: string;
  method: string;
  /** Path without the query string */
  path: string;
  status: number;
  ms: number;
  debug_id: string | null;
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Only the sandbox URL is accepted; anything else throws */
  baseUrl?: string;
  fetch?: typeof fetch;
  owns?: Ownership;
  journal?: (entry: JournalEntry) => void;
  /** Milliseconds since the epoch; tests replace it */
  clock?: () => number;
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string>;
  json?: unknown;
  /** A multipart body whose only part is `input`, a JSON document (the shape PayPal's dispute actions take) */
  multipart?: { input: unknown };
  /** Idempotency key for POST; made up when absent */
  requestId?: string;
}

interface Token {
  value: string;
  expiresAt: number;
}

export class PayPalClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly base: URL;
  private readonly doFetch: typeof fetch;
  private readonly owns: Ownership;
  private readonly journal: ((entry: JournalEntry) => void) | undefined;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private token: Token | null = null;
  private tokenInFlight: Promise<Token> | null = null;

  constructor(options: PayPalClientOptions) {
    if (!options.clientId) throw new Error('PayPalClient needs a client id');
    if (!options.clientSecret) throw new Error('PayPalClient needs a client secret');
    const baseUrl = (options.baseUrl ?? SANDBOX_BASE_URL).replace(/\/$/, '');
    if (baseUrl !== SANDBOX_BASE_URL) throw new Error(`PayPalClient talks to the sandbox only (${SANDBOX_BASE_URL})`);
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.base = new URL(SANDBOX_BASE_URL);
    this.doFetch = options.fetch ?? fetch;
    this.owns = options.owns ?? { order: () => false, dispute: () => false };
    this.journal = options.journal;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T = any>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.resolve(path);
    const bodyText = options.multipart ? JSON.stringify(options.multipart.input) : options.json === undefined ? '' : JSON.stringify(options.json);
    guardRequest(url, options.query, bodyText);
    if (method !== 'GET') await this.assertMutationAllowed(url.pathname, options);

    const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
    const headers: Record<string, string> = { authorization: `Bearer ${(await this.getToken()).value}` };
    let body: string | undefined;
    if (options.multipart) {
      const boundary = `mir${randomUUID().replace(/-/g, '')}`;
      body = `--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n${bodyText}\r\n--${boundary}--\r\n`;
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (options.json !== undefined) {
      body = bodyText;
      headers['content-type'] = 'application/json';
    }
    if (method !== 'GET') headers['paypal-request-id'] = options.requestId ?? `mir-${randomUUID()}`;

    const { status, parsed, debugId } = await this.send(method, `${url.origin}${url.pathname}${search}`, url.pathname, { headers, body });
    if (status >= 400) throw toPayPalError(status, parsed, debugId);
    return parsed as T;
  }

  private resolve(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)) throw new RefusedRequestError(`not a plain sandbox path: ${path}`);
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new RefusedRequestError('path leaves the sandbox host');
    return url;
  }

  private async assertMutationAllowed(pathname: string, options: RequestOptions): Promise<void> {
    if (pathname === '/v2/checkout/orders') {
      const units = (options.json as { purchase_units?: unknown } | undefined)?.purchase_units;
      const ours =
        Array.isArray(units) && units.length > 0 && units.every((u) => typeof (u as { custom_id?: unknown })?.custom_id === 'string' && (u as { custom_id: string }).custom_id.startsWith(CUSTOM_ID_PREFIX));
      if (!ours) throw new RefusedRequestError(`an order needs a custom_id that starts with ${CUSTOM_ID_PREFIX} on every purchase unit`);
      return;
    }
    const order = /^\/v2\/checkout\/orders\/([A-Za-z0-9]+)(\/[A-Za-z-]+)?$/.exec(pathname);
    if (order) {
      if (await this.owns.order(order[1]!)) return;
      throw new RefusedRequestError(`order ${order[1]} does not belong to a case in our store`);
    }
    const dispute = /^\/v1\/customer\/disputes\/([A-Za-z0-9-]+)(\/[a-z-]+)?$/.exec(pathname);
    if (dispute) {
      if (await this.owns.dispute(dispute[1]!)) return;
      throw new RefusedRequestError(`dispute ${dispute[1]} does not belong to a case in our store`);
    }
    throw new RefusedRequestError(`mutating ${pathname} is not allowed`);
  }

  private async send(method: string, url: string, journalPath: string, init: { headers: Record<string, string>; body?: string | undefined }) {
    const started = this.clock();
    let response: Response;
    try {
      response = await this.doFetch(url, { method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      this.record(method, journalPath, 0, started, null);
      throw new PayPalError({ status: 0, paypalName: 'NETWORK_ERROR', issue: null, debugId: null, message: `${method} ${journalPath}: ${error instanceof Error ? error.message : 'request failed'}` });
    }
    const debugId = response.headers.get('paypal-debug-id');
    const text = await response.text();
    this.record(method, journalPath, response.status, started, debugId);
    if (response.status === 401 && journalPath !== '/v1/oauth2/token') this.token = null;
    return { status: response.status, parsed: parseBody(text), debugId };
  }

  private record(method: string, path: string, status: number, started: number, debugId: string | null): void {
    const now = this.clock();
    this.journal?.({ ts: new Date(now).toISOString(), method, path, status, ms: now - started, debug_id: debugId });
  }

  private async getToken(): Promise<Token> {
    if (this.token && this.clock() < this.token.expiresAt - TOKEN_SAFETY_MARGIN_MS) return this.token;
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    this.token = await this.tokenInFlight;
    return this.token;
  }

  private async fetchToken(): Promise<Token> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const { status, parsed, debugId } = await this.send('POST', `${SANDBOX_BASE_URL}/v1/oauth2/token`, '/v1/oauth2/token', {
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const answer = parsed as { access_token?: unknown; expires_in?: unknown };
    if (status >= 400 || typeof answer.access_token !== 'string') {
      const err = toPayPalError(status, parsed, debugId);
      throw new PayPalError({ status, paypalName: err.paypalName, issue: err.issue, debugId, message: `OAuth token request failed (${status}${err.paypalName ? ` ${err.paypalName}` : ''})` });
    }
    const ttl = typeof answer.expires_in === 'number' ? answer.expires_in : 300;
    return { value: answer.access_token, expiresAt: this.clock() + ttl * 1000 };
  }
}

/** Checks that need no state: foreign hold ids and webhooks. Throws before anything is sent. */
function guardRequest(url: URL, query: Record<string, string> | undefined, bodyText: string): void {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new RefusedRequestError('malformed path');
  }
  if (decodedPath.toLowerCase().startsWith('/v1/notifications/webhooks')) {
    throw new RefusedRequestError('webhooks are shared with another project; we only poll');
  }
  const haystack = `${decodedPath} ${query ? Object.entries(query).flat().join(' ') : ''} ${bodyText}`.toLowerCase();
  for (const id of FOREIGN_HOLD_IDS) {
    if (haystack.includes(id.toLowerCase())) throw new RefusedRequestError(`${id} belongs to another project`);
  }
}

function parseBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _text: text.slice(0, 500) };
  }
}

function toPayPalError(status: number, parsed: unknown, debugIdHeader: string | null): PayPalError {
  const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const paypalName = typeof body.name === 'string' ? body.name : typeof body.error === 'string' ? body.error : null;
  const details = Array.isArray(body.details) ? (body.details as Array<Record<string, unknown>>) : [];
  const issue = typeof details[0]?.issue === 'string' ? details[0].issue : null;
  const text = typeof body.message === 'string' ? body.message : typeof body.error_description === 'string' ? body.error_description : typeof body._text === 'string' ? body._text : 'no message';
  const debugId = debugIdHeader ?? (typeof body.debug_id === 'string' ? body.debug_id : null);
  const parts = [`PayPal ${status}`, paypalName, issue].filter(Boolean).join(' ');
  return new PayPalError({ status, paypalName, issue, debugId, message: `${parts}: ${text}${debugId ? ` (debug id ${debugId})` : ''}` });
}
