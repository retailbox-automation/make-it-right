// Test helpers: a fake model (no network) and a tiny PDF writer for estimates with a text layer.
import type { VisionModel, VisionRequest } from '../src/models/vision.js';

export interface FakeModel extends VisionModel {
  requests: VisionRequest[];
}

/** Answers with the queued values in order (or by calling the function with the request). Errors in the queue are thrown. */
export function fakeModel(answers: Array<unknown | Error | ((req: VisionRequest) => unknown)>): FakeModel {
  const queue = [...answers];
  const requests: VisionRequest[] = [];
  return {
    name: 'fake',
    requests,
    async json<T>(req: VisionRequest) {
      requests.push(req);
      if (!queue.length) throw new Error('fake model: no answer queued');
      let a = queue.shift();
      if (typeof a === 'function') a = (a as (r: VisionRequest) => unknown)(req);
      if (a instanceof Error) throw a;
      return { value: a as T, ms: 5, raw: JSON.stringify(a) };
    },
  };
}

export interface PdfText {
  x: number;
  y: number;
  text: string;
}

/** A valid PDF with Helvetica text at the given positions, one array per page. */
export function makePdf(pages: PdfText[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((texts, i) => {
    const content = texts.map((t) => `BT /F1 11 Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`).join('\n');
    objs[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objs[pageIds[i]! + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** 1×1 PNG and a JPEG header: enough for type detection. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
