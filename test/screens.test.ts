import { beforeAll, describe, expect, it } from 'vitest';
import { createDemoCopy, loadDemo, seedWalkthrough } from '../src/demo.js';
import { Tracker } from '../src/disputes/tracker.js';
import { KeyedLock } from '../src/lock.js';
import type { CaseRecord, Dispute, Offer, Outcome } from '../src/model.js';
import { caseView, CaseService, type CaseView } from '../src/service.js';
import { MemoryStore } from '../src/store.js';
import { caseIdFromPath, cents, day, isSandboxPayPalUrl, money, photoFields, PLACEHOLDER, RECORDED_NOTE, resolutionCenterUrl, screenModel } from '../web/screens.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './helpers/demo.js';
import { makeWorld } from './helpers/world.js';

type Screen = 'promised' | 'claim' | 'offer' | 'money-back';
const SCREENS: Screen[] = ['promised', 'claim', 'offer', 'money-back'];
const NOW = new Date('2026-11-09T12:00:00.000Z');

let walkthrough: CaseView;
let copy: CaseView;
let plain: CaseView;
let copyRecord: CaseRecord;

beforeAll(async () => {
  const world = makeWorld();
  const store = new MemoryStore();
  const locks = new KeyedLock();
  let n = 0;
  const service = new CaseService({
    store, paypal: world.client, tracker: new Tracker({ store, paypal: world.client, locks }), locks, now: () => NOW, newId: () => `copy${++n}`,
    urls: { returnUrl: 'https://demo.example/r', cancelUrl: 'https://demo.example/c' },
  });
  const demo = loadDemo();
  walkthrough = JSON.parse(JSON.stringify((await seedWalkthrough(service, demo)).view));
  copy = JSON.parse(JSON.stringify(await createDemoCopy(service, demo)));
  copyRecord = (await store.get(copy.case.id))!;
  plain = JSON.parse(JSON.stringify(await service.createCase({ payee_name: 'Harbor Plumbing', promised_items: RIDGEWAY_ITEMS, verdicts: RIDGEWAY_VERDICTS })));
});

// Later states of the copy, made into views by the server's own caseView, so every amount in them is the server's
const FILING = 'https://www.sandbox.paypal.com/resolutioncenter/filing/27S431280V029084G';
const viewOf = (over: Partial<CaseRecord>): CaseView => JSON.parse(JSON.stringify(caseView({ ...copyRecord, ...over }, NOW)));
const PAID: Partial<CaseRecord> = {
  paid_at: '2026-11-09',
  payment: { order_id: 'O1', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=O1', status: 'captured', capture_id: 'C1', capture_status: 'COMPLETED', captured_at: '2026-11-09T11:00:00Z', method: 'PayPal Goods & Services' },
};
const captured = () => viewOf(PAID);
const filed = (over: Partial<Dispute> = {}, more: { offer?: Offer; outcome?: Outcome } = {}) =>
  viewOf({
    ...PAID,
    buyer_transaction_id: '27S431280V029084G',
    dispute: { id: 'PP-R-AAA-1', status: 'WAITING_FOR_SELLER_RESPONSE', life_cycle_stage: 'INQUIRY', opened_at: '2026-11-09T11:05:00Z', escalated_at: null, dispute_amount: '2650.00', original_claim_amount: '2650.00', ...over },
    ...more,
  });
const offer = (status: Offer['status'] = 'pending', amount = '1200.00'): Offer => ({ amount, type: 'REFUND', note: null, received_at: '2026-11-09T11:20:00Z', status });
const texts = (model: ReturnType<typeof screenModel>) => Object.values(model.fields).map((f) => f.text).filter((t): t is string => t !== undefined);

describe('formatting', () => {
  it('formats amounts from the cents the server computed, without arithmetic in floating point', () => {
    expect(cents('3700.00')).toBe(370000);
    expect(cents('0.1')).toBe(10);
    expect(cents('1e3')).toBeNull();
    expect(cents(3700)).toBeNull();
    expect(money('3700.00')).toBe('$3,700.00');
    expect(money('3700.00', true)).toBe('$3,700');
    expect(money('240.50', true)).toBe('$240.50');
    expect(money('1234567.89')).toBe('$1,234,567.89');
    expect(money(null)).toBe(PLACEHOLDER);
    expect(money('-5.00')).toBe(PLACEHOLDER);
  });

  it('shows days in UTC as "Sep 12"', () => {
    expect(day('2026-09-12')).toBe('Sep 12');
    expect(day('2026-11-04T23:30:00Z')).toBe('Nov 4');
    expect(day(null)).toBe(PLACEHOLDER);
    expect(day('soon')).toBe(PLACEHOLDER);
  });

  it('reads the case id from the screen\'s address', () => {
    expect(caseIdFromPath('/cases/demo-ridgeway')).toBe('demo-ridgeway');
    expect(caseIdFromPath('/cases/abc123/claim')).toBe('abc123');
    expect(caseIdFromPath('/cases/abc123/money-back')).toBe('abc123');
    expect(caseIdFromPath('/cases/abc/elsewhere')).toBeNull();
    expect(caseIdFromPath('/')).toBeNull();
  });

  it('opens only PayPal sandbox links for the payment, and finds the Resolution Center from the filing link', () => {
    expect(isSandboxPayPalUrl('https://www.sandbox.paypal.com/checkoutnow?token=5X6')).toBe(true);
    expect(isSandboxPayPalUrl('https://www.paypal.com/checkoutnow?token=5X6')).toBe(false);
    expect(isSandboxPayPalUrl('https://www.sandbox.paypal.com.evil.example/x')).toBe(false);
    expect(isSandboxPayPalUrl('http://www.sandbox.paypal.com/x')).toBe(false);
    expect(isSandboxPayPalUrl('javascript:alert(1)')).toBe(false);
    expect(resolutionCenterUrl(FILING)).toBe('https://www.sandbox.paypal.com/resolutioncenter');
    expect(resolutionCenterUrl('https://www.sandbox.paypal.com/resolutioncenter')).toBe('https://www.sandbox.paypal.com/resolutioncenter');
    expect(resolutionCenterUrl('https://evil.example/resolutioncenter/filing/1')).toBeNull();
  });
});

describe('every screen', () => {
  it.each(SCREENS)('%s says once that the photo check is the recorded one, on demo cases only', (screen) => {
    expect(screenModel(screen, walkthrough).fields.analysis_note).toEqual({ text: RECORDED_NOTE, hidden: false });
    expect(screenModel(screen, copy).fields.analysis_note!.hidden).toBe(false);
    expect(screenModel(screen, plain).fields.analysis_note!.hidden).toBe(true);
    expect(RECORDED_NOTE).toBe('Photo check: recorded analysis by Gemma 4 31B (run locally on 2026-11-06); the hosted demo replays it. PayPal calls are live, sandbox only.');
  });

  it.each(SCREENS)('%s shows placeholders, never demo text, for a case with nothing in it', (screen) => {
    const model = screenModel(screen, { case: { id: 'empty' } });
    for (const value of texts(model)) expect(value).not.toMatch(/Ridgeway|\$\d|Sep|Nov|GFCI|panel/);
    expect(Object.values(model.groups).flat()).toEqual([]);
    expect(model.fields.payee).toEqual({ text: PLACEHOLDER });
  });

  it.each(SCREENS)('%s links the other screens of the same case', (screen) => {
    const { fields } = screenModel(screen, copy);
    expect([fields.nav_promised, fields.nav_claim, fields.nav_offer, fields.nav_money_back].map((f) => f!.href)).toEqual(['/cases/copy1', '/cases/copy1/claim', '/cases/copy1/offer', '/cases/copy1/money-back']);
  });
});

describe('promised items', () => {
  it('lists each promised item with its price and where it was promised; the total is what was paid', () => {
    const model = screenModel('promised', walkthrough);
    expect(model.groups.promised!.map((r) => [r.key, r.fields.title!.text, r.fields.price!.text, r.fields.source!.text])).toEqual([
      ['1', 'GFCI outlets (4)', '$260', 'estimate p.1'],
      ['2', 'Ceiling fan with light', '$310', 'estimate p.1'],
      ['3', 'Recessed LED lights (6)', '$720', 'estimate p.1'],
      ['4', 'Main panel upgrade to 200A', '$1,300', 'estimate p.1'],
      ['5', 'LED flood lights over backyard (2)', '$460', 'estimate p.1'],
      ['6', '50A circuit for the EV charger in the garage', '$650', 'text Sep 9'],
    ]);
    expect(model.fields).toMatchObject({
      payee: { text: 'Ridgeway Electric' },
      paid_total: { text: '$3,700.00' },
      texts_count: { text: '5' },
      photos_count: { text: '6' },
      estimate_name: { href: '/demo/ridgeway/estimate.pdf' },
      estimate_date: { text: 'Sep 8' },
      estimate_items: { text: '5 promised items read from it' },
      text_items: { text: '1 promised item added by text' },
      photos_judged: { text: '6 photos used as proof' },
      paid_at: { text: 'Sep 12' },
      day_n: { text: '58' },
      window_check: { state: 'pass' },
      next_url: { href: '/cases/demo-ridgeway/claim' },
      provenance_link: { href: '/demo/ridgeway/PROVENANCE.md', hidden: false },
    });
    expect(model.fields.photos_preview!.src).toBe('/demo/ridgeway/screen/photo-3.jpg');
    expect(model.fields.photos_preview_file).toEqual({ href: '/demo/ridgeway/photos/photo-3.png', hidden: false });
  });

  it('does not claim a PayPal payment the case does not have', () => {
    const { fields } = screenModel('promised', walkthrough);
    expect(fields.method_line).toEqual({ text: 'Paid in the demo story, not through PayPal' });
    expect(screenModel('promised', copy).fields.method_line).toEqual({ text: 'Paid with: not confirmed by PayPal yet' });
    expect(fields.method_check).toEqual({ state: 'unknown' });
    expect(screenModel('promised', captured()).fields.method_line).toEqual({ text: 'Paid with PayPal Goods & Services' });
    expect(screenModel('promised', captured()).fields.method_check).toEqual({ state: 'pass' });
  });
});

describe('claim', () => {
  it('puts each unfinished item next to the photo the verdict names, with the amounts the server computed', () => {
    const model = screenModel('claim', walkthrough);
    expect(model.fields).toMatchObject({
      paid_verb: { text: 'You paid' },
      paid_line: { text: 'Paid Sep 12' },
      paid_amount_short: { text: '$3,700' },
      proven_done_short: { text: '$1,050' },
      claim_amount_short: { text: '$2,650' },
      paid_amount: { text: '$3,700.00' },
      proven_done_negative: { text: '-$1,050.00' },
      claim_amount: { text: '$2,650.00' },
      reason: { text: 'Service not received' },
    });
    expect(model.groups.claim!.map((r) => [r.key, r.fields.item_price_line!.text, r.fields.verdict!.state, r.fields.verdict_label!.text, r.fields.photo!.src, r.fields.photo_file!.href])).toEqual([
      ['3', '$240 of $720', 'partly', 'Partly · 4 of 6', '/demo/ridgeway/screen/photo-3.jpg', '/demo/ridgeway/photos/photo-3.png'],
      ['4', '$1,300', 'not-done', 'Not done', '/demo/ridgeway/screen/photo-4.jpg', '/demo/ridgeway/photos/photo-4.png'],
      ['5', '$460', 'not-done', 'Not done', '/demo/ridgeway/screen/photo-6.jpg', '/demo/ridgeway/photos/photo-6.png'],
      ['6', '$650', 'not-done', 'Not done', '/demo/ridgeway/screen/photo-5.jpg', '/demo/ridgeway/photos/photo-5.png'],
    ]);
    const panel = model.groups.claim![1]!.fields;
    expect(panel.promise_quote!.text).toBe('“Main panel upgrade to 200A, new breakers, permit”');
    expect(panel.promise_source!.text).toBe('Estimate p.1');
    expect(panel.promise_date!.text).toBe('Sep 8');
    expect(panel.verdict_note!.text).toBe('The electrical panel is an old fuse box, not a new 200A panel.');
    expect(panel.photo!.alt).toBe(panel.verdict_note!.text);
    expect(model.groups.claim![3]!.fields.promise_source!.text).toBe('Text'); // "text Sep 9": the date is shown beside it once
    expect(model.groups.claim![3]!.fields.promise_date!.text).toBe('Sep 9');

    expect(model.groups.tray!.map((r) => [r.key, r.fields.item_title!.text, r.fields.item_price!.text, r.fields.photo!.src, r.fields.photo_file!.href])).toEqual([
      ['1', 'GFCI outlets (4)', '$260', '/demo/ridgeway/screen/photo-1.jpg', '/demo/ridgeway/photos/photo-1.png'],
      ['2', 'Ceiling fan with light', '$310', '/demo/ridgeway/screen/photo-2.jpg', '/demo/ridgeway/photos/photo-2.png'],
      ['3', '4 of 6 · Recessed LED lights', '$480', '/demo/ridgeway/screen/photo-3.jpg', '/demo/ridgeway/photos/photo-3.png'],
    ]);
  });

  it('every photo shown on a screen has the link to the file the model read, and a hidden photo has none', () => {
    for (const view of [walkthrough, copy]) {
      const claim = screenModel('claim', view);
      const rows = [...claim.groups.claim!, ...claim.groups.tray!];
      expect(rows.length).toBe(7);
      for (const { fields } of rows) {
        expect(fields.photo!.hidden).toBe(false);
        expect(fields.photo!.src).toMatch(/^\/demo\/ridgeway\/screen\/photo-\d\.jpg$/);
        expect(fields.photo_file).toEqual({ href: fields.photo!.src!.replace('/screen/', '/photos/').replace(/\.jpg$/, '.png'), hidden: false });
      }
      const promised = screenModel('promised', view).fields;
      expect(promised.photos_preview!.hidden).toBe(false);
      expect(promised.photos_preview_file!.hidden).toBe(false);
    }
    // A case made from JSON has no photos: no picture and no link
    for (const { fields } of screenModel('claim', plain).groups.claim!) expect([fields.photo, fields.photo_file]).toEqual([{ hidden: true }, { hidden: true }]);
    expect(screenModel('promised', plain).fields.photos_preview_file).toEqual({ hidden: true });
  });
});

describe('the photo mapper', () => {
  const photos = new Map([
    ['photo-1', { screen: '/demo/ridgeway/screen/photo-1.jpg', original: '/demo/ridgeway/photos/photo-1.png' }],
    ['photo-2', { screen: '/api/cases/c1/photos/photo-2.png', original: '/api/cases/c1/photos/photo-2.png' }],
  ]);
  it('shows the light copy and links the original', () => {
    expect(photoFields(photos, 'photo-1', 'Fuse box', 'Fuse box')).toEqual({
      photo: { src: '/demo/ridgeway/screen/photo-1.jpg', alt: 'Fuse box', title: 'Fuse box', hidden: false },
      file: { href: '/demo/ridgeway/photos/photo-1.png', hidden: false },
    });
  });
  it('an uploaded photo without a light copy is shown and linked as itself', () => {
    expect(photoFields(photos, 'photo-2', 'x')).toEqual({ photo: { src: '/api/cases/c1/photos/photo-2.png', alt: 'x', hidden: false }, file: { href: '/api/cases/c1/photos/photo-2.png', hidden: false } });
  });
  it.each([null, undefined, 'photo-9', 7])('no such photo (%s) → picture and link both hidden', (ref) => {
    expect(photoFields(photos, ref, 'x')).toEqual({ photo: { hidden: true }, file: { hidden: true } });
  });
});

describe('the server gives the light copy only for demo photos', () => {
  it('copies of the demo case carry screen_url next to the original url; uploads do not', () => {
    expect(walkthrough.photos?.map((p) => [p.url, p.screen_url])).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => [`/demo/ridgeway/photos/photo-${n}.png`, `/demo/ridgeway/screen/photo-${n}.jpg`]),
    );
    const { template: _demo, ...own } = copyRecord;
    const uploaded = caseView({ ...own, id: 'up1' }, NOW);
    expect(uploaded.photos?.[0]).toEqual({ id: 'photo-1', name: 'photo-1.png', url: '/api/cases/up1/photos/photo-1.png' });
  });

  it('on the walkthrough sends a judge to make their own copy, not to PayPal', () => {
    const { fields, waiting } = screenModel('claim', walkthrough);
    expect(fields.filing_url).toMatchObject({ text: 'Try it with your sandbox account', href: '/#try', action: '' });
    expect(fields.file_note!.text).toBe('This is the demo story, not a sandbox payment. Start your own copy to pay $3,700.00 in the PayPal sandbox.');
    expect(fields.case_notice!.hidden).toBe(false);
    expect(waiting).toBe(false);
  });

  it('on an unpaid copy offers the sandbox payment', () => {
    const { fields } = screenModel('claim', copy);
    expect(fields.filing_url).toMatchObject({ text: 'Pay $3,700.00 in the sandbox', action: 'pay' });
    expect(fields.paid_verb!.text).toBe('You pay');
    expect(fields.paid_line!.text).toBe('Not paid yet');
    expect(screenModel('claim', captured()).fields.paid_line!.text).toBe('Paid Nov 9 · PayPal Goods & Services');
    expect(fields.case_notice!.hidden).toBe(true);
    expect(fields.check_paypal!.hidden).toBe(true);
  });

  it('after the capture shows "File with PayPal" and the step text, and waits for the claim', () => {
    const { fields, waiting } = screenModel('claim', captured());
    expect(fields.filing_url).toMatchObject({ text: 'File with PayPal', href: 'https://www.sandbox.paypal.com/resolutioncenter', action: '', target: '_blank' });
    expect(fields.file_note!.text).toBe('On PayPal, file "Service not received" for $2,650.00, the amount shown. The app finds your claim within a few minutes (3 to 4 in our sandbox runs).');
    expect(fields.check_paypal).toEqual({ hidden: false, action: 'check' });
    expect(waiting).toBe(true);
  });

  it('once the claim is filed shows its status and the way to the contractor\'s answer', () => {
    const { fields } = screenModel('claim', filed());
    expect(fields.filing_url).toMatchObject({ text: 'Open your claim in PayPal', href: 'https://www.sandbox.paypal.com/resolutioncenter' });
    expect(fields.claim_status!.text).toBe("Claim PP-R-AAA-1: waiting for the contractor's answer");
    expect(fields.next_step).toEqual({ href: '/cases/copy1/offer', hidden: false });
  });
});

describe('offer', () => {
  it('before any claim, says so and offers no PayPal action', () => {
    const { fields } = screenModel('offer', copy);
    expect(fields.offer_title!.text).toBe('No claim filed yet');
    expect(fields.filed_line!.text).toBe('Not filed yet · claim ready: $2,650.00 · Service not received');
    for (const name of ['stand_in_offer', 'accept', 'escalate', 'stand_in_answer', 'adjudicate']) expect(fields[name]!.hidden, name).toBe(true);
  });

  it('once the claim exists, lets the sandbox contractor stand-in make an offer', () => {
    const { fields, groups } = screenModel('offer', filed());
    expect(fields.offer_title!.text).toBe('No offer from Ridgeway Electric yet');
    expect(fields.stand_in_offer).toEqual({ hidden: false, action: 'sim-offer' });
    expect(fields.escalate!.hidden).toBe(true);
    expect(groups.offer!.map((r) => [r.fields.item_title!.text, r.fields.item_claim_amount!.text, r.fields.verdict_status!.text])).toEqual([
      ['2 of 6 · Recessed LED lights', '$240', 'Partly'],
      ['Main panel upgrade to 200A', '$1,300', 'Not done'],
      ['LED flood lights over backyard (2)', '$460', 'Not done'],
      ['50A circuit for the EV charger in the garage', '$650', 'Not done'],
    ]);
  });

  it('with an offer, weighs it against the claim and gives the homeowner the choice', () => {
    const { fields } = screenModel('offer', filed({}, { offer: offer() }));
    expect(fields.offer_title!.text).toBe('Ridgeway Electric offered $1,200.00');
    expect(fields.filed_line!.text).toBe('You filed Nov 9 · $2,650.00 · Service not received');
    expect(fields.read_note!.text).toBe('The offer leaves $1,450.00 of unfinished work unpaid. Photos show 3 promised items not done and 1 partly done.');
    expect(fields.accept).toMatchObject({ hidden: false, href: 'https://www.sandbox.paypal.com/resolutioncenter', target: '_blank' });
    expect(fields.accept_amount!.text).toBe('$1,200.00');
    expect(fields.escalate).toEqual({ hidden: false, action: 'escalate' });
    expect(fields.stand_in_offer!.hidden).toBe(true);
  });

  it('after the escalation, the stand-in answers PayPal first, then PayPal can be asked to decide (sandbox only)', () => {
    const waitingForSeller = screenModel('offer', filed({ life_cycle_stage: 'CHARGEBACK' }, { offer: offer('canceled') })).fields;
    expect(waitingForSeller.stand_in_answer).toEqual({ hidden: false, action: 'sim-evidence' });
    expect(waitingForSeller.adjudicate!.hidden).toBe(true);
    expect(waitingForSeller.accept!.hidden).toBe(true);
    const underReview = screenModel('offer', filed({ life_cycle_stage: 'CHARGEBACK', status: 'UNDER_REVIEW' }, { offer: offer('canceled') })).fields;
    expect(underReview.adjudicate).toEqual({ hidden: false, action: 'adjudicate' });
    expect(underReview.stand_in_answer!.hidden).toBe(true);
    const closed = screenModel('offer', filed({ status: 'RESOLVED' }, { offer: offer('accepted') })).fields;
    for (const name of ['stand_in_offer', 'accept', 'escalate', 'stand_in_answer', 'adjudicate']) expect(closed[name]!.hidden, name).toBe(true);
  });

  it('says when an offer covers the whole claim', () => {
    expect(screenModel('offer', filed({}, { offer: offer('pending', '2650.00') })).fields.read_note!.text).toMatch(/^The offer covers the whole claim\./);
  });
});

describe('money back', () => {
  const outcome = (amount: string, reason: string | null = null) => ({ status: 'money_back', amount_refunded: amount, refund_destination: 'the payment method you used', decided_at: '2026-11-09T11:40:00Z', outcome_code: 'RESOLVED_BUYER_FAVOUR', outcome_reason: reason });

  it('shows the refund, the steps and what the contractor kept', () => {
    const view = filed({ status: 'RESOLVED', life_cycle_stage: 'CHARGEBACK', escalated_at: '2026-11-09T11:30:00Z' }, { offer: offer('canceled'), outcome: outcome('2650.00', 'INELIGIBLE_SELLER_PROTECTION_POLICY') });
    const { fields } = screenModel('money-back', view);
    expect(fields).toMatchObject({
      outcome_status: { state: 'money_back' },
      outcome_word: { text: 'Money back' },
      amount_refunded: { text: '+$2,650.00' },
      refund_note: { text: 'refunded to you · back to the payment method you used' },
      step_filed_text: { text: 'Nov 9 · You filed in PayPal · $2,650.00' },
      step_offer_text: { text: 'Nov 9 · Offer $1,200.00 · canceled' },
      step_sent_text: { text: 'Nov 9 · Sent to PayPal' },
      step_decided_text: { text: 'Nov 9 · Decided in your favor' },
      kept_title: { text: 'Kept by Ridgeway Electric: $1,050.00' },
      kept_sub: { text: 'for work the photos prove' },
    });
    for (const step of ['step_filed', 'step_offer', 'step_sent', 'step_decided']) expect(fields[step]!.state).toBe('done');
  });

  it('after an accepted offer, what the contractor kept is more than the photos prove, and says so', () => {
    const { fields } = screenModel('money-back', filed({ status: 'RESOLVED' }, { offer: offer('accepted'), outcome: outcome('1200.00', 'INQUIRY_OFFER_PARTIAL_REFUND') }));
    expect(fields.kept_title!.text).toBe('Kept by Ridgeway Electric: $2,500.00');
    expect(fields.kept_sub!.text).toBe('of which $1,050.00 is work the photos prove');
    expect(fields.step_decided_text!.text).toBe('Nov 9 · Offer accepted · refunded');
    expect(fields.step_sent!.state).toBe('pending');
  });

  it('before any refund, shows the steps still to come', () => {
    const { fields } = screenModel('money-back', copy);
    expect(fields.outcome_status).toEqual({ state: 'none' });
    expect(fields.amount_refunded).toEqual({ text: PLACEHOLDER });
    expect(fields.step_filed_text!.text).toBe('Not filed yet · claim ready: $2,650.00');
    expect(fields.kept_title!.text).toBe('Ridgeway Electric would keep $1,050.00');
    expect(fields.kept_sub!.text).toBe('for work the photos prove, once the claim is refunded');
    for (const step of ['step_filed', 'step_offer', 'step_sent', 'step_decided']) expect(fields[step]!.state).toBe('pending');
  });
});

describe('the walkthrough is the demo story, never a sandbox payment', () => {
  it.each(SCREENS)('%s says so plainly and shows no payment, filing or refund confirmed by PayPal', (screen) => {
    const model = screenModel(screen, walkthrough);
    expect(model.fields.case_notice).toEqual({
      text: 'This is the demo story, not a sandbox payment: nothing on this case was paid, filed or refunded in the PayPal sandbox. Start your own copy from the start page to pay $3,700.00 in the PayPal sandbox.',
      hidden: false,
    });
    const shown = [...texts(model), ...Object.values(model.groups).flat().flatMap((r) => Object.values(r.fields).map((f) => f.text ?? ''))].join(' | ');
    expect(shown).not.toMatch(/Paid with PayPal|PayPal Goods & Services|You filed|Claim PP-|refunded to you|Money back|Kept by/);
    for (const action of ['pay', 'capture', 'check', 'sim-offer', 'sim-evidence', 'escalate', 'adjudicate']) {
      const live = Object.values(model.fields).filter((f) => f.action === action && f.hidden !== true);
      expect(live, `${screen} ${action}`).toEqual([]);
    }
  });

  it('keeps the story numbers on the claim screen and names where they come from', () => {
    const { fields } = screenModel('claim', walkthrough);
    expect(fields.paid_amount_short!.text).toBe('$3,700');
    expect(fields.paid_line!.text).toBe('Paid Sep 12');
    expect(screenModel('promised', walkthrough).fields.method_line!.text).toBe('Paid in the demo story, not through PayPal');
    expect(screenModel('offer', walkthrough).fields.claim_note_1!.text).toBe('The demo story: not a sandbox payment');
  });

  it('the server keeps the walkthrough unpaid: no payment, claim or refund in its view', () => {
    expect(walkthrough.case.payment).toBeNull();
    expect(walkthrough.dispute).toBeNull();
    expect(walkthrough.outcome).toBeNull();
    expect(walkthrough.case.read_only).toBe(true);
  });
});

describe('amounts the screens show come from the server', () => {
  it('the offer\'s gap and what the contractor keeps are in the case view, and the screens only show them', () => {
    const withOffer = filed({}, { offer: offer() });
    expect(withOffer.amounts).toEqual({ filed_claim: '2650.00', offer_gap: '1450.00', kept_by_contractor: '1050.00' });
    // a tampered view shows its own numbers: the screen does no arithmetic of its own
    const odd = { ...withOffer, amounts: { ...withOffer.amounts, offer_gap: '7.00' } };
    expect(screenModel('offer', odd).fields.read_note!.text).toMatch(/^The offer leaves \$7\.00 of unfinished work unpaid\./);
    const accepted = filed({ status: 'RESOLVED' }, { offer: offer('accepted'), outcome: { status: 'money_back', amount_refunded: '1200.00', refund_destination: 'the payment method you used', decided_at: null, outcome_code: null, outcome_reason: null } });
    expect(accepted.amounts.kept_by_contractor).toBe('2500.00');
    expect(screenModel('money-back', { ...accepted, amounts: { ...accepted.amounts, kept_by_contractor: '9.00' } }).fields.kept_title!.text).toBe('Kept by Ridgeway Electric: $9.00');
  });

  it('shows the short titles the server made, with the full title kept as the element\'s title', () => {
    const { groups } = screenModel('promised', walkthrough);
    expect(groups.promised![0]!.fields.title).toEqual({ text: 'GFCI outlets (4)', title: 'GFCI outlets, kitchen and bath (4)' });
    const odd = { ...walkthrough, item_titles: { ...walkthrough.item_titles, '1': { short: 'Server short', name: 'Server name' } } };
    expect(screenModel('promised', odd).groups.promised![0]!.fields.title!.text).toBe('Server short');
    expect(screenModel('claim', odd).groups.tray![0]!.fields.item_title!.text).toBe('Server short');
  });
});
