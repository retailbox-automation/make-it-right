// Reads the multipart body of POST /api/cases/analyze into one checked value.
// Anything wrong is a 400 that says what, or a 413 when it is about size. Files are told apart by their first bytes, never by name.
import { estimateKind } from './core/estimate.js';
import { HttpError, invalid } from './errors.js';
import { isCalendarDay, parseAmount, short } from './input.js';
import { fromCents } from './money.js';
import type { UploadedFile } from './uploads.js';

const MIB = 1024 * 1024;

export interface UploadLimits {
  maxFileBytes: number;
  /** The estimate and all photos together */
  maxTotalBytes: number;
  maxPhotos: number;
}

export const UPLOAD_LIMITS: UploadLimits = { maxFileBytes: 10 * MIB, maxTotalBytes: 50 * MIB, maxPhotos: 20 };
/** About a month of messages between a homeowner and a contractor */
export const MAX_TEXTS_CHARS = 20_000;
/** Room for the form fields and the part headers on top of the files */
const FORM_OVERHEAD_BYTES = MIB;

/** The biggest request body the route reads */
export const maxBodyBytes = (limits: UploadLimits): number => limits.maxTotalBytes + FORM_OVERHEAD_BYTES;

export const sizeText = (bytes: number): string => (bytes >= MIB && bytes % MIB === 0 ? `${bytes / MIB} MB` : `${bytes} bytes`);

export interface IntakePhoto extends UploadedFile {
  /** "photo-1".."photo-N", in the order the photos were added; the names the verdicts use */
  id: string;
}

export interface Intake {
  payee_name: string;
  /** "4200.00" */
  paid_amount: string;
  /** YYYY-MM-DD */
  paid_at: string;
  /** One message per line, as in texts.txt; empty when there are none */
  texts: string;
  estimate: UploadedFile;
  photos: IntakePhoto[];
}

const FIELDS = new Set(['payee_name', 'paid_amount', 'paid_at', 'texts', 'estimate', 'photos']);
const EXTENSION = { pdf: 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' } as const;

const tooLarge = (message: string) => new HttpError(413, 'PAYLOAD_TOO_LARGE', message);

/** The only value of a field that may be given once; undefined when it is missing */
function once(form: FormData, name: string): FormDataEntryValue | undefined {
  const values = form.getAll(name);
  if (values.length > 1) throw invalid(`${name} must be given once`);
  return values[0];
}

function textField(form: FormData, name: string): string | undefined {
  const value = once(form, name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${name} must be text, not a file`);
  return value;
}

export async function readIntake(request: Request, limits: UploadLimits): Promise<Intake> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw invalid('the request body must be multipart/form-data');
  }
  for (const name of new Set(form.keys())) if (!FIELDS.has(name)) throw invalid(`unknown field "${name}"`);

  const payee = textField(form, 'payee_name');
  if (payee === undefined || !payee.trim()) throw invalid('payee_name is required');
  short(payee, 'payee_name');

  const paidAmount = textField(form, 'paid_amount');
  if (paidAmount === undefined) throw invalid('paid_amount is required');
  const cents = parseAmount(paidAmount, 'paid_amount');
  if (cents < 1) throw invalid('paid_amount must be more than zero');

  const paidAt = textField(form, 'paid_at');
  if (paidAt === undefined) throw invalid('paid_at is required');
  if (!isCalendarDay(paidAt)) throw invalid('paid_at must be a date like 2026-09-12');

  // A form sends every line break as CR LF
  const texts = (textField(form, 'texts') ?? '').replace(/\r\n/g, '\n');
  short(texts, 'texts', MAX_TEXTS_CHARS);

  const estimateEntry = once(form, 'estimate');
  if (estimateEntry === undefined) throw invalid("estimate is required: the contractor's estimate as a PDF, JPEG or PNG file");
  const photoEntries = form.getAll('photos');
  if (photoEntries.length === 0) throw invalid('at least one photo is required');
  if (photoEntries.length > limits.maxPhotos) throw invalid(`at most ${limits.maxPhotos} photos can be checked at once`);

  const parts = [{ label: 'estimate', entry: estimateEntry }, ...photoEntries.map((entry, index) => ({ label: `photo ${index + 1}`, entry }))];
  let total = 0;
  for (const { label, entry } of parts) {
    if (typeof entry === 'string') throw invalid(`${label} must be a file`);
    if (entry.size > limits.maxFileBytes) throw tooLarge(`${label} is larger than ${sizeText(limits.maxFileBytes)}`);
    total += entry.size;
  }
  if (total > limits.maxTotalBytes) throw tooLarge(`the files together are larger than ${sizeText(limits.maxTotalBytes)}`);

  const read = async (entry: FormDataEntryValue) => Buffer.from(await (entry as File).arrayBuffer());

  const estimateBytes = await read(estimateEntry);
  const estimateType = estimateKind(estimateBytes);
  if (!estimateType) throw invalid('estimate is not a PDF, JPEG or PNG file (checked by its first bytes, not its name)');

  const photos: IntakePhoto[] = [];
  for (const [index, entry] of photoEntries.entries()) {
    const bytes = await read(entry);
    const type = estimateKind(bytes);
    if (type !== 'image/jpeg' && type !== 'image/png') throw invalid(`photo ${index + 1} is not a JPEG or PNG image (checked by its first bytes, not its name)`);
    const id = `photo-${index + 1}`;
    photos.push({ id, name: `${id}.${EXTENSION[type]}`, bytes });
  }

  return {
    payee_name: payee.trim(),
    paid_amount: fromCents(cents),
    paid_at: paidAt,
    texts,
    estimate: { name: `estimate.${EXTENSION[estimateType]}`, bytes: estimateBytes },
    photos,
  };
}
