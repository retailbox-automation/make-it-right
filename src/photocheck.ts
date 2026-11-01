// POST /api/cases/analyze: the uploaded estimate, texts and job-site photos go through the photo-checking core,
// and what it finds becomes a case the same way a JSON case does (CaseService.createCase).
import { analyzeCase, type Analysis, type CaseInput as CoreInput } from './core/analyze.js';
import { EstimateTooComplexError, parseEstimate } from './core/estimate.js';
import { parseTexts } from './core/extract.js';
import { HttpError, invalid } from './errors.js';
import { LIMITS } from './input.js';
import type { Intake } from './intake.js';
import type { PromisedItem, Verdict } from './model.js';
import { toCents } from './money.js';
import { ModelError, type VisionModel } from './models/vision.js';
import { TITLE_LIMIT } from './paypal/orders.js';
import type { CaseService, CaseView } from './service.js';
import { UploadQuotaError, type UploadStore } from './uploads.js';

export interface PhotoCheckDeps {
  service: CaseService;
  model: VisionModel;
  uploads: UploadStore;
  log: (message: string) => void;
}

export type AnalyzedCaseView = CaseView & { analysis: { warnings: string[]; timings: Analysis['timings'] } };

/** Warnings kept with a case: this many, each cut to the usual text limit (they can quote what the model wrote) */
const MAX_WARNINGS = 50;

/** Text the model wrote, cut to `max` characters, ending in "…"; the cut never falls between the two halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}…`;
}

function fit(text: string, max: number, label: string, warnings: string[]): string {
  if (text.length <= max) return text;
  warnings.push(`${label} was longer than ${max} characters and is shortened`);
  return cut(text, max);
}

async function coreInput(intake: Intake): Promise<CoreInput> {
  let estimate;
  try {
    estimate = await parseEstimate(intake.estimate.bytes);
  } catch (error) {
    if (error instanceof EstimateTooComplexError) throw new HttpError(400, 'ESTIMATE_TOO_COMPLEX', `the estimate is too complex to read: ${error.message}`);
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
 * Makes what the model found into something a case accepts, wherever that can be done without guessing:
 * an item that costs nothing is left off the list (its verdict goes with it), a quantity over the limit counts as 1
 * (the price is the total for the item anyway), and text longer than a case takes is shortened. Each change is a warning.
 * Ids stay as they were, so the numbers in the warnings still match; a dropped item leaves a gap.
 */
function fixFindings(found: Pick<Analysis, 'promised_items' | 'verdicts'>, warnings: string[]): { promised_items: PromisedItem[]; verdicts: Verdict[] } {
  const promised_items: PromisedItem[] = [];
  const verdicts: Verdict[] = [];
  for (const item of found.promised_items) {
    const title = fit(item.title, TITLE_LIMIT, `item ${item.id}: title`, warnings); // the title becomes the name of the item on the PayPal order
    if (toCents(item.price) === 0) {
      warnings.push(`item ${item.id} ("${cut(title, 60)}"): the price is $0.00, so it is left off the punch list`);
      continue;
    }
    let qty = item.qty;
    let verdict = found.verdicts.find((v) => v.item_id === item.id);
    if (qty > LIMITS.maxQty) {
      warnings.push(`item ${item.id}: quantity ${qty} is more than ${LIMITS.maxQty}; it is counted as 1, and the price is the total for the item`);
      qty = 1;
      if (verdict) {
        // The count of finished units was for the old quantity. Done stays done; a part of it cannot be told, so it stays in the claim.
        const status = verdict.status === 'partial' ? 'not_done' : verdict.status;
        if (verdict.status === 'partial') warnings.push(`item ${item.id}: "partly done" cannot be kept for a quantity of 1; it stays in the claim as not done`);
        verdict = { ...verdict, status, done_units: status === 'done' ? 1 : 0, fraction: null };
      }
    }
    promised_items.push({ ...item, title, qty, source: { ...item.source, quote: fit(item.source.quote, LIMITS.maxString, `item ${item.id}: quote`, warnings) } });
    if (verdict) verdicts.push({ ...verdict, note: fit(verdict.note, LIMITS.maxString, `item ${item.id}: note`, warnings) });
  }
  return { promised_items, verdicts };
}

/**
 * The order matters: everything is read and checked first, then the model runs, and only then are files written and the case stored.
 * A failure at any step leaves no case and no files. The caller has read the request already (`intake`), so the request itself,
 * which can hold 50 MB, need not stay in memory during the minutes the model takes.
 */
export async function analyzeUpload(deps: PhotoCheckDeps, intake: Intake): Promise<AnalyzedCaseView> {
  try {
    await deps.uploads.ensureRoom([intake.estimate, ...intake.photos].reduce((sum, f) => sum + f.bytes.length, 0));
  } catch (error) {
    if (!(error instanceof UploadQuotaError)) throw error;
    deps.log(`photo check refused: ${error.message}`);
    throw new HttpError(507, 'UPLOAD_QUOTA_EXCEEDED', 'the server has no room for more uploads right now');
  }
  const input = await coreInput(intake);

  let analysis: Analysis;
  try {
    analysis = await analyzeCase(input, { model: deps.model, judgeMode: 'whole' });
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    // The full message can name the model server's address or quote its answer: it goes to the log, the caller gets the kind only
    deps.log(`photo check failed (${error.kind}): ${error.message}`);
    throw new HttpError(502, 'PHOTO_CHECK_FAILED', `the photo check could not be completed (${error.kind}); try again in a few minutes`);
  }

  const warnings = [...analysis.warnings];
  if (input.texts.some((message) => message.date === null)) {
    warnings.push('texts: the first line is not in the form "YYYY-MM-DD · Sender: message"; it was read as a message without a date');
  }
  const { promised_items, verdicts } = fixFindings(analysis, warnings);
  const tidy = warnings.slice(0, MAX_WARNINGS).map((w) => cut(w, LIMITS.maxString));
  if (warnings.length > MAX_WARNINGS) tidy.push(`and ${warnings.length - MAX_WARNINGS} more`);
  if (!promised_items.length) {
    throw new HttpError(422, 'NO_PROMISED_ITEMS', `no promised items could be read from the estimate and the texts${tidy.length ? `: ${tidy.join('; ')}` : ''}`);
  }

  const id = deps.service.newCaseId();
  const uploads = await deps.uploads.save(id, [intake.estimate, ...intake.photos]);
  let view: CaseView;
  try {
    view = await deps.service.createCase(
      { payee_name: intake.payee_name, paid_at: intake.paid_at, promised_items, verdicts },
      { id, uploads, paid_amount: intake.paid_amount, warnings: tidy },
    );
  } catch (error) {
    await deps.uploads.remove(id).catch((removeError) => deps.log(`could not remove the uploads of case ${id}: ${removeError instanceof Error ? removeError.message : String(removeError)}`));
    // The request was fine; what the model found is what the case cannot take (too many items, a price too large to count, ...)
    if (error instanceof HttpError && error.status === 400) throw new HttpError(422, 'PUNCH_LIST_NOT_USABLE', `the photo check found a punch list the case cannot take: ${error.message}`);
    throw error;
  }
  return { ...view, analysis: { warnings: tidy, timings: analysis.timings } };
}
