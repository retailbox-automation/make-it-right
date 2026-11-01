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
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_NUM_CTX = 16384;

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
  };
}
