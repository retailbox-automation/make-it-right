// The web side of the app: the four screens and the start page (static HTML filled by web/screens.js from the API),
// the demo case's files, the pages PayPal sends the homeowner back to, and a health check for the host.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { DEMO_DIR, DEMO_TEMPLATE } from './demo.js';
import { HttpError, notFound } from './errors.js';
import type { CaseService } from './service.js';
import { PHOTO_NAME } from './uploads.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** PayPal's order ids, as PayPal sends them back in `token` */
const ORDER_ID = /^[A-Za-z0-9-]{1,64}$/;

const SCREENS: Record<string, string> = { '': 'promised.html', claim: 'claim.html', offer: 'offer.html', 'money-back': 'money-back.html' };
/** The screen copies of the demo photos: demo/<template>/screen/photo-N.jpg */
const SCREEN_PHOTO = /^photo-\d{1,2}\.jpg$/;
/** The demo files anyone may read: the inputs the model read, its recorded answer and where that answer came from */
const DEMO_FILES = new Set(['estimate.pdf', 'texts.txt', 'payment.json', 'recorded-analysis.json', 'PROVENANCE.md']);

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** Pages run only our own script; styles are inline in each page, fonts come from Google Fonts */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE_HEADERS = {
  'content-security-policy': PAGE_POLICY,
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-cache',
};

async function sendFile(path: string, what: string, cache: string): Promise<Response> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw notFound(what);
  }
  const type = TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'content-type': type, 'content-length': String(bytes.length), 'x-content-type-options': 'nosniff', 'cache-control': cache };
  if (type.startsWith('text/html')) Object.assign(headers, PAGE_HEADERS);
  return new Response(new Uint8Array(bytes), { headers });
}

const page = (file: string) => sendFile(join(WEB_DIR, file), 'page', 'no-cache');

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

interface Link {
  href: string;
  text: string;
}

/** A small page in the screens' look for what happens on the way back from PayPal */
export function noticePage(title: string, message: string, links: Link[]): string {
  return `<!doctype html>
<html lang="en" translate="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Make It Right — ${escape(title)}</title>
<style>
:root { --paper: #F4EFE6; --ink: #23201C; --graphite: #2B2926; --muted: #75716D; --rule: #8F8C86; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Source Serif 4", Georgia, "Times New Roman", serif; }
header { display: flex; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--rule); }
.brand { font-weight: 700; font-size: 26px; }
.env { color: var(--muted); font-size: 16px; }
main { max-width: 640px; padding: 40px 24px; }
h1 { font-size: 34px; line-height: 1.15; margin: 0 0 16px; }
p { font-size: 19px; line-height: 1.45; margin: 0 0 24px; }
nav { display: flex; flex-wrap: wrap; gap: 12px; }
nav a { display: inline-block; padding: 12px 20px; border: 2px solid var(--graphite); color: var(--ink); text-decoration: none; font-size: 18px; }
nav a:first-child { background: var(--graphite); color: #F6F2EA; }
</style>
</head>
<body>
<header><span class="brand">Make It Right</span><span class="env">PayPal sandbox</span></header>
<main>
<h1>${escape(title)}</h1>
<p>${escape(message)}</p>
<nav>${links.map((l) => `<a href="${escape(l.href)}">${escape(l.text)}</a>`).join('')}</nav>
</main>
</body>
</html>
`;
}

const HOME: Link = { href: '/', text: 'Start page' };

/** A notice page as an HTTP answer */
export function noticeResponse(status: 200 | HttpError['status'], title: string, message: string, links: Link[]): Response {
  return new Response(noticePage(title, message, links), { status, headers: { ...PAGE_HEADERS, 'content-type': TYPES.html! } });
}
const notice = noticeResponse;

export function registerWeb(app: Hono, deps: { service: CaseService; log: (message: string) => void }): void {
  const { service, log } = deps;

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/', () => page('index.html'));
  app.get('/cases/:id/:screen?', (c) => {
    const file = SCREENS[c.req.param('screen') ?? ''];
    if (!file || !CASE_ID.test(c.req.param('id'))) throw notFound('page');
    return page(file);
  });

  app.get('/web/:file', (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9-]+\.(js|css)$/.test(file)) throw notFound('file');
    return sendFile(join(WEB_DIR, file), 'file', 'no-cache');
  });
  app.get('/web/assets/:file', (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9-]+\.png$/.test(file)) throw notFound('file');
    return sendFile(join(WEB_DIR, 'assets', file), 'file', 'public, max-age=86400');
  });

  // The demo case's files, the same for every copy of it
  app.get('/demo/:template/photos/:file', (c) => {
    const file = c.req.param('file');
    if (c.req.param('template') !== DEMO_TEMPLATE || !PHOTO_NAME.test(file)) throw notFound('photo');
    return sendFile(join(DEMO_DIR, 'photos', file), 'photo', 'public, max-age=86400');
  });
  // Light JPEG copies of the demo photos, for the screens; the files above are the ones the model read
  app.get('/demo/:template/screen/:file', (c) => {
    const file = c.req.param('file');
    if (c.req.param('template') !== DEMO_TEMPLATE || !SCREEN_PHOTO.test(file)) throw notFound('photo');
    return sendFile(join(DEMO_DIR, 'screen', file), 'photo', 'public, max-age=86400');
  });
  app.get('/demo/:template/:file', (c) => {
    const file = c.req.param('file');
    if (c.req.param('template') !== DEMO_TEMPLATE || !DEMO_FILES.has(file)) throw notFound('file');
    return sendFile(join(DEMO_DIR, file), 'file', 'public, max-age=3600');
  });

  // PayPal sends the homeowner back here after approving the payment, with the order id in `token`. The money is taken here.
  app.get('/paypal/return', async (c) => {
    const token = c.req.query('token') ?? '';
    if (!ORDER_ID.test(token)) {
      return notice(400, 'This link is not complete', 'PayPal sends you back here with the id of your payment, and this link has none. Open your case from the start page.', [HOME]);
    }
    const id = await service.caseIdForOrder(token);
    if (!id) return notice(404, 'Payment not found', 'No case on this server has that PayPal payment. Start again from the start page.', [HOME]);
    try {
      await service.capture(id);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      log(`return from PayPal for case ${id}: ${error.code}`);
      return notice(error.status, 'The payment is not complete', `${error.message}.`, [{ href: `/cases/${id}/claim`, text: 'Back to your case' }, HOME]);
    }
    return c.redirect(`/cases/${id}/claim`, 303);
  });

  // PayPal sends the homeowner here when they leave its page without paying. Nothing is asked of PayPal.
  app.get('/paypal/cancel', async (c) => {
    const token = c.req.query('token') ?? '';
    const id = ORDER_ID.test(token) ? await service.caseIdForOrder(token) : null;
    return notice(
      200,
      'Payment canceled',
      'You came back from PayPal without paying, so no money moved. You can pay from your case whenever you are ready.',
      id ? [{ href: `/cases/${id}/claim`, text: 'Back to your case' }, HOME] : [HOME],
    );
  });
}
