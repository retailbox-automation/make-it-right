// Read the contractor's estimate: a PDF gives its text layer (rows rebuilt by position on the page);
// an image (photo of a paper estimate) is kept as an image for the model. No OCR here.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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

export function estimateKind(bytes: Uint8Array): 'pdf' | 'image/jpeg' | 'image/png' | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export async function parseEstimate(bytes: Uint8Array): Promise<Estimate> {
  const kind = estimateKind(bytes);
  if (kind === null) throw new Error('estimate is not a PDF, JPEG or PNG file');
  if (kind !== 'pdf') return { kind: 'image', mime: kind, image: Buffer.from(bytes) };

  // pdfjs takes ownership of the buffer it is given, so pass a copy.
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: STANDARD_FONTS });
  try {
    const doc = await task.promise;
    const rows: EstimateRow[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pieces: Array<{ x: number; y: number; s: string }> = [];
      for (const it of content.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        pieces.push({ x: it.transform[4] as number, y: it.transform[5] as number, s: it.str });
      }
      for (const text of joinRows(pieces)) rows.push({ page: p, text });
    }
    return { kind: 'pdf', pages: doc.numPages, rows };
  } finally {
    await task.destroy();
  }
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
