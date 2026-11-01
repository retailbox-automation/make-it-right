// A photo-check upload built from test/fixtures/case-mini, and the model answers that fit that job.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MINI = fileURLToPath(new URL('../fixtures/case-mini/', import.meta.url));
const read = (name: string) => readFileSync(MINI + name);

const payment = JSON.parse(read('payment.json').toString('utf8')) as { date: string; amount: string; payee: string };
const truth = JSON.parse(read('truth.json').toString('utf8')) as {
  promised_items: Array<{ title: string; qty: number; price: string; source: unknown }>;
};

/** The job on disk: Harbor Plumbing & Bath, $2,200.00 paid on 2026-08-12; the files are photo-2.png and photo-10.png there */
export const MINI_JOB = {
  payee: payment.payee,
  amount: payment.amount,
  date: payment.date,
  texts: read('texts.txt').toString('utf8'),
  estimate: read('estimate.pdf'),
  photos: [read('photos/photo-2.png'), read('photos/photo-10.png')],
};

export const file = (bytes: Uint8Array, name: string, type = 'application/octet-stream') => new File([new Uint8Array(bytes)], name, { type });

/** The form for the mini job; the photos are added in the order of MINI_JOB.photos, so the first one is photo-1 */
export function miniForm(): FormData {
  const form = new FormData();
  form.set('payee_name', MINI_JOB.payee);
  form.set('paid_amount', MINI_JOB.amount);
  form.set('paid_at', MINI_JOB.date);
  form.set('texts', MINI_JOB.texts);
  form.set('estimate', file(MINI_JOB.estimate, 'estimate.pdf', 'application/pdf'));
  MINI_JOB.photos.forEach((bytes, index) => form.append('photos', file(bytes, `IMG_${index}.png`, 'image/png')));
  return form;
}

/** What a model that reads the mini job correctly answers to the first call (the promised items) */
export const MINI_EXTRACTED = { items: truth.promised_items.map(({ title, qty, price, source }) => ({ title, qty, price, source })) };

/** ... and to the second (the verdicts): the toilet is done (photo-1), two of three doors are hung (photo-2), no photo shows the tile */
export const MINI_JUDGED = {
  verdicts: [
    { item_id: '1', photo_ref: 'photo-1', note: 'toilet in place', status: 'done', done_units: 1 },
    { item_id: '2', photo_ref: 'photo-2', note: 'two doors hung', status: 'partial', done_units: 2 },
    { item_id: '3', photo_ref: '', note: 'no photo of the tile', status: 'unclear', done_units: 0 },
  ],
};
