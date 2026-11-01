// Entry point: reads the environment, wires the pieces together and listens.
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Tracker, startPoller } from './disputes/tracker.js';
import { openJournal, type Journal } from './journal.js';
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

  // The journal file is opened first: a bad path stops the start before anything else is opened.
  const journal: Journal | null = config.journalPath ? openJournal(config.journalPath, log) : null;
  let store: PgliteStore | null = null;
  let server: ReturnType<typeof serve> | null = null;
  let poller: { stop(): Promise<void> } | null = null;
  try {
    store = await PgliteStore.open(config.dataDir);
    const locks = new KeyedLock();
    const paypal = new PayPalClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      owns: ownershipFrom(store),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(journal ? { journal: (entry) => journal.write(entry) } : {}),
    });
    const tracker = new Tracker({ store, paypal, locks, log });
    const service = new CaseService({ store, paypal, tracker, locks, urls: { returnUrl: config.returnUrl, cancelUrl: config.cancelUrl }, log });
    const app = createApp(service, { log });

    poller = config.pollSeconds
      ? startPoller(() => tracker.tickOpenCases(), config.pollSeconds * 1000, (e) => log(`poller: ${e instanceof Error ? e.message : String(e)}`))
      : null;

    const listening = serve({ fetch: app.fetch, port: config.port });
    server = listening;
    const port = await new Promise<number>((resolve, reject) => {
      listening.once('error', reject);
      listening.once('listening', () => resolve((listening.address() as { port: number }).port));
    });

    const openStore = store;
    let stopped = false;
    return {
      port,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await poller?.stop(); // a tick in flight finishes before the database closes
        await new Promise<void>((resolve) => {
          listening.close(() => resolve());
          if ('closeAllConnections' in listening) listening.closeAllConnections();
        });
        await openStore.close();
        journal?.close();
      },
    };
  } catch (error) {
    await poller?.stop();
    server?.close();
    await store?.close();
    journal?.close();
    throw error;
  }
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
