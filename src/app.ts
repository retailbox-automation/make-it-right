// The HTTP API the screens call. JSON in, JSON out (photos and the estimate come back as the files they are); every error is {error: {code, message}}.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { DailyCaps } from './caps.js';
import type { PublicDemoConfig } from './config.js';
import { createDemoCopy, standInOfferAmount, type DemoTemplate } from './demo.js';
import { HttpError, invalid, notFound } from './errors.js';
import { PhotoCheckGate } from './gate.js';
import { maxBodyBytes, readIntake, sizeText, UPLOAD_LIMITS, type UploadLimits } from './intake.js';
import type { VisionModel } from './models/vision.js';
import { analyzeUpload } from './photocheck.js';
import type { CaseService } from './service.js';
import { PHOTO_NAME, type StoredUpload, type UploadStore } from './uploads.js';
import { registerWeb } from './web.js';

/** Biggest request body any /api route reads, except POST /api/cases/analyze (see maxBodyBytes in src/intake.ts) */
export const MAX_BODY_BYTES = 256 * 1024;

const ANALYZE_PATH = '/api/cases/analyze';

export interface AppOptions {
  log?: (message: string) => void;
  /** Where the uploaded estimate and photos of cases live; without it the photo and estimate routes answer 404 */
  uploads?: UploadStore;
  /** The model that reads the estimate and the photos; without it (or without uploads) POST /api/cases/analyze answers 503 */
  model?: VisionModel;
  /** Size limits of POST /api/cases/analyze; UPLOAD_LIMITS unless a test sets others */
  uploadLimits?: UploadLimits;
  /** One photo check at a time and a few per client; PhotoCheckGate with its usual settings unless a test sets another */
  gate?: PhotoCheckGate;
  /** A proxy in front of the server adds the client's address to X-Forwarded-For (the last entry is taken); otherwise the connection's address counts */
  trustForwardedFor?: boolean;
  /** The demo case's files; with them POST /api/demo/cases makes a copy of the demo case */
  demo?: DemoTemplate;
  /** The hosted demo: cases only from the demo template, within daily caps, and no photo check. Off unless given. */
  publicDemo?: PublicDemoConfig;
  /** The clock of the daily caps; tests set it */
  now?: () => Date;
}

const PUBLIC_ANALYZE_MESSAGE =
  'The hosted demo has no model: it replays the recorded analysis of the demo case by Gemma 4 31B (run locally on 2026-11-06). The live photo check runs when you run the app locally with a model.';

/** The JSON body, or undefined when there is none. Present but not JSON is a 400. */
async function body(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw invalid('the request body is not valid JSON');
  }
}

const tooLarge = (bytes: number) =>
  ({ error: { code: 'PAYLOAD_TOO_LARGE', message: `the request body is larger than ${bytes >= 1024 * 1024 ? sizeText(bytes) : `${bytes / 1024} KB`}` } }) as const;

function file(found: StoredUpload | null, what: string): Response {
  if (!found) throw notFound(what);
  return new Response(new Uint8Array(found.bytes), { headers: { 'content-type': found.contentType, 'content-length': String(found.bytes.length), 'x-content-type-options': 'nosniff' } });
}

export function createApp(service: CaseService, options: AppOptions = {}): Hono {
  const log = options.log ?? ((m: string) => console.error(m));
  const { uploads, model } = options;
  const limits = options.uploadLimits ?? UPLOAD_LIMITS;
  const app = new Hono();

  const isAnalyze = (method: string, path: string) => method === 'POST' && path === ANALYZE_PATH;
  const small = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(tooLarge(MAX_BODY_BYTES), 413) });
  const large = bodyLimit({ maxSize: maxBodyBytes(limits), onError: (c) => c.json(tooLarge(maxBodyBytes(limits)), 413) });

  const gate = options.gate ?? new PhotoCheckGate();
  const publicDemo = options.publicDemo ?? null;
  const caps = publicDemo ? new DailyCaps({ ...publicDemo, ...(options.now ? { now: options.now } : {}) }) : null;
  const clientOf = (c: Context): string => {
    const forwarded = options.trustForwardedFor ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
    return forwarded || (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || 'unknown';
  };

  // Answered before any of the body is read: a server without a model, or one that is busy, should not take 50 MB to say so.
  // The place in the gate is held until the answer is sent.
  app.use('/api/*', async (c, next) => {
    if (!isAnalyze(c.req.method, c.req.path)) return next();
    if (publicDemo) throw new HttpError(503, 'PHOTO_CHECK_NOT_ON_HOST', PUBLIC_ANALYZE_MESSAGE);
    if (!(model && uploads)) throw new HttpError(503, 'PHOTO_CHECK_NOT_CONFIGURED', 'the photo check is not configured on this server (MIR_VISION_MODEL is not set)');
    const leave = gate.enter(clientOf(c));
    try {
      await next();
    } finally {
      leave();
    }
  });
  app.use('/api/*', (c, next) => (isAnalyze(c.req.method, c.req.path) ? large(c, next) : small(c, next)));

  app.post(ANALYZE_PATH, async (c) => {
    const intake = await readIntake(c.req.raw, limits);
    // Everything in the request is copied into `intake`; do not keep up to 50 MB of request alive while the model works
    c.req.raw = new Request(c.req.url, { method: 'POST' });
    return c.json(await analyzeUpload({ service, model: model!, uploads: uploads!, log }, intake), 201);
  });
  app.post('/api/cases', async (c) => {
    if (publicDemo) {
      throw new HttpError(403, 'PUBLIC_DEMO', 'The hosted demo makes cases only from the recorded demo case: use the "Start with your PayPal sandbox account" button (POST /api/demo/cases). Your own punch list works when you run the app locally.');
    }
    return c.json(await service.createCase(await body(c.req.raw)), 201);
  });
  // A copy of the demo case, made on the server; the request may not carry items or amounts. Daily caps in the public demo.
  app.post('/api/demo/cases', async (c) => {
    if (!options.demo) throw notFound('the demo case');
    if ((await c.req.raw.text()).trim()) throw invalid('this request takes no body: the copy is made on the server from the recorded demo case');
    const giveBack = caps?.take(clientOf(c));
    try {
      return c.json(await createDemoCopy(service, options.demo), 201);
    } catch (error) {
      giveBack?.();
      throw error;
    }
  });
  app.get('/api/cases/:id', async (c) => c.json(await service.getCase(c.req.param('id'))));
  app.get('/api/cases/:id/photos/:name', async (c) => {
    const name = c.req.param('name');
    return file(PHOTO_NAME.test(name) ? ((await uploads?.read(c.req.param('id'), name)) ?? null) : null, 'photo');
  });
  app.get('/api/cases/:id/estimate', async (c) => file((await uploads?.readEstimate(c.req.param('id'))) ?? null, 'estimate'));
  app.post('/api/cases/:id/payment', async (c) => c.json(await service.startPayment(c.req.param('id'))));
  app.post('/api/cases/:id/capture', async (c) => c.json(await service.capture(c.req.param('id'))));
  app.get('/api/cases/:id/dispute', async (c) => c.json(await service.getDispute(c.req.param('id'))));
  app.post('/api/cases/:id/escalate', async (c) => c.json(await service.escalate(c.req.param('id'))));
  app.post('/api/cases/:id/adjudicate', async (c) => {
    const input = (await body(c.req.raw)) as { outcome?: unknown } | undefined;
    return c.json(await service.adjudicate(c.req.param('id'), input?.outcome));
  });
  app.post('/api/sim/contractor/:id/offer', async (c) => {
    const id = c.req.param('id');
    const requested = (((await body(c.req.raw)) ?? {}) as { amount?: unknown }).amount;
    // On a copy of the demo case the stand-in's amount is fixed on the server; the case is read only when that matters
    const template = publicDemo || requested === undefined ? (await service.getCase(id)).case.template : undefined;
    return c.json(await service.contractorOffer(id, { amount: standInOfferAmount({ publicDemo: publicDemo !== null, template, requested }) }));
  });
  app.post('/api/sim/contractor/:id/evidence', async (c) => c.json(await service.contractorEvidence(c.req.param('id'), ((await body(c.req.raw)) ?? {}) as { note?: unknown })));
  app.post('/api/sim/contractor/:id/accept-claim', async (c) => c.json(await service.contractorAcceptClaim(c.req.param('id'))));

  registerWeb(app, { service, log });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status, error.headers);
    log(`unexpected error on ${c.req.method} ${new URL(c.req.url).pathname}: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, 500);
  });
  return app;
}
