// Entry point: reads the environment, wires the pieces together and listens.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { RefundCap } from './caps.js';
import { loadConfig } from './config.js';
import { loadDemo, seedWalkthrough, WALKTHROUGH_ID, type DemoTemplate } from './demo.js';
import { Tracker, startPoller } from './disputes/tracker.js';
import { openJournal, type Journal } from './journal.js';
import { KeyedLock } from './lock.js';
import { OllamaVisionModel } from './models/ollama.js';
import { ownershipFrom } from './ownership.js';
import { PayPalClient } from './paypal/client.js';
import { CaseService } from './service.js';
import { PgliteStore } from './store.js';
import { UploadStore } from './uploads.js';

/** How long "no claim filed yet" is remembered per case in the public demo */
export const NO_CLAIM_MEMORY_MS = 30_000;

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

export interface StartDeps {
  /** Tests give a fake PayPal; the real run uses the global fetch */
  fetch?: typeof fetch;
  /** Tests give a fake Ollama; the real run uses the global fetch */
  modelFetch?: typeof fetch;
  /** The demo case's files; read from demo/ridgeway/ unless a test gives others */
  demo?: DemoTemplate;
  log?: (message: string) => void;
}

export async function start(env: Record<string, string | undefined> = process.env, deps: StartDeps = {}): Promise<RunningServer> {
  const config = loadConfig(env);
  const log = deps.log ?? ((m: string) => console.error(m));

  // The demo files are read first and the journal file is opened next: a broken demo or a bad path stops the start before anything else is opened.
  const demo = deps.demo ?? loadDemo();
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
    const service = new CaseService({
      store, paypal, tracker, locks, urls: { returnUrl: config.returnUrl, cancelUrl: config.cancelUrl }, log,
      // In the public demo repeated clicks before the claim is filed do not each ask PayPal for the list of claims,
      // and steps that can refund the homeowner from the shared sandbox contractor are capped per day
      ...(config.publicDemo ? { noClaimMemoryMs: NO_CLAIM_MEMORY_MS, refunds: new RefundCap(store, config.publicDemo.refundsPerDay) } : {}),
    });
    const vision = config.vision;
    const model = vision
      ? new OllamaVisionModel({ model: vision.model, baseUrl: vision.baseUrl, numCtx: vision.numCtx, ...(deps.modelFetch ? { fetch: deps.modelFetch } : {}) })
      : undefined;
    // The uploads are kept beside the cases, in the data directory. What an interrupted run left there is cleared before the first request.
    const uploads = new UploadStore(join(config.dataDir, 'uploads'), config.uploadQuotaBytes);
    const openStore = store;
    const removed = await uploads.sweep(async (caseId) => (await openStore.get(caseId)) !== undefined);
    if (removed.length) log(`removed leftover upload directories: ${removed.join(', ')}`);
    const seeded = await seedWalkthrough(service, demo);
    log(`walkthrough case ${WALKTHROUGH_ID}: ${seeded.changed ? 'stored' : 'unchanged'}`);
    const demoLimits = config.publicDemo;
    if (demoLimits) {
      log(
        `public demo: new demo cases at most ${demoLimits.perAddressPerDay} per address and ${demoLimits.perDay} in all per day; ` +
          `${demoLimits.actionsPerAddress} PayPal steps per address per ${demoLimits.actionsWindowMinutes} minutes; ${demoLimits.refundsPerDay} refunds per day`,
      );
    }
    const app = createApp(service, {
      log,
      uploads,
      demo,
      trustForwardedFor: config.trustForwardedFor,
      ...(model ? { model } : {}),
      ...(demoLimits ? { publicDemo: demoLimits } : {}),
    });

    poller = config.pollSeconds
      ? startPoller(() => tracker.tickOpenCases(), config.pollSeconds * 1000, (e) => log(`poller: ${e instanceof Error ? e.message : String(e)}`))
      : null;

    const listening = serve({ fetch: app.fetch, port: config.port });
    server = listening;
    const port = await new Promise<number>((resolve, reject) => {
      listening.once('error', reject);
      listening.once('listening', () => resolve((listening.address() as { port: number }).port));
    });

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
    (running) => console.error(`Make It Right (PayPal sandbox) listening on port ${running.port}`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
