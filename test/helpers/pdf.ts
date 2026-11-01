// Small PDFs built byte by byte, for the tests that need streams, filters or a lying page count (makePdf in ../helpers.ts has none).
import { deflateRawSync, deflateSync } from 'node:zlib';

export const MIB = 1024 * 1024;

export interface PdfStream {
  /** Entries for the stream dictionary, for example "/Filter /FlateDecode" */
  dict?: string;
  data: Buffer;
  /** What /Length says; the real length unless a test wants it to lie */
  length?: number;
}

export interface PdfSpec {
  /** The content of page 1 (a stream), or the text to show on it */
  content: PdfStream | string;
  /** Pages in the file besides page 1, each showing "x" */
  morePages?: number;
  /** Pages with no content at all, after those: no stream for the page, so they cost the file very little */
  blankPages?: number;
  /** What the page tree's /Count says; the real number of pages unless a test wants it to lie */
  count?: number;
  /** Streams or dictionaries added as objects of their own after the pages */
  extra?: Array<PdfStream | string>;
  /** Entries added to the trailer, for example "/Encrypt << /Filter /Standard >>" */
  trailer?: string;
}

export const showText = (text: string) => Buffer.from(`BT /F1 11 Tf 60 740 Td (${text}) Tj ET`);

/** A valid PDF with the given page content; every object is written the way PDF readers expect, with a real cross-reference table. */
export function buildPdf(spec: PdfSpec): Buffer {
  const shown = 1 + (spec.morePages ?? 0);
  const pages = shown + (spec.blankPages ?? 0);
  const objects: Buffer[] = [];
  const stream = (s: PdfStream) =>
    Buffer.concat([Buffer.from(`<< ${s.dict ?? ''} /Length ${s.length ?? s.data.length} >>\nstream\n`, 'latin1'), s.data, Buffer.from('\nendstream', 'latin1')]);
  const text = (s: string) => Buffer.from(s, 'latin1');
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objects.push(text('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(text(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${spec.count ?? pages} >>`));
  objects.push(text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  pageIds.forEach((id, i) => {
    if (i >= shown) {
      objects.push(text('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'));
      objects.push(text('null')); // keeps the object numbers of the pages two apart
      return;
    }
    objects.push(text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`));
    const content = i === 0 ? spec.content : 'x';
    objects.push(stream(typeof content === 'string' ? { data: showText(content) } : content));
  });
  for (const extra of spec.extra ?? []) objects.push(typeof extra === 'string' ? text(extra) : stream(extra));

  const parts: Buffer[] = [text('%PDF-1.4\n')];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([text(`${i + 1} 0 obj\n`), body, text('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(text(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${spec.trailer ?? ''} >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** `mb` megabytes of spaces: a content stream that does nothing, as a "bomb" once compressed (about 1000 to 1) */
export const spaces = (mb: number) => Buffer.alloc(mb * MIB, 32);

export const flate = (data: Buffer): Buffer => deflateSync(data);

/** A zlib stream whose first block is `lead` stored as it is, followed by the deflated `rest`: what a reader that looks for "endstream" would stop at */
export function flateAfter(lead: string, rest: Buffer): Buffer {
  const first = Buffer.from(lead, 'latin1');
  const stored = Buffer.concat([Buffer.from([0x00, first.length & 255, first.length >> 8, ~first.length & 255, (~first.length >> 8) & 255]), first]);
  let a = 1;
  let b = 0;
  for (const byte of Buffer.concat([first, rest])) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  return Buffer.concat([Buffer.from([0x78, 0x01]), stored, deflateRawSync(rest), adler]);
}

/** ASCII85 with "~>" at the end, as some PDF writers wrap their compressed streams */
export function ascii85(data: Buffer): Buffer {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    const padded = Buffer.concat([chunk, Buffer.alloc(4 - chunk.length)]);
    let n = padded.readUInt32BE(0);
    if (n === 0 && chunk.length === 4) {
      out += 'z';
      continue;
    }
    const digits: string[] = [];
    for (let d = 0; d < 5; d++) {
      digits.unshift(String.fromCharCode((n % 85) + 33));
      n = Math.floor(n / 85);
    }
    out += digits.slice(0, chunk.length + 1).join('');
  }
  return Buffer.from(`${out}~>`, 'latin1');
}

export const asciiHex = (data: Buffer): Buffer => Buffer.from(`${data.toString('hex')}>`, 'latin1');
