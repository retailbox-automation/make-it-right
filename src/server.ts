// Entry point: reads the environment, wires the pieces together and listens.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Tracker, startPoller } from './disputes/tracker.js';
import { KeyedLock } from './lock.js';
import { ownershipFrom } from './ownership.js';
import { PayPalClient } from './paypal/client.js';
import { CaseService } from './service.js';
import { PgliteStore } from './store.js';

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

export interface StartDeps {
  /** Tests give a fake PayPal; the real run uses the global fetch */
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export async function start(env: Record<string, string | undefined> = process.env, deps: StartDeps = {}): Promise<RunningServer> {
  const config = loadConfig(env);
  const log = deps.log ?? ((m: string) => console.error(m));

  const store = await PgliteStore.open(config.dataDir);
  const locks = new KeyedLock();
  const journalPath = config.journalPath;
  const paypal = new PayPalClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    owns: ownershipFrom(store),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(journalPath ? { journal: (entry) => appendFileSync(journalPath, `${JSON.stringify(entry)}\n`) } : {}),
  });
  const tracker = new Tracker({ store, paypal, locks, log });
  const service = new CaseService({ store, paypal, tracker, locks, urls: { returnUrl: config.returnUrl, cancelUrl: config.cancelUrl }, log });
  const app = createApp(service, { log });

  const poller = config.pollSeconds
    ? startPoller(() => tracker.tickOpenCases(), config.pollSeconds * 1000, (e) => log(`poller: ${e instanceof Error ? e.message : String(e)}`))
    : null;

  let server!: ReturnType<typeof serve>;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: config.port }, (info) => resolve(info.port));
  });
  let stopped = false;
  return {
    port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      poller?.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      await store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(
    (running) => console.error(`Make It Right API (PayPal sandbox) listening on port ${running.port}`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
