// Read the contractor's estimate: a PDF gives its text layer (rows rebuilt by position on the page);
// an image (photo of a paper estimate) is kept as an image for the model. No OCR here.
// A PDF is untrusted input, so it is read within limits: its streams are sized up before pdf.js opens it (src/core/pdf-guard.ts),
// and pdf.js runs in a worker thread that is stopped when it reads too many pages, too much text or takes too long.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { checkPdfBudget, EstimateTooComplexError } from './pdf-guard.js';

export { EstimateTooComplexError };

export interface EstimateRow {
  page: number;
  text: string;
}

export type Estimate =
  | { kind: 'pdf'; pages: number; rows: EstimateRow[] }
  | { kind: 'image'; mime: 'image/jpeg' | 'image/png'; image: Buffer };

const require = createRequire(import.meta.url);
const STANDARD_FONTS = join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';

/** Rows on the same page closer than this (in PDF points) vertically are one row. */
const SAME_ROW = 2;

const MIB = 1024 * 1024;

export interface EstimateLimits {
  maxPages: number;
  /** Characters of text, all pages together */
  maxChars: number;
  /** What all compressed streams may unpack to */
  maxInflatedBytes: number;
  /** Places where stream data starts */
  maxStreams: number;
  /** Wall-clock time for reading the PDF's text */
  timeoutMs: number;
}

export const ESTIMATE_LIMITS: EstimateLimits = { maxPages: 20, maxChars: 50_000, maxInflatedBytes: 20 * MIB, maxStreams: 5000, timeoutMs: 10_000 };

const WORKER = new URL('./pdf-text-worker.mjs', import.meta.url);

interface Piece {
  x: number;
  y: number;
  s: string;
}

type WorkerAnswer = { ok: true; numPages: number; pages: Piece[][] } | { ok: false; reason: 'too_complex' | 'unreadable'; message: string };

/** pdf.js in a worker thread of its own; the thread is stopped when it answers, fails or runs out of time */
function readPdfText(bytes: Uint8Array, limits: EstimateLimits): Promise<{ numPages: number; pages: Piece[][] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      // the thread gets its own copy of the bytes
      workerData: { bytes: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS, maxPages: limits.maxPages, maxChars: limits.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new EstimateTooComplexError(`reading it took longer than ${limits.timeoutMs / 1000} seconds`))),
      limits.timeoutMs,
    );
    worker.once('message', (answer: WorkerAnswer) =>
      finish(() => {
        if (answer.ok) resolve(answer);
        else reject(answer.reason === 'too_complex' ? new EstimateTooComplexError(answer.message) : new Error(answer.message));
      }),
    );
    worker.once('error', (error: NodeJS.ErrnoException) =>
      finish(() => reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new EstimateTooComplexError('reading it needs more memory than is allowed') : error)),
    );
    worker.once('exit', () => finish(() => reject(new Error('the PDF reader stopped without an answer'))));
  });
}

export function estimateKind(bytes: Uint8Array): 'pdf' | 'image/jpeg' | 'image/png' | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** `limits` are for tests; an image is not read, so the limits do not apply to it. Too much work → EstimateTooComplexError. */
export async function parseEstimate(bytes: Uint8Array, limits: Partial<EstimateLimits> = {}): Promise<Estimate> {
  const kind = estimateKind(bytes);
  if (kind === null) throw new Error('estimate is not a PDF, JPEG or PNG file');
  if (kind !== 'pdf') return { kind: 'image', mime: kind, image: Buffer.from(bytes) };

  const all = { ...ESTIMATE_LIMITS, ...limits };
  checkPdfBudget(bytes, all);
  const { numPages, pages } = await readPdfText(bytes, all);
  const rows: EstimateRow[] = [];
  pages.forEach((pieces, index) => {
    for (const text of joinRows(pieces)) rows.push({ page: index + 1, text });
  });
  return { kind: 'pdf', pages: numPages, rows };
}

export async function readEstimate(file: string): Promise<Estimate> {
  return parseEstimate(await readFile(file));
}

/** Text pieces with page coordinates → rows top to bottom, pieces left to right. */
export function joinRows(pieces: Array<{ x: number; y: number; s: string }>): string[] {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Array<{ y: number; parts: Array<{ x: number; s: string }> }> = [];
  for (const p of sorted) {
    const last = rows.at(-1);
    if (last && Math.abs(last.y - p.y) <= SAME_ROW) last.parts.push(p);
    else rows.push({ y: p.y, parts: [p] });
  }
  return rows
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);
}

/** The estimate as plain text for a prompt: "Page 1:" then its rows. */
export function estimateText(est: Extract<Estimate, { kind: 'pdf' }>): string {
  const out: string[] = [];
  for (let p = 1; p <= est.pages; p++) {
    out.push(`Page ${p}:`);
    for (const r of est.rows) if (r.page === p) out.push(r.text);
  }
  return out.join('\n');
}
