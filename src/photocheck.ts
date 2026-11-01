// POST /api/cases/analyze: the uploaded estimate, texts and job-site photos go through the photo-checking core,
// and what it finds becomes a case the same way a JSON case does (CaseService.createCase).
import { analyzeCase, type Analysis, type CaseInput as CoreInput } from './core/analyze.js';
import { parseEstimate } from './core/estimate.js';
import { parseTexts } from './core/extract.js';
import { HttpError, invalid } from './errors.js';
import { LIMITS } from './input.js';
import { readIntake, type Intake, type UploadLimits } from './intake.js';
import type { PromisedItem, Verdict } from './model.js';
import { ModelError, type VisionModel } from './models/vision.js';
import { TITLE_LIMIT } from './paypal/orders.js';
import type { CaseService, CaseView } from './service.js';
import type { UploadStore } from './uploads.js';

export interface PhotoCheckDeps {
  service: CaseService;
  model: VisionModel;
  uploads: UploadStore;
  limits: UploadLimits;
  log: (message: string) => void;
}

export type AnalyzedCaseView = CaseView & { analysis: { warnings: string[]; timings: Analysis['timings'] } };

/** Text the model wrote, cut to `max` characters, ending in "…"; the cut never falls between the two halves of a surrogate pair. */
function fit(text: string, max: number, label: string, warnings: string[]): string {
  if (text.length <= max) return text;
  warnings.push(`${label} was longer than ${max} characters and is shortened`);
  let cut = text.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

async function coreInput(intake: Intake): Promise<CoreInput> {
  let estimate;
  try {
    estimate = await parseEstimate(intake.estimate.bytes);
  } catch (error) {
    throw invalid(`the estimate could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return {
    estimate,
    texts: parseTexts(intake.texts),
    payment: { date: intake.paid_at, amount: intake.paid_amount, method: '', payee: intake.payee_name, transaction_id: null },
    photos: intake.photos.map((photo) => ({ id: photo.id, image: photo.bytes })),
  };
}

/**
 * The order matters: everything is read and checked first, then the model runs, and only then are files written and the case stored.
 * A failure at any step leaves no case and no files.
 */
export async function analyzeUpload(deps: PhotoCheckDeps, request: Request): Promise<AnalyzedCaseView> {
  const intake = await readIntake(request, deps.limits);
  const input = await coreInput(intake);

  let analysis: Analysis;
  try {
    analysis = await analyzeCase(input, { model: deps.model, judgeMode: 'whole' });
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    deps.log(`photo check failed (${error.kind}): ${error.message}`);
    throw new HttpError(502, 'PHOTO_CHECK_FAILED', `the photo check failed (${error.kind}): ${error.message}`);
  }

  const warnings = [...analysis.warnings];
  if (input.texts.some((message) => message.date === null)) {
    warnings.push('texts: the first line is not in the form "YYYY-MM-DD · Sender: message"; it was read as a message without a date');
  }
  if (!analysis.promised_items.length) {
    throw new HttpError(422, 'NO_PROMISED_ITEMS', `no promised items could be read from the estimate and the texts${warnings.length ? `: ${warnings.join('; ')}` : ''}`);
  }
  const promised_items: PromisedItem[] = analysis.promised_items.map((item) => ({
    ...item,
    title: fit(item.title, TITLE_LIMIT, `item ${item.id}: title`, warnings), // the title becomes the name of the item on the PayPal order
    source: { ...item.source, quote: fit(item.source.quote, LIMITS.maxString, `item ${item.id}: quote`, warnings) },
  }));
  const verdicts: Verdict[] = analysis.verdicts.map((verdict) => ({ ...verdict, note: fit(verdict.note, LIMITS.maxString, `item ${verdict.item_id}: note`, warnings) }));

  const id = deps.service.newCaseId();
  const uploads = await deps.uploads.save(id, [intake.estimate, ...intake.photos]);
  let view: CaseView;
  try {
    view = await deps.service.createCase({ payee_name: intake.payee_name, paid_at: intake.paid_at, promised_items, verdicts }, { id, uploads });
  } catch (error) {
    await deps.uploads.remove(id).catch((removeError) => deps.log(`could not remove the uploads of case ${id}: ${removeError instanceof Error ? removeError.message : String(removeError)}`));
    // The request was fine; what the model found is what the case cannot take (no items, too many items, a price of zero, ...)
    if (error instanceof HttpError && error.status === 400) throw new HttpError(422, 'PUNCH_LIST_NOT_USABLE', `the photo check found a punch list the case cannot take: ${error.message}`);
    throw error;
  }
  return { ...view, analysis: { warnings, timings: analysis.timings } };
}
