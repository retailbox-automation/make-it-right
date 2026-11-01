// The HTTP API the screens call. JSON in, JSON out; every error is {error: {code, message}}.
import { Hono } from 'hono';
import { HttpError, invalid } from './errors.js';
import type { CaseService } from './service.js';

export interface AppOptions {
  log?: (message: string) => void;
}

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

export function createApp(service: CaseService, options: AppOptions = {}): Hono {
  const log = options.log ?? ((m: string) => console.error(m));
  const app = new Hono();

  app.post('/api/cases', async (c) => c.json(await service.createCase(await body(c.req.raw)), 201));
  app.get('/api/cases/:id', async (c) => c.json(await service.getCase(c.req.param('id'))));
  app.post('/api/cases/:id/payment', async (c) => c.json(await service.startPayment(c.req.param('id'))));
  app.post('/api/cases/:id/capture', async (c) => c.json(await service.capture(c.req.param('id'))));
  app.get('/api/cases/:id/dispute', async (c) => c.json(await service.getDispute(c.req.param('id'))));
  app.post('/api/cases/:id/escalate', async (c) => c.json(await service.escalate(c.req.param('id'))));
  app.post('/api/cases/:id/adjudicate', async (c) => {
    const input = (await body(c.req.raw)) as { outcome?: unknown } | undefined;
    return c.json(await service.adjudicate(c.req.param('id'), input?.outcome));
  });
  app.post('/api/sim/contractor/:id/offer', async (c) => c.json(await service.contractorOffer(c.req.param('id'), ((await body(c.req.raw)) ?? {}) as { amount?: unknown })));
  app.post('/api/sim/contractor/:id/accept-claim', async (c) => c.json(await service.contractorAcceptClaim(c.req.param('id'))));

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    log(`unexpected error on ${c.req.method} ${new URL(c.req.url).pathname}: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, 500);
  });
  return app;
}
