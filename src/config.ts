// Settings from the environment. The only place in the app, besides the entry point, that reads it.
export interface Config {
  port: number;
  dataDir: string;
  clientId: string;
  clientSecret: string;
  returnUrl: string;
  cancelUrl: string;
  /** null = the background poller is off */
  pollSeconds: number | null;
  /** null = no call journal */
  journalPath: string | null;
  /** null = the photo check is not set up and POST /api/cases/analyze answers 503 */
  vision: VisionConfig | null;
  /** The most the uploaded files of all cases may take on disk; analyses are refused beyond it */
  uploadQuotaBytes: number;
  /** One proxy stands in front of the server and adds the client's address to X-Forwarded-For; rate limits then count that address */
  trustForwardedFor: boolean;
  /** null = not the public demo; otherwise cases are made only from the demo template, within these daily caps */
  publicDemo: PublicDemoConfig | null;
}

export interface PublicDemoConfig {
  /** New demo cases one client address may start per day (UTC) */
  perAddressPerDay: number;
  /** New demo cases all clients together may start per day (UTC) */
  perDay: number;
  /** Steps that call PayPal (payment, capture, claim look-ups, offer, escalation, decision) one address may take per window */
  actionsPerAddress: number;
  actionsWindowMinutes: number;
  /** Refunds the app itself sets off (PayPal decides, the stand-in accepts the claim) per day (UTC), all clients together */
  refundsPerDay: number;
}

export interface VisionConfig {
  provider: 'ollama';
  /** The model's name in Ollama, for example "gemma4:31b" */
  model: string;
  baseUrl: string;
  /** Always sent to Ollama: its own default context window can be far larger than a job needs */
  numCtx: number;
}

type Env = Record<string, string | undefined>;

const MIN_POLL_SECONDS = 30;
const MIN_NUM_CTX = 1024;
const DEFAULT_QUOTA_MB = 2048;
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_NUM_CTX = 16384;
/** A panel of judges often shares one address, so the per-address cap is generous */
const DEFAULT_DEMO_PER_ADDRESS = 25;
const DEFAULT_DEMO_PER_DAY = 60;
const DEFAULT_DEMO_ACTIONS = 30;
const DEFAULT_DEMO_ACTIONS_WINDOW_MINUTES = 10;
/** The shared sandbox contractor's balance pays every refund; a few per day keep it from running dry */
const DEFAULT_DEMO_REFUNDS = 5;

/** MIR_VISION_MODEL=ollama:<model name> (with MIR_OLLAMA_URL and MIR_NUM_CTX); unset or empty = no photo check */
function loadVision(env: Env): VisionConfig | null {
  const spec = env.MIR_VISION_MODEL?.trim();
  if (!spec) return null;
  const model = /^ollama:(.+)$/.exec(spec)?.[1]?.trim();
  if (!model) throw new Error('MIR_VISION_MODEL must look like ollama:<model name>, for example ollama:gemma4:31b');

  const numCtx = env.MIR_NUM_CTX ? Number(env.MIR_NUM_CTX) : DEFAULT_NUM_CTX;
  if (!Number.isInteger(numCtx) || numCtx < MIN_NUM_CTX) throw new Error(`MIR_NUM_CTX must be a whole number, ${MIN_NUM_CTX} or more`);

  const baseUrl = env.MIR_OLLAMA_URL || DEFAULT_OLLAMA_URL;
  let parsed: URL | null = null;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // reported below, together with a wrong scheme
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) throw new Error('MIR_OLLAMA_URL must be an http or https address, for example http://localhost:11434');
  return { provider: 'ollama', model, baseUrl, numCtx };
}

/** MIR_UPLOADS_QUOTA_MB: megabytes the uploaded files of all cases may take, 2048 unless set */
function loadQuota(env: Env): number {
  if (!env.MIR_UPLOADS_QUOTA_MB) return DEFAULT_QUOTA_MB;
  const mb = Number(env.MIR_UPLOADS_QUOTA_MB);
  if (!Number.isInteger(mb) || mb < 1) throw new Error('MIR_UPLOADS_QUOTA_MB must be a whole number of megabytes, 1 or more');
  return mb;
}

function wholeAtLeastOne(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number, 1 or more`);
  return n;
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * MIR_PUBLIC_DEMO=1 (or true): the hosted demo. It needs the addresses PayPal sends the homeowner back to and the claim poller;
 * without them a judge would pay and land nowhere, or file a claim the app never finds, so the start fails instead.
 */
function loadPublicDemo(env: Env, pollSeconds: number | null): PublicDemoConfig | null {
  if (env.MIR_PUBLIC_DEMO !== '1' && env.MIR_PUBLIC_DEMO !== 'true') return null;
  for (const name of ['MIR_RETURN_URL', 'MIR_CANCEL_URL']) {
    const value = env[name];
    if (!value || !isWebAddress(value)) throw new Error(`MIR_PUBLIC_DEMO needs ${name}: the public http(s) address of /paypal/${name === 'MIR_RETURN_URL' ? 'return' : 'cancel'}`);
  }
  if (pollSeconds === null) throw new Error('MIR_PUBLIC_DEMO needs MIR_POLL_SECONDS, so filed claims are found without anyone asking');
  return {
    perAddressPerDay: wholeAtLeastOne(env, 'MIR_DEMO_CASES_PER_ADDRESS_PER_DAY', DEFAULT_DEMO_PER_ADDRESS),
    perDay: wholeAtLeastOne(env, 'MIR_DEMO_CASES_PER_DAY', DEFAULT_DEMO_PER_DAY),
    actionsPerAddress: wholeAtLeastOne(env, 'MIR_DEMO_ACTIONS_PER_ADDRESS', DEFAULT_DEMO_ACTIONS),
    actionsWindowMinutes: wholeAtLeastOne(env, 'MIR_DEMO_ACTIONS_WINDOW_MINUTES', DEFAULT_DEMO_ACTIONS_WINDOW_MINUTES),
    refundsPerDay: wholeAtLeastOne(env, 'MIR_DEMO_REFUNDS_PER_DAY', DEFAULT_DEMO_REFUNDS),
  };
}

export function loadConfig(env: Env): Config {
  const missing = ['PAYPAL_SANDBOX_CLIENT_ID', 'PAYPAL_SANDBOX_CLIENT_SECRET'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing environment: ${missing.join(', ')}`);

  const port = env.PORT ? Number(env.PORT) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a whole number from 0 (any free port) to 65535');

  let pollSeconds: number | null = null;
  if (env.MIR_POLL_SECONDS) {
    pollSeconds = Number(env.MIR_POLL_SECONDS);
    if (!Number.isInteger(pollSeconds) || pollSeconds < MIN_POLL_SECONDS) throw new Error(`MIR_POLL_SECONDS must be a whole number, ${MIN_POLL_SECONDS} or more`);
  }

  return {
    port,
    dataDir: env.MIR_DATA_DIR || './data',
    clientId: env.PAYPAL_SANDBOX_CLIENT_ID!,
    clientSecret: env.PAYPAL_SANDBOX_CLIENT_SECRET!,
    returnUrl: env.MIR_RETURN_URL || `http://localhost:${port}/paypal/return`,
    cancelUrl: env.MIR_CANCEL_URL || `http://localhost:${port}/paypal/cancel`,
    pollSeconds,
    journalPath: env.MIR_CALL_JOURNAL || null,
    vision: loadVision(env),
    uploadQuotaBytes: loadQuota(env) * 1024 * 1024,
    trustForwardedFor: env.MIR_TRUST_FORWARDED_FOR === '1' || env.MIR_TRUST_FORWARDED_FOR === 'true',
    publicDemo: loadPublicDemo(env, pollSeconds),
  };
}
