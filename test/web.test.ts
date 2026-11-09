import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEMO_DIR, loadDemo, seedWalkthrough, WALKTHROUGH_ID } from '../src/demo.js';
import { Tracker } from '../src/disputes/tracker.js';
import { KeyedLock } from '../src/lock.js';
import { CaseService } from '../src/service.js';
import { noticePage } from '../src/web.js';
import { ORDER_ID, makeWorld, type World } from './helpers/world.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const demo = loadDemo();
let world: World;
let service: CaseService;
let app: Hono;

beforeEach(async () => {
  world = makeWorld();
  const locks = new KeyedLock();
  let n = 0;
  service = new CaseService({
    store: world.store, paypal: world.client, tracker: new Tracker({ store: world.store, paypal: world.client, locks }), locks,
    newId: () => `copy${++n}`,
    urls: { returnUrl: 'https://demo.example/paypal/return', cancelUrl: 'https://demo.example/paypal/cancel' },
  });
  await seedWalkthrough(service, demo);
  app = createApp(service, { log: () => undefined, demo });
});

const json = async (res: Response) => (await res.json()) as any;
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

async function paidCopyPending(): Promise<string> {
  const { case: made } = await json(await app.request('/api/demo/cases', { method: 'POST' }));
  expect((await app.request(`/api/cases/${made.id}/payment`, { method: 'POST' })).status).toBe(200);
  return made.id;
}

describe('pages', () => {
  it.each([
    ['/', 'landing'],
    [`/cases/${WALKTHROUGH_ID}`, 'promised'],
    [`/cases/${WALKTHROUGH_ID}/claim`, 'claim'],
    [`/cases/${WALKTHROUGH_ID}/offer`, 'offer'],
    [`/cases/${WALKTHROUGH_ID}/money-back`, 'money-back'],
    ['/cases/any-other-id/claim', 'claim'],
  ])('GET %s is the %s page, in HTML, with our script only', async (path, screen) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain(`data-screen="${screen}"`);
    expect(html).toContain('<script type="module" src="/web/screens.js"></script>');
  });

  it('answers 404 for a screen that does not exist or an id that cannot be a case', async () => {
    expect((await app.request(`/cases/${WALKTHROUGH_ID}/elsewhere`)).status).toBe(404);
    expect((await app.request('/cases/no%20spaces/claim')).status).toBe(404);
    expect((await app.request('/index.html')).status).toBe(404);
  });

  it('serves the script and the source icons, and nothing outside web/', async () => {
    const script = await app.request('/web/screens.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe(readFileSync(join(ROOT, 'web/screens.js'), 'utf8'));
    const icon = await app.request('/web/assets/source-estimate.png');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    for (const path of ['/web/claim.html', '/web/%2E%2E%2Fpackage.json', '/web/..%2Fsrc%2Fapp.ts', '/web/assets/..%2F..%2Fpackage.json', '/web/missing.js']) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });

  it('serves the demo photos byte for byte, and the files the model read, but not the evaluation truth', async () => {
    for (const n of [1, 4, 6]) {
      const res = await app.request(`/demo/ridgeway/photos/photo-${n}.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect((await bytes(res)).equals(readFileSync(join(DEMO_DIR, 'photos', `photo-${n}.png`)))).toBe(true);
    }
    const recorded = await app.request('/demo/ridgeway/recorded-analysis.json');
    expect(recorded.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect((await bytes(recorded)).equals(readFileSync(join(DEMO_DIR, 'recorded-analysis.json')))).toBe(true);
    expect((await app.request('/demo/ridgeway/estimate.pdf')).headers.get('content-type')).toBe('application/pdf');
    expect((await app.request('/demo/ridgeway/PROVENANCE.md')).status).toBe(200);
    for (const path of ['/demo/ridgeway/truth.json', '/demo/ridgeway/photos/photo-9.png', '/demo/other/photos/photo-1.png', '/demo/ridgeway/photos/..%2Fpayment.json']) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });

  it('GET /healthz answers ok without asking PayPal', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(world.fake.calls).toEqual([]);
    expect(world.fake.tokenCalls).toEqual([]);
  });

  it('keeps every API route as it was: unknown routes still answer 404 in JSON', async () => {
    const res = await app.request('/api/nothing-here');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
  });
});

describe('the way back from PayPal', () => {
  it('takes the money when the homeowner returns, then shows the claim screen', async () => {
    const id = await paidCopyPending();
    const res = await app.request(`/paypal/return?token=${ORDER_ID}&PayerID=TESTPAYER`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/cases/${id}/claim`);
    const view = await json(await app.request(`/api/cases/${id}`));
    expect(view.case.payment).toMatchObject({ status: 'captured', capture_status: 'COMPLETED' });
    expect(view.claim.amount).toBe('2650.00');

    // A second visit (reload, back button) does not capture again
    const captures = () => world.fake.calls.filter((c) => c.path.endsWith('/capture')).length;
    expect(captures()).toBe(1);
    expect((await app.request(`/paypal/return?token=${ORDER_ID}`)).status).toBe(303);
    expect(captures()).toBe(1);
  });

  it('says so in plain words when PayPal has not approved the payment', async () => {
    const id = await paidCopyPending();
    world.approved = false;
    const res = await app.request(`/paypal/return?token=${ORDER_ID}`);
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('The payment is not complete');
    expect(html).toContain('has not approved the payment on PayPal yet');
    expect(html).toContain(`href="/cases/${id}/claim"`);
  });

  it('answers a link without a payment id, or with one no case knows, without asking PayPal', async () => {
    const missing = await app.request('/paypal/return');
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('This link is not complete');
    const unknown = await app.request('/paypal/return?token=NOSUCHORDER1');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('Payment not found');
    expect((await app.request('/paypal/return?token=%3Cscript%3E')).status).toBe(400);
    expect(world.fake.calls).toEqual([]);
  });

  it('cancel: says nothing was paid and links back to the case, without asking PayPal', async () => {
    const id = await paidCopyPending();
    const calls = world.fake.calls.length;
    const res = await app.request(`/paypal/cancel?token=${ORDER_ID}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Payment canceled');
    expect(html).toContain('no money moved');
    expect(html).toContain(`href="/cases/${id}/claim"`);
    expect(world.fake.calls.length).toBe(calls);
    expect((await json(await app.request(`/api/cases/${id}`))).case.payment.status).toBe('created');

    const bare = await (await app.request('/paypal/cancel')).text();
    expect(bare).toContain('href="/"');
    expect(bare).not.toContain('/cases/');
  });

  it('escapes whatever goes into a notice page', () => {
    const html = noticePage('<b>x</b>', 'say "<script>alert(1)</script>"', [{ href: '/x?a=1&b="2"', text: '<i>' }]);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&#60;script&#62;');
    expect(html).toContain('href="/x?a=1&#38;b=&#34;2&#34;"');
  });
});

describe('the HTML of the screens', () => {
  // Values the reference screens show for the demo; none may survive in the app's pages, the data fills them
  const DEMO_VALUES = ['$3,700', '$2,650', '$1,050', '$1,200', '$1,300', '$720', '$650', '$460', '$310', '$260', '$240', '$480', '$1,450', 'Ridgeway', 'Sep 9', 'Sep 10', 'Sep 12', 'Nov 4', 'Nov 5', 'Nov 8', 'GFCI', 'Main panel', 'Flood lights', 'EV charger', 'EV circuit', 'Recessed', 'Ceiling fan', '4 of 6', '>53<'];
  const pages = (dir: string) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html')).map((f) => join(ROOT, dir, f));
  const found = (file: string) => DEMO_VALUES.filter((value) => readFileSync(file, 'utf8').includes(value));

  it('the check sees the demo values in every reference screen (it can find them)', () => {
    const references = pages('design/screens');
    expect(references).toHaveLength(4);
    for (const file of references) expect(found(file).length, file).toBeGreaterThan(3);
  });

  it('no demo value is written into the app\'s pages', () => {
    const own = pages('web');
    expect(own.map((f) => f.slice(f.lastIndexOf('/') + 1)).sort()).toEqual(['claim.html', 'index.html', 'money-back.html', 'offer.html', 'promised.html']);
    for (const file of own) expect(found(file), file).toEqual([]);
  });

  it('every screen has the place for the line about the recorded photo check', () => {
    for (const name of ['promised', 'claim', 'offer', 'money-back']) {
      expect(readFileSync(join(ROOT, 'web', `${name}.html`), 'utf8'), name).toMatch(/<p class="provenance" data-field="analysis_note" hidden><\/p>/);
    }
  });
});
