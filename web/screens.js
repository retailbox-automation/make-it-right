// @ts-check
// Fills the screens from GET /api/cases/:id. Everything that turns the case into text (screenModel and the helpers above it)
// is pure and tested in test/screens.test.ts; the DOM part at the bottom only copies what screenModel returns into the page.
// Amounts are formatted here, never computed from scratch: the server computes every amount from the items and verdicts.

export const PLACEHOLDER = '—';
export const RECORDED_NOTE =
  'Photo check: recorded analysis by Gemma 4 31B (run locally on 2026-11-06); the hosted demo replays it. PayPal calls are live, sandbox only.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** @type {Record<string, string>} */
const REASONS = { MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Service not received' };
/** @type {Record<string, string>} */
const DISPUTE_STATUS = {
  OPEN: 'open',
  WAITING_FOR_SELLER_RESPONSE: "waiting for the contractor's answer",
  WAITING_FOR_BUYER_RESPONSE: 'waiting for your answer',
  UNDER_REVIEW: 'PayPal is reviewing it',
  RESOLVED: 'closed',
};

/**
 * What the DOM part does with one element: set its text, link, image or state, hide it, or give it an action.
 * `href: null` removes the link.
 * @typedef {{ text?: string, href?: string | null, target?: string, src?: string, alt?: string, title?: string, state?: string, hidden?: boolean, action?: string }} Field
 * @typedef {{ key: string, fields: Record<string, Field> }} Row
 * @typedef {{ fields: Record<string, Field>, groups: Record<string, Row[]>, waiting: boolean }} ScreenModel
 */

/** "3700.00" → 370000; anything else → null */
export function cents(/** @type {unknown} */ amount) {
  if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount)) return null;
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** "3700.00" → "$3,700.00"; with `short`, whole dollars drop the cents ("$3,700"). Not an amount → the placeholder. */
export function money(/** @type {unknown} */ amount, short = false) {
  const c = cents(amount);
  if (c === null) return PLACEHOLDER;
  const whole = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = String(c % 100).padStart(2, '0');
  return short && fraction === '00' ? `$${whole}` : `$${whole}.${fraction}`;
}

/** "2026-09-12" or an ISO time → "Sep 12" (UTC); anything else → the placeholder */
export function day(/** @type {unknown} */ value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return PLACEHOLDER;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(time)) return PLACEHOLDER;
  const date = new Date(time);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** The case id in /cases/<id>, /cases/<id>/claim, ...; null elsewhere */
export function caseIdFromPath(/** @type {string} */ pathname) {
  const match = /^\/cases\/([A-Za-z0-9_-]{1,64})(?:\/(?:claim|offer|money-back))?\/?$/.exec(pathname);
  return match ? /** @type {string} */ (match[1]) : null;
}

/** Only PayPal's sandbox site may be the payment page the start button sends a judge to */
export function isSandboxPayPalUrl(/** @type {unknown} */ value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'www.sandbox.paypal.com' || url.hostname === 'sandbox.paypal.com');
  } catch {
    return false;
  }
}

/** The Resolution Center itself, from the filing link of the payment (where an offer is accepted) */
export function resolutionCenterUrl(/** @type {unknown} */ filingUrl) {
  return typeof filingUrl === 'string' && isSandboxPayPalUrl(filingUrl) ? filingUrl.replace(/\/filing\/[^/]*$/, '') : null;
}

const text = (/** @type {unknown} */ value) => /** @type {Field} */ ({ text: typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : PLACEHOLDER });
const shown = (/** @type {boolean} */ visible) => /** @type {Field} */ ({ hidden: !visible });
const capitalized = (/** @type {string} */ s) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/** Where an item was promised, without the date the line shows next to it: "estimate p.1" → "Estimate p.1", "text Sep 9" → "Text" */
const sourceLabel = (/** @type {any} */ source) => capitalized(String(source?.ref || source?.kind || '').replace(/\s+[A-Z][a-z]{2} \d{1,2}$/, ''));

/** @param {any} item */
const titleWithQty = (item) => (item.qty > 1 ? `${item.title} (${item.qty})` : item.title);

/** @param {any} view */
function lookups(view) {
  /** @type {Map<string, any>} */
  const verdicts = new Map((view.verdicts ?? []).map((/** @type {any} */ v) => [v.item_id, v]));
  /** @type {Map<string, any>} */
  const lines = new Map((view.claim?.lines ?? []).map((/** @type {any} */ l) => [l.item_id, l]));
  /** @type {Map<string, string>} */
  const photos = new Map((view.photos ?? []).map((/** @type {any} */ p) => [p.id, p.url]));
  return { verdicts, lines, photos };
}

/** The photo a verdict names, as the exact file the photo check read; none → hidden */
function photoField(/** @type {Map<string, string>} */ photos, /** @type {any} */ verdict) {
  const src = verdict?.photo_ref ? photos.get(verdict.photo_ref) : undefined;
  if (!src) return /** @type {Field} */ ({ hidden: true });
  return /** @type {Field} */ ({ src, alt: verdict.note || 'Job-site photo', title: verdict.note || '', hidden: false });
}

/** @param {any} item @param {any} verdict */
function stamp(item, verdict) {
  switch (verdict?.status) {
    case 'done':
      return { state: 'done', label: 'Done' };
    case 'partial':
      return { state: 'partly', label: `Partly · ${verdict.done_units} of ${item.qty}` };
    case 'not_done':
      return { state: 'not-done', label: 'Not done' };
    default:
      return { state: 'unclear', label: 'No photo yet' };
  }
}

/** @param {any} dispute */
function disputeText(dispute) {
  if (!dispute) return '';
  const status = DISPUTE_STATUS[dispute.status] ?? String(dispute.status).toLowerCase().replace(/_/g, ' ');
  return dispute.life_cycle_stage === 'CHARGEBACK' && dispute.status !== 'RESOLVED' ? `sent to PayPal, ${status}` : status;
}

/** What the claim screen's main button does now, and the short step text under it */
function claimStep(/** @type {any} */ view) {
  const claim = view.claim ?? {};
  const payment = view.case?.payment ?? null;
  const dispute = view.dispute;
  if (view.case?.read_only) {
    return {
      button: { text: 'Try it with your sandbox account', href: '/#try', action: '', target: '' },
      note: 'This walkthrough case is not paid. Start your own copy to pay, file and follow a claim in the PayPal sandbox.',
      check: false,
      waiting: false,
    };
  }
  if (!payment || payment.status === 'created') {
    return {
      button: { text: `Pay ${money(claim.paid_total)} in the sandbox`, href: '#', action: 'pay', target: '' },
      note: 'Pay with your own PayPal sandbox Personal account. Sandbox only: no real money moves.',
      check: false,
      waiting: false,
    };
  }
  if (payment.status === 'pending') {
    return {
      button: { text: 'Check the payment again', href: '#', action: 'capture', target: '' },
      note: 'PayPal has not completed the payment yet.',
      check: false,
      waiting: true,
    };
  }
  if (!dispute) {
    return {
      button: { text: 'File with PayPal', href: view.filing?.filing_url ?? null, action: '', target: '_blank' },
      note: `On PayPal, file "Service not received" for ${money(claim.amount)}, the amount shown. The app finds your claim within a few minutes (3 to 4 in our sandbox runs).`,
      check: true,
      waiting: true,
    };
  }
  return {
    button: { text: 'Open your claim in PayPal', href: resolutionCenterUrl(view.filing?.filing_url), action: '', target: '_blank' },
    note: `You filed ${day(dispute.opened_at)} for ${money(dispute.original_claim_amount)}. The contractor's answer is on the next screen.`,
    check: dispute.status !== 'RESOLVED',
    waiting: dispute.status !== 'RESOLVED',
  };
}

/** The offer screen's buttons: the contractor stand-in, the homeowner's choices, and PayPal's decision (sandbox only) */
function offerActions(/** @type {any} */ view) {
  const dispute = view.dispute;
  const offer = view.offer;
  const open = !!dispute && dispute.status !== 'RESOLVED' && !view.case?.read_only;
  const inquiry = open && dispute.life_cycle_stage === 'INQUIRY';
  const chargeback = open && dispute.life_cycle_stage === 'CHARGEBACK';
  const sellerTurn = chargeback && dispute.status === 'WAITING_FOR_SELLER_RESPONSE';
  const actions = {
    stand_in_offer: inquiry && !offer,
    accept: inquiry && offer?.status === 'pending',
    escalate: inquiry && !!offer,
    stand_in_answer: sellerTurn,
    adjudicate: chargeback && !sellerTurn,
  };
  let step;
  if (view.case?.read_only) step = 'The walkthrough case has no claim. Start your own copy to see an offer.';
  else if (!dispute) step = 'File your claim in PayPal first, from the claim screen.';
  else if (dispute.status === 'RESOLVED') step = 'The case is closed. See the money-back screen.';
  else if (actions.stand_in_offer) step = 'Sandbox stand-in: have the contractor make an offer. PayPal opens this a few minutes after you file.';
  else if (actions.accept) step = 'Your call: accept on PayPal, or ask PayPal to decide.';
  else if (actions.stand_in_answer) step = 'PayPal has the case. In the sandbox the contractor stand-in answers PayPal first.';
  else if (actions.adjudicate) step = 'Sandbox only: ask PayPal to decide now. PayPal may take a few minutes to open this step.';
  else step = 'Waiting for PayPal.';
  return { actions, step };
}

/** @param {any} outcome */
function outcomeText(outcome) {
  if (!outcome) return PLACEHOLDER;
  if (outcome.status === 'money_back') {
    if (outcome.outcome_reason === 'INQUIRY_OFFER_PARTIAL_REFUND') return 'Offer accepted · refunded';
    if (outcome.outcome_reason === 'SELLER_ISSUED_REFUND') return 'The contractor refunded you';
    return 'Decided in your favor';
  }
  return outcome.status === 'denied' ? 'Decided for the contractor' : 'Case closed';
}

/** @type {Record<string, string>} */
const OUTCOME_STAMP = { money_back: 'Money back', denied: 'Not refunded', closed: 'Closed' };

/**
 * Everything one screen shows for a case, as field name → what to show. Screens: promised, claim, offer, money-back.
 * @param {'promised' | 'claim' | 'offer' | 'money-back'} screen
 * @param {any} view the answer of GET /api/cases/:id
 * @returns {ScreenModel}
 */
export function screenModel(screen, view) {
  const id = String(view?.case?.id ?? '');
  const claim = view?.claim ?? {};
  const items = /** @type {any[]} */ (view?.promised_items ?? []);
  const { verdicts, lines, photos } = lookups(view ?? {});
  const dispute = view?.dispute ?? null;
  const offer = view?.offer ?? null;
  const outcome = view?.outcome ?? null;
  const readOnly = !!view?.case?.read_only;
  const base = `/cases/${id}`;
  const claimed = items.filter((item) => (cents(lines.get(item.id)?.claim_amount) ?? 0) > 0);
  const proven = items.filter((item) => (cents(lines.get(item.id)?.proven_amount) ?? 0) > 0);
  const filedAmount = dispute?.original_claim_amount ?? claim.amount;

  /** @type {Record<string, Field>} */
  const fields = {
    analysis_note: { text: RECORDED_NOTE, hidden: !view?.case?.template },
    case_notice: readOnly
      ? { text: 'Walkthrough: the demo case as the recorded photo check sorted it. To try the PayPal steps, start your own copy from the start page.', hidden: false }
      : { hidden: true },
    nav_promised: { href: base },
    nav_claim: { href: `${base}/claim` },
    nav_offer: { href: `${base}/offer` },
    nav_money_back: { href: `${base}/money-back` },
    provenance_link: view?.case?.template ? { href: `/demo/${view.case.template}/PROVENANCE.md`, hidden: false } : { hidden: true },
    payee: text(claim.payee_name),
  };
  /** @type {Record<string, Row[]>} */
  const groups = {};
  let waiting = false;

  if (screen === 'promised') {
    const estimateDate = items.find((item) => item.source?.kind === 'estimate')?.source?.date;
    const preview = claimed.map((item) => verdicts.get(item.id)?.photo_ref).find((ref) => ref && photos.has(ref)) ?? [...photos.keys()][0];
    const count = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
    const fromEstimate = items.filter((item) => item.source?.kind === 'estimate').length;
    const fromTexts = items.filter((item) => item.source?.kind === 'text').length;
    const proofPhotos = new Set((view?.verdicts ?? []).map((/** @type {any} */ v) => v.photo_ref).filter((/** @type {unknown} */ ref) => typeof ref === 'string' && photos.has(ref))).size;
    Object.assign(fields, {
      items_count: text(count(items.length, 'item', 'items')),
      estimate_items: text(`${count(fromEstimate, 'promised item', 'promised items')} read from it`),
      text_items: text(`${count(fromTexts, 'promised item', 'promised items')} added by text`),
      photos_judged: text(view?.photos ? `${count(proofPhotos, 'photo', 'photos')} used as proof` : ''),
      estimate_name: { href: view?.estimate_url ?? null },
      estimate_date: text(day(estimateDate)),
      texts_count: text(view?.analysis?.text_count),
      photos_count: text(view?.photos ? view.photos.length : undefined),
      photos_preview: preview ? { src: photos.get(preview), alt: 'A job-site photo the photo check read', hidden: false } : { hidden: true },
      paid_total: text(money(claim.paid_total)),
      method_line: text(claim.method ? `Paid with ${claim.method}` : 'Paid with: not confirmed by PayPal yet'),
      method_check: { state: claim.method ? 'pass' : 'unknown' },
      paid_at: text(day(claim.paid_at)),
      day_n: text(claim.day_n),
      window_check: { state: typeof claim.day_n === 'number' ? (claim.day_n <= 180 ? 'pass' : 'fail') : 'unknown' },
      eligibility_note: text(claim.eligibility_note),
      next_url: { href: `${base}/claim` },
    });
    groups.promised = items.map((item) => ({
      key: item.id,
      fields: { title: { text: titleWithQty(item), title: titleWithQty(item) }, price: text(money(item.price, true)), source: text(item.source?.ref || item.source?.kind) },
    }));
  }

  if (screen === 'claim') {
    const step = claimStep(view ?? {});
    waiting = step.waiting;
    Object.assign(fields, {
      paid_verb: text(claim.paid_at ? 'You paid' : 'You pay'),
      paid_amount_short: text(money(claim.paid_total, true)),
      proven_done_short: text(money(claim.proven_done, true)),
      claim_amount_short: text(money(claim.amount, true)),
      paid_line: text(claim.paid_at ? `Paid ${day(claim.paid_at)}${claim.method ? ` · ${claim.method}` : ''}` : 'Not paid yet'),
      reason: text(REASONS[claim.reason] ?? claim.reason),
      paid_amount: text(money(claim.paid_total)),
      proven_done_negative: text(cents(claim.proven_done) === null ? PLACEHOLDER : `-${money(claim.proven_done)}`),
      claim_amount: text(money(claim.amount)),
      filing_url: step.button,
      file_note: text(step.note),
      check_paypal: { ...shown(step.check), action: 'check' },
      claim_status: dispute ? { text: `Claim ${dispute.id}: ${disputeText(dispute)}`, hidden: false } : { hidden: true },
      transaction: claim.transaction_id ? { text: `Your PayPal transaction: ${claim.transaction_id}`, hidden: false } : { hidden: true },
      eligibility: text(claim.eligibility_note),
      next_step: { href: `${base}/offer`, hidden: !dispute },
    });
    groups.claim = claimed.map((item) => {
      const verdict = verdicts.get(item.id);
      const line = lines.get(item.id);
      const mark = stamp(item, verdict);
      return {
        key: item.id,
        fields: {
          promise_quote: text(item.source?.quote ? `“${item.source.quote}”` : ''),
          promise_source: text(sourceLabel(item.source)),
          promise_date: text(day(item.source?.date)),
          item_title: { text: item.title, title: titleWithQty(item) },
          item_price_line: text(verdict?.status === 'partial' ? `${money(line?.claim_amount, true)} of ${money(item.price, true)}` : money(item.price, true)),
          verdict_note: text(verdict?.note || (verdict ? '' : 'No verdict: the item stays in the claim.')),
          photo: photoField(photos, verdict),
          verdict: { state: mark.state },
          verdict_label: { text: mark.label },
        },
      };
    });
    groups.tray = proven.map((item) => {
      const verdict = verdicts.get(item.id);
      const title = verdict?.status === 'partial' ? `${verdict.done_units} of ${item.qty} · ${item.title}` : item.title;
      return {
        key: item.id,
        fields: {
          photo: photoField(photos, verdict),
          item_title: { text: title, title },
          item_price: text(money(lines.get(item.id)?.proven_amount, true)),
          verdict: { state: 'done' },
        },
      };
    });
  }

  if (screen === 'offer') {
    const { actions, step } = offerActions(view ?? {});
    const gap = offer ? (cents(filedAmount) ?? 0) - (cents(offer.amount) ?? 0) : null;
    const notDone = claimed.filter((item) => verdicts.get(item.id)?.status !== 'partial').length;
    const partly = claimed.length - notDone;
    const photoLine = `Photos show ${notDone} promised ${notDone === 1 ? 'item' : 'items'} not done${partly ? ` and ${partly} partly done` : ''}.`;
    const payee = claim.payee_name || PLACEHOLDER;
    waiting = (!!dispute && dispute.status !== 'RESOLVED') || (!dispute && view?.case?.payment?.status === 'captured');
    Object.assign(fields, {
      offer_title: text(offer ? `${payee} offered ${money(offer.amount)}` : dispute ? `No offer from ${payee} yet` : 'No claim filed yet'),
      filed_line: text(
        dispute
          ? `You filed ${day(dispute.opened_at)} · ${money(filedAmount)} · ${REASONS[claim.reason] ?? PLACEHOLDER}`
          : `Not filed yet · claim ready: ${money(filedAmount)} · ${REASONS[claim.reason] ?? PLACEHOLDER}`,
      ),
      claim_amount: text(money(filedAmount)),
      claim_note_1: text(view?.case?.payment?.status === 'captured' ? `Paid ${day(claim.paid_at)} with ${claim.method ?? PLACEHOLDER}` : 'Not paid through PayPal yet'),
      claim_note_2: text(typeof claim.day_n === 'number' ? `Day ${claim.day_n} of the 180 days PayPal allows for this claim` : PLACEHOLDER),
      offer_amount: text(offer ? money(offer.amount) : PLACEHOLDER),
      offer_status: text(offer ? `Offer ${offer.status}, received ${day(offer.received_at)}` : 'No offer yet'),
      read_note: text(
        offer
          ? gap !== null && gap > 0
            ? `The offer leaves ${money((gap / 100).toFixed(2))} of unfinished work unpaid. ${photoLine}`
            : `The offer covers the whole claim. ${photoLine}`
          : `${photoLine} The offer will be weighed against them.`,
      ),
      offer_step: text(step),
      stand_in_offer: { hidden: !actions.stand_in_offer, action: 'sim-offer' },
      accept: { hidden: !actions.accept, href: resolutionCenterUrl(view?.filing?.filing_url), target: '_blank' },
      accept_amount: text(offer ? money(offer.amount) : PLACEHOLDER),
      escalate: { hidden: !actions.escalate, action: 'escalate' },
      stand_in_answer: { hidden: !actions.stand_in_answer, action: 'sim-evidence' },
      adjudicate: { hidden: !actions.adjudicate, action: 'adjudicate' },
    });
    groups.offer = claimed.map((item) => {
      const verdict = verdicts.get(item.id);
      const mark = stamp(item, verdict);
      const title = verdict?.status === 'partial' ? `${item.qty - verdict.done_units} of ${item.qty} · ${item.title}` : item.title;
      return {
        key: item.id,
        fields: {
          item_title: { text: title, title },
          item_claim_amount: text(money(lines.get(item.id)?.claim_amount, true)),
          verdict_status: { text: mark.state === 'partly' ? 'Partly' : mark.label, state: mark.state },
        },
      };
    });
  }

  if (screen === 'money-back') {
    const paid = cents(claim.paid_total);
    const refunded = outcome ? cents(outcome.amount_refunded) : null;
    const kept = outcome && paid !== null && refunded !== null ? (Math.max(0, paid - refunded) / 100).toFixed(2) : claim.proven_done;
    waiting = !!dispute && dispute.status !== 'RESOLVED';
    const payee = claim.payee_name || PLACEHOLDER;
    Object.assign(fields, {
      case_title: text(`Your claim against ${payee}`),
      case_meta: text(dispute ? `PayPal claim ${dispute.id}` : 'No claim filed yet'),
      outcome_status: { state: outcome?.status ?? 'none' },
      outcome_word: text(outcome ? (OUTCOME_STAMP[outcome.status] ?? 'Closed') : 'No refund yet'),
      amount_refunded: text(outcome ? `+${money(outcome.amount_refunded)}` : PLACEHOLDER),
      refund_note: text(outcome ? `refunded to you · back to ${outcome.refund_destination}` : 'nothing refunded yet'),
      step_filed: { state: dispute ? 'done' : 'pending' },
      step_filed_text: text(dispute ? `${day(dispute.opened_at)} · You filed in PayPal · ${money(filedAmount)}` : `Not filed yet · claim ready: ${money(filedAmount)}`),
      step_offer: { state: offer ? 'done' : 'pending' },
      step_offer_text: text(offer ? `${day(offer.received_at)} · Offer ${money(offer.amount)} · ${offer.status}` : 'No offer yet'),
      step_sent: { state: dispute?.escalated_at ? 'done' : 'pending' },
      step_sent_text: text(dispute?.escalated_at ? `${day(dispute.escalated_at)} · Sent to PayPal` : 'Not sent to PayPal'),
      step_decided: { state: outcome ? 'done' : 'pending' },
      step_decided_text: text(outcome ? `${day(outcome.decided_at)} · ${outcomeText(outcome)}` : 'Not decided yet'),
      kept_title: text(outcome ? `Kept by ${payee}: ${money(kept)}` : `${payee} would keep ${money(kept)}`),
      kept_sub: text(
        !outcome
          ? 'for work the photos prove, once the claim is refunded'
          : kept === claim.proven_done
            ? 'for work the photos prove'
            : `of which ${money(claim.proven_done)} is work the photos prove`,
      ),
    });
  }

  return { fields, groups, waiting };
}

// ------------------------------------------------------------------------------------------------ DOM (thin)

/** @param {Element} el @param {Field} field */
function apply(el, field) {
  if (field.text !== undefined) el.textContent = field.text;
  if (field.href !== undefined) {
    if (field.href === null) el.removeAttribute('href');
    else el.setAttribute('href', field.href);
  }
  if (field.target !== undefined) {
    if (field.target) {
      el.setAttribute('target', field.target);
      el.setAttribute('rel', 'noopener noreferrer');
    } else el.removeAttribute('target');
  }
  if (field.src !== undefined) el.setAttribute('src', field.src);
  if (field.alt !== undefined) el.setAttribute('alt', field.alt);
  if (field.title !== undefined) el.setAttribute('title', field.title);
  if (field.state !== undefined) el.setAttribute('data-state', field.state);
  if (field.action !== undefined) el.setAttribute('data-action', field.action);
  if (field.hidden !== undefined) /** @type {HTMLElement} */ (el).hidden = field.hidden;
}

/** @param {ScreenModel} model */
function render(model) {
  for (const el of document.querySelectorAll('[data-field]')) {
    if (el.closest('[data-key]')) continue;
    const field = model.fields[el.getAttribute('data-field') ?? ''];
    if (field) apply(el, field);
  }
  for (const box of document.querySelectorAll('[data-group]')) {
    const template = box.querySelector('template');
    if (!template) continue;
    for (const old of box.querySelectorAll(':scope > [data-key]')) old.remove();
    for (const row of model.groups[box.getAttribute('data-group') ?? ''] ?? []) {
      const node = /** @type {Element | null} */ (template.content.firstElementChild?.cloneNode(true) ?? null);
      if (!node) continue;
      node.setAttribute('data-key', row.key);
      for (const el of node.querySelectorAll('[data-field]')) {
        const field = row.fields[el.getAttribute('data-field') ?? ''];
        if (field) apply(el, field);
      }
      box.append(node);
    }
  }
}

function say(/** @type {string} */ message) {
  const box = /** @type {HTMLElement | null} */ (document.querySelector('[data-notice]'));
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

/** @param {string} path @param {string} [method] @param {unknown} [body] */
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer?.error?.message ?? `The server answered ${response.status}`);
  return answer;
}

/** Starts the payment of a case and goes to PayPal's sandbox page to approve it */
async function payCase(/** @type {string} */ id) {
  const { approve_url } = await api(`/api/cases/${id}/payment`, 'POST');
  if (!isSandboxPayPalUrl(approve_url)) throw new Error('The payment link is not a PayPal sandbox link, so it was not opened.');
  window.location.assign(approve_url);
}

function boot() {
  const screen = document.body.getAttribute('data-screen') ?? '';
  let timer = 0;

  if (screen === 'landing') {
    document.addEventListener('click', async (event) => {
      const button = /** @type {HTMLButtonElement | null} */ (/** @type {Element} */ (event.target).closest('[data-action="start-demo"]'));
      if (!button) return;
      event.preventDefault();
      button.disabled = true;
      say('Making your copy of the demo case…');
      try {
        const view = await api('/api/demo/cases', 'POST');
        say('Opening PayPal sandbox…');
        await payCase(view.case.id);
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        button.disabled = false;
      }
    });
    return;
  }

  const id = caseIdFromPath(window.location.pathname);
  if (!id) return say('This address does not name a case.');
  const kind = /** @type {'promised' | 'claim' | 'offer' | 'money-back'} */ (screen);

  async function load() {
    window.clearTimeout(timer);
    try {
      const model = screenModel(kind, await api(`/api/cases/${id}`));
      render(model);
      if (model.waiting) timer = window.setTimeout(load, 20_000);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    }
  }

  /** @type {Record<string, () => Promise<unknown>>} */
  const actions = {
    pay: () => payCase(/** @type {string} */ (id)),
    capture: () => api(`/api/cases/${id}/capture`, 'POST'),
    check: () => api(`/api/cases/${id}/dispute`),
    'sim-offer': () => api(`/api/sim/contractor/${id}/offer`, 'POST'),
    'sim-evidence': () => api(`/api/sim/contractor/${id}/evidence`, 'POST'),
    escalate: () => api(`/api/cases/${id}/escalate`, 'POST'),
    adjudicate: () => api(`/api/cases/${id}/adjudicate`, 'POST', { outcome: 'BUYER_FAVOR' }),
  };
  document.addEventListener('click', async (event) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-action]'));
    const run = el ? actions[el.getAttribute('data-action') ?? ''] : undefined;
    if (!el || !run) return;
    event.preventDefault();
    if (el.getAttribute('aria-busy') === 'true') return;
    el.setAttribute('aria-busy', 'true');
    say('');
    try {
      await run();
      await load();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    } finally {
      el.removeAttribute('aria-busy');
    }
  });

  load();
}

if (typeof document !== 'undefined') boot();
