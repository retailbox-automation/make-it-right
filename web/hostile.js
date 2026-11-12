// @ts-check
// Fills /hostile from GET /hostile/results.json, a byte-for-byte copy of eval/hostile/RESULTS.json (format:
// eval/hostile/SCHEMA.md). hostileModel turns the results into what the page shows and is pure (tested in
// test/hostile.test.ts); every number on the page is read from the results, none is computed or typed here.
// The DOM part at the bottom only copies the model into the page.

export const NO_RESULTS = 'No recorded results to show yet.';
export const BROKEN_RESULTS = 'The recorded results could not be read.';

/**
 * @typedef {{ label: string, href: string }} FileLink
 * @typedef {{ key: string, kind: 'attack' | 'control', title: string, planted: string, expected: string, files: FileLink[], answer: string, verdict: string, held: boolean | null, why: string, claim: string, warnings: string[] }} Row
 * @typedef {{ ok: true, score: { attacks: string, controls: string }, model: string, rows: Row[] } | { ok: false, message: string }} HostileModel
 */

const isObj = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
const int = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
/** The same rule the server uses to send a listed case file (src/hostile.ts LISTED_FILE) */
const LISTED_FILE = /^eval\/hostile\/cases\/[A-Z]\d{2}\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,40}\/){0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const AMOUNT = /^\d{1,7}\.\d{2}$/;

/** "N of T" exactly as the results count it, or null when either number is missing or they do not fit */
function ofText(/** @type {unknown} */ part, /** @type {unknown} */ total) {
  const a = int(part);
  const b = int(total);
  return a === null || b === null || b === 0 || a > b ? null : `${a} of ${b}`;
}

/** Dollars as the results write them ("2650.00"), shown with a thousands comma; no arithmetic */
export function dollars(/** @type {unknown} */ amount) {
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) return '';
  const [whole = '', cents = ''] = amount.split('.');
  return `$${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${cents}`;
}

/** The model's recorded answers, verbatim (indented JSON); a note when no model call was made */
function answerText(/** @type {unknown} */ answer) {
  if (answer === null || answer === undefined) return 'No model call was made for this case.';
  if (typeof answer === 'string') return answer;
  return JSON.stringify(answer, null, 2);
}

/** @type {Record<'attack' | 'control', Record<string, string>>} */
const VERDICT = {
  attack: { repelled: 'Repelled', missed: 'Missed', failed: 'Model call failed' },
  control: { repelled: 'Passed, no false alarm', missed: 'False alarm', failed: 'Model call failed' },
};

/** @param {unknown} results @returns {HostileModel} */
export function hostileModel(results) {
  if (results === null || results === undefined) return { ok: false, message: NO_RESULTS };
  if (!isObj(results)) return { ok: false, message: BROKEN_RESULTS };
  const r = /** @type {Record<string, any>} */ (results);
  const score = isObj(r.score) ? r.score : {};
  const attacks = ofText(score.attacks?.repelled, score.attacks?.total);
  const controls = ofText(score.controls?.passed, score.controls?.total);
  if (!attacks || !controls || !Array.isArray(r.cases)) return { ok: false, message: BROKEN_RESULTS };

  /** @type {Row[]} */
  const rows = [];
  for (const c of r.cases) {
    if (!isObj(c)) continue;
    /** @type {'attack' | 'control' | null} */
    const kind = c.kind === 'attack' || c.kind === 'control' ? c.kind : null;
    const id = str(c.id);
    if (!kind || !id) continue;
    const files = (Array.isArray(c.files) ? c.files : [])
      .filter((/** @type {unknown} */ f) => typeof f === 'string' && LISTED_FILE.test(f) && !f.includes('..'))
      .map((/** @type {string} */ f) => ({ label: f.slice(f.lastIndexOf('/') + 1), href: `/hostile/files/${f.slice('eval/hostile/'.length)}` }));
    const verdict = str(c.verdict);
    rows.push({
      key: id,
      kind,
      title: `${id} · ${kind === 'attack' ? str(c.class) || 'attack' : 'honest control'}`,
      planted: str(c.planted),
      expected: str(c.expected),
      files,
      answer: answerText(c.model_answer),
      verdict: VERDICT[kind][verdict] ?? '',
      held: verdict === 'repelled' ? true : verdict === 'missed' || verdict === 'failed' ? false : null,
      why: str(c.why),
      claim: dollars(c.claim),
      warnings: (Array.isArray(c.warnings) ? c.warnings : []).map((/** @type {unknown} */ w) => (typeof w === 'string' ? w : JSON.stringify(w))),
    });
  }
  return { ok: true, score: { attacks, controls }, model: str(r.meta?.model), rows };
}

/* ---------- DOM ---------- */

/** @param {string} tag @param {Record<string, string>} [attrs] @param {(Node | string)[]} [kids] */
function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

const heldAttr = (/** @type {boolean | null} */ held) => (held === null ? 'unknown' : String(held));

/** @param {Row} row */
function detailNodes(row) {
  const link = (/** @type {FileLink} */ f) => el('a', { href: f.href, target: '_blank', rel: 'noopener noreferrer' }, [f.label]);
  const images = row.files.filter((f) => /\.(png|jpe?g)$/i.test(f.label)).map((f) => {
    const img = /** @type {HTMLImageElement} */ (el('img', { src: f.href, alt: `Planted file ${f.label}`, loading: 'lazy' }));
    // a file named like an image may not be one (a renamed PDF): then only its link stays
    img.addEventListener('error', () => img.closest('a')?.remove());
    return el('a', { class: 'shot', href: f.href, target: '_blank', rel: 'noopener noreferrer' }, [img]);
  });
  const files = row.files.length
    ? el('div', {}, [el('ul', { class: 'files' }, row.files.map((f) => el('li', {}, [link(f)]))), ...images])
    : el('p', { class: 'muted' }, [row.kind === 'control' ? 'The demo job files, as they are.' : 'No planted file for this case.']);
  return [
    el('p', { class: 'kicker' }, [row.kind === 'attack' ? 'Hostile case' : 'Honest control case']),
    el('h3', {}, [row.title]),
    ...(row.planted ? [el('p', { class: 'planted' }, [row.planted])] : []),
    el('h4', {}, [row.kind === 'attack' ? 'The planted file' : 'The changed file']),
    files,
    el('h4', {}, ['Verdict']),
    el('p', {}, [el('span', { class: 'verdict', 'data-held': heldAttr(row.held) }, [row.verdict || '—'])]),
    ...(row.why ? [el('p', { class: 'why' }, [row.why])] : []),
    ...(row.claim ? [el('p', { class: 'claim' }, ['Claim computed in code: ', el('span', { class: 'mono' }, [row.claim])])] : []),
    ...(row.expected ? [el('p', { class: 'muted' }, [`Counts as held when: ${row.expected}`])] : []),
    ...(row.warnings.length ? [el('h4', {}, ["The app's own checks flagged"]), el('ul', { class: 'files' }, row.warnings.map((w) => el('li', {}, [w])))] : []),
    el('h4', {}, ["The model's recorded answer, verbatim"]),
    el('pre', { class: 'answer' }, [row.answer || '(empty)']),
  ];
}

/** @param {HostileModel} model */
function render(model) {
  const status = /** @type {HTMLElement} */ (document.querySelector('[data-status]'));
  const board = /** @type {HTMLElement} */ (document.querySelector('[data-board]'));
  if (!model.ok) {
    status.textContent = model.message;
    status.hidden = false;
    board.hidden = true;
    return;
  }
  status.hidden = true;
  board.hidden = false;
  /** @type {HTMLElement} */ (document.querySelector('[data-score="attacks"]')).textContent = model.score.attacks;
  /** @type {HTMLElement} */ (document.querySelector('[data-score="controls"]')).textContent = model.score.controls;
  if (model.model) /** @type {HTMLElement} */ (document.querySelector('[data-model]')).textContent = model.model;

  const list = /** @type {HTMLElement} */ (document.querySelector('[data-cases]'));
  const detail = /** @type {HTMLElement} */ (document.querySelector('[data-detail]'));
  const pick = /** @type {HTMLElement} */ (document.querySelector('[data-pick]'));
  list.replaceChildren();
  for (const row of model.rows) {
    const button = el('button', { type: 'button', class: 'case', 'aria-pressed': 'false', 'data-kind': row.kind, 'data-key': row.key }, [
      el('span', { class: 'case-title' }, [row.title]),
      el('span', { class: 'case-verdict', 'data-held': heldAttr(row.held) }, [row.verdict || '—']),
      el('span', { class: 'case-line' }, [row.planted]),
    ]);
    button.addEventListener('click', () => {
      for (const b of list.querySelectorAll('[aria-pressed]')) b.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      detail.replaceChildren(...detailNodes(row));
      detail.hidden = false;
      pick.hidden = true;
      if (window.matchMedia('(max-width: 760px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    list.append(el('li', {}, [button]));
  }
  // on a wide screen the first case is open from the start, so the right side is never empty
  if (!window.matchMedia('(max-width: 760px)').matches) /** @type {HTMLElement | null} */ (list.querySelector('button'))?.click();
}

async function boot() {
  /** @type {HostileModel} */
  let model;
  try {
    const response = await fetch('/hostile/results.json', { headers: { accept: 'application/json' } });
    if (response.status === 404) model = hostileModel(null);
    else if (!response.ok) model = { ok: false, message: BROKEN_RESULTS };
    else {
      const text = await response.text();
      let results;
      try {
        results = JSON.parse(text);
      } catch {
        results = undefined;
      }
      model = results === undefined ? { ok: false, message: BROKEN_RESULTS } : hostileModel(results);
    }
  } catch {
    model = { ok: false, message: BROKEN_RESULTS };
  }
  render(model);
}

if (typeof document !== 'undefined') boot();
