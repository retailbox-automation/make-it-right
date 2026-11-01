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
}

type Env = Record<string, string | undefined>;

const MIN_POLL_SECONDS = 30;

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
  };
}
