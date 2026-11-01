// One job end to end: promised items → verdicts → the claim for exactly the unfinished work.
import type { Claim, PromisedItem, Verdict } from '../model.js';
import { computeClaim } from '../money.js';
import type { VisionModel } from '../models/vision.js';
import type { Estimate } from './estimate.js';
import { extractA0, extractWithModel, type Extraction, type PaymentInfo, type TextMessage } from './extract.js';
import { judgeA0, judgePerPhoto, judgeTrustTexts, judgeWhole, type Judgement, type Photo } from './judge.js';

export interface CaseInput {
  estimate: Estimate;
  texts: TextMessage[];
  payment: PaymentInfo;
  photos: Photo[];
}

/** whole / photo use the model; a0 (everything not done) and trust-texts (believe the contractor) are the lower bounds. */
export type JudgeMode = 'whole' | 'photo' | 'a0' | 'trust-texts';

export interface AnalyzeOptions {
  /** With a model the items are read by the model; without one, by rules (A0). */
  model?: VisionModel;
  judgeMode: JudgeMode;
  /** YYYY-MM-DD, for the day count of the 180-day window */
  today?: string;
}

export interface Analysis {
  promised_items: PromisedItem[];
  verdicts: Verdict[];
  claim: Claim;
  warnings: string[];
  timings: { extract_ms: number; judge_ms: number; total_ms: number; model_calls: number };
}

export async function extractItems(input: CaseInput, opts: AnalyzeOptions): Promise<Extraction> {
  return opts.model ? extractWithModel(opts.model, input.estimate, input.texts, input.payment) : extractA0(input.estimate, input.payment);
}

export async function judgeItems(items: PromisedItem[], input: CaseInput, opts: AnalyzeOptions): Promise<Judgement> {
  switch (opts.judgeMode) {
    case 'whole':
    case 'photo': {
      if (!opts.model) throw new Error(`judge mode "${opts.judgeMode}" needs a model`);
      return opts.judgeMode === 'whole' ? judgeWhole(opts.model, items, input.photos) : judgePerPhoto(opts.model, items, input.photos);
    }
    case 'a0':
      return judgeA0(items);
    case 'trust-texts':
      return judgeTrustTexts(items, input.texts, input.payment.payee);
  }
}

export function claimFor(items: PromisedItem[], verdicts: Verdict[], payment: PaymentInfo, today?: string): Claim {
  return computeClaim(items, verdicts, {
    payee_name: payment.payee,
    transaction_id: payment.transaction_id ?? null,
    paid_at: payment.date,
    method: payment.method,
    today,
  });
}

export async function analyzeCase(input: CaseInput, opts: AnalyzeOptions): Promise<Analysis> {
  const started = performance.now();
  const extraction = await extractItems(input, opts);
  const judgement = await judgeItems(extraction.items, input, opts);
  return {
    promised_items: extraction.items,
    verdicts: judgement.verdicts,
    claim: claimFor(extraction.items, judgement.verdicts, input.payment, opts.today),
    warnings: [...extraction.warnings, ...judgement.warnings],
    timings: {
      extract_ms: extraction.ms,
      judge_ms: judgement.ms,
      total_ms: Math.round(performance.now() - started),
      model_calls: (opts.model ? 1 : 0) + judgement.calls,
    },
  };
}
