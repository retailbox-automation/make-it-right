// Hostile PDFs, built small in the test itself. None of them is opened by pdf.js unless a test says it should be.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESTIMATE_LIMITS, EstimateTooComplexError, estimateText, parseEstimate } from '../src/core/estimate.js';
import { checkPdfBudget } from '../src/core/pdf-guard.js';
import { makePdf } from './helpers.js';
import { ascii85, asciiHex, buildPdf, flate, flateAfter, MIB, showText, spaces } from './helpers/pdf.js';

const MINI = readFileSync(fileURLToPath(new URL('./fixtures/case-mini/estimate.pdf', import.meta.url)));
const GUARD = { maxInflatedBytes: ESTIMATE_LIMITS.maxInflatedBytes, maxStreams: ESTIMATE_LIMITS.maxStreams };
const pdfWithStream = (dict: string, data: Buffer) => buildPdf({ content: { dict, data } });
const tooComplex = (message: RegExp) => expect.objectContaining({ name: 'EstimateTooComplexError', message: expect.stringMatching(message) });

describe('checkPdfBudget', () => {
  describe('lets through the PDFs a contractor sends', () => {
    it('an estimate with a plain text layer, and one compressed the usual way', () => {
      expect(() => checkPdfBudget(MINI, GUARD)).not.toThrow();
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', flate(showText('Kitchen'))), GUARD)).not.toThrow();
    });

    it('streams wrapped in ASCII85 or hex around the compression, as some writers do', () => {
      const packed = flate(showText('Kitchen'));
      expect(() => checkPdfBudget(pdfWithStream('/Filter [/ASCII85Decode /FlateDecode]', ascii85(packed)), GUARD)).not.toThrow();
      expect(() => checkPdfBudget(pdfWithStream('/Filter [/ASCIIHexDecode /FlateDecode]', asciiHex(packed)), GUARD)).not.toThrow();
    });

    it('a stream whose checksum is wrong or missing, which pdf.js reads', () => {
      const packed = flate(showText('Kitchen'));
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', packed.subarray(0, packed.length - 4)), GUARD)).not.toThrow();
      const wrong = Buffer.from(packed);
      wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 0xff;
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', wrong), GUARD)).not.toThrow();
    });

    it('a few hundred small streams and 15 MB unpacked in all', () => {
      const many = buildPdf({ content: 'x', extra: Array.from({ length: 300 }, () => ({ dict: '/Filter /FlateDecode', data: flate(showText('page furniture')) })) });
      expect(() => checkPdfBudget(many, GUARD)).not.toThrow();
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', flate(spaces(15))), GUARD)).not.toThrow();
    });
  });

  describe('refuses', () => {
    it('a compressed stream of spaces that unpacks to far more than the budget', () => {
      const bomb = pdfWithStream('/Filter /FlateDecode', flate(spaces(40)));
      expect(bomb.length).toBeLessThan(MIB); // under a megabyte, as in the panel's finding
      expect(() => checkPdfBudget(bomb, GUARD)).toThrow(tooComplex(/unpacks to more than 20 MB/));
    });

    it('streams that add up to more than the budget, none of them over it alone', () => {
      const pdf = buildPdf({ content: { dict: '/Filter /FlateDecode', data: flate(spaces(12)) }, extra: [{ dict: '/Filter /FlateDecode', data: flate(spaces(12)) }] });
      expect(() => checkPdfBudget(pdf, GUARD)).toThrow(tooComplex(/more than 20 MB/));
    });

    it('a bomb whose data contains the word "endstream", and one whose /Length is wrong', () => {
      const data = flateAfter('endstream\nendobj\n', spaces(40));
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', data), GUARD)).toThrow(tooComplex(/more than 20 MB/));
      expect(() => checkPdfBudget(buildPdf({ content: { dict: '/Filter /FlateDecode', data: flate(spaces(40)), length: 12 } }), GUARD)).toThrow(tooComplex(/more than 20 MB/));
    });

    it('a bomb the dictionary does not mention, or mentions under a disguised name', () => {
      expect(() => checkPdfBudget(pdfWithStream('', flate(spaces(40))), GUARD)).toThrow(tooComplex(/more than 20 MB/));
      expect(() => checkPdfBudget(pdfWithStream('/Fil#74er /Fl#61teDecode', flate(spaces(40))), GUARD)).toThrow(tooComplex(/more than 20 MB/));
      expect(() => checkPdfBudget(pdfWithStream('/F /FlateDecode /Pad (1 0 obj)', flate(spaces(40))), GUARD)).toThrow(tooComplex(/more than 20 MB/));
    });

    it('a bomb packed twice, each layer small enough alone', () => {
      const twice = flate(flate(spaces(40)));
      expect(twice.length).toBeLessThan(100_000);
      expect(() => checkPdfBudget(pdfWithStream('/Filter [/FlateDecode /FlateDecode]', twice), GUARD)).toThrow(tooComplex(/more than 20 MB/));
    });

    it('a bomb inside an ASCII85 or hex wrapper', () => {
      const packed = flate(spaces(40));
      expect(() => checkPdfBudget(pdfWithStream('/Filter [/ASCII85Decode /FlateDecode]', ascii85(packed)), GUARD)).toThrow(tooComplex(/more than 20 MB/));
      expect(() => checkPdfBudget(pdfWithStream('/Filter [/ASCIIHexDecode /FlateDecode]', asciiHex(packed)), GUARD)).toThrow(tooComplex(/more than 20 MB/));
    });

    it('streams wrapped in too many layers', () => {
      let data: Buffer = showText('x');
      for (let i = 0; i < 7; i++) data = flate(data);
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', data), GUARD)).toThrow(tooComplex(/too many layers/));
    });

    it('compressed data that is damaged, because what it unpacks to cannot be known', () => {
      const damaged = Buffer.concat([Buffer.from([0x78, 0x9c, 0x07]), Buffer.alloc(20)]); // a zlib header, then a block of a type that does not exist
      expect(() => checkPdfBudget(pdfWithStream('/Filter /FlateDecode', damaged), GUARD)).toThrow(tooComplex(/damaged/));
    });

    it.each(['/Filter /LZWDecode', '/Filter /LZW#44ecode', '/Filter [/FlateDecode /RunLengthDecode]', '/Filter /RL ', '/Filter [/ASCII85Decode /BrotliDecode]', '/Filter [/Crypt]'])(
      'a filter that cannot be checked: %s',
      (dict) => {
        expect(() => checkPdfBudget(pdfWithStream(dict, Buffer.from('xxxx')), GUARD)).toThrow(tooComplex(/cannot be checked for size/));
      },
    );

    it('a filter that cannot be checked, named inside a compressed object stream', () => {
      const hidden = flate(Buffer.from('7 0 obj\n/LZWDecode\nendobj'));
      expect(() => checkPdfBudget(pdfWithStream('/Type /ObjStm /N 1 /First 8 /Filter /FlateDecode', hidden), GUARD)).toThrow(tooComplex(/LZWDecode/));
    });

    it('an encrypted PDF', () => {
      const encrypted = buildPdf({ content: 'x', trailer: '/Encrypt << /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>' });
      expect(() => checkPdfBudget(encrypted, GUARD)).toThrow(tooComplex(/\/Encrypt/));
    });

    it('more places where stream data starts than the limit', () => {
      const many = buildPdf({ content: 'x', extra: Array.from({ length: 30 }, () => ({ data: Buffer.from('abcxy') })) });
      expect(() => checkPdfBudget(many, { ...GUARD, maxStreams: 20 })).toThrow(tooComplex(/more than 20 streams/));
      expect(() => checkPdfBudget(many, { ...GUARD, maxStreams: 50 })).not.toThrow();
      const thousands = buildPdf({ content: 'x', extra: Array.from({ length: ESTIMATE_LIMITS.maxStreams + 1 }, () => ({ data: Buffer.from('abcxy') })) });
      expect(() => checkPdfBudget(thousands, GUARD)).toThrow(tooComplex(/more than 5000 streams/));
    });

    it('a file made to make the scan itself slow: thousands of "stream" markers inside one long stretch of text', () => {
      const marker = 'stream\n' + 'a'.repeat(92) + '\n';
      const slow = Buffer.from(`%PDF-1.4\n${marker.repeat(3000)}`, 'latin1');
      const started = performance.now();
      expect(() => checkPdfBudget(slow, GUARD)).toThrow(tooComplex(/too much text-like data/));
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });
});

describe('parseEstimate within limits', () => {
  const started = () => performance.now();
  const under = (since: number, ms: number) => expect(performance.now() - since).toBeLessThan(ms);

  it('still reads a normal estimate, plain or compressed', async () => {
    const plain = await parseEstimate(MINI);
    expect(plain.kind === 'pdf' && estimateText(plain)).toContain('Harbor Plumbing & Bath');
    const wrapped = await parseEstimate(pdfWithStream('/Filter [/ASCII85Decode /FlateDecode]', ascii85(flate(showText('Tile the floor')))));
    expect(wrapped).toEqual({ kind: 'pdf', pages: 1, rows: [{ page: 1, text: 'Tile the floor' }] });
  });

  it('reads 20 pages and refuses 21, before it opens a page', async () => {
    expect((await parseEstimate(buildPdf({ content: 'first', morePages: 19 }))).kind === 'pdf').toBe(true);
    const since = started();
    await expect(parseEstimate(buildPdf({ content: 'first', morePages: 20 }))).rejects.toThrow(tooComplex(/21 pages, and at most 20/));
    under(since, 5000);
  });

  it('refuses a document of tens of thousands of pages, which costs the file almost nothing, without opening a page', async () => {
    const pdf = buildPdf({ content: 'first', blankPages: 50_000 });
    expect(pdf.length).toBeLessThan(10 * MIB);
    const since = started();
    await expect(parseEstimate(pdf)).rejects.toThrow(tooComplex(/50001 pages, and at most 20/));
    under(since, 8000);
  });

  /** `count` one-letter runs, each placed on its own: pdf.js keeps them as separate items */
  const placed = (count: number, word: string) =>
    Buffer.from(`BT /F1 11 Tf\n${Array.from({ length: count }, (_, i) => `1 0 0 1 ${60 + (i % 400)} ${700 - (i % 600)} Tm (${word}) Tj`).join('\n')}\nET`);

  it('refuses a page with an endless text layer, and stops reading it', async () => {
    const since = started();
    await expect(parseEstimate(buildPdf({ content: { data: placed(60_000, 'a') } }))).rejects.toThrow(tooComplex(/more than 50000 characters/));
    under(since, 8000);
  });

  it('takes text that fits the cap', async () => {
    const est = await parseEstimate(buildPdf({ content: { data: placed(4_000, 'line') } })); // about 20 000 characters
    expect(est.kind === 'pdf' && est.rows.reduce((n, row) => n + row.text.length, 0)).toBeGreaterThan(10_000);
  });

  it('stops reading when it takes too long', async () => {
    const since = started();
    await expect(parseEstimate(MINI, { timeoutMs: 1 })).rejects.toThrow(tooComplex(/took longer than 0.001 seconds/));
    under(since, 3000);
  });

  it('refuses a bomb without opening it, quickly', async () => {
    const since = started();
    await expect(parseEstimate(pdfWithStream('/Filter /FlateDecode', flate(spaces(40))))).rejects.toThrow(tooComplex(/more than 20 MB/));
    under(since, 3000);
  });

  it('says "could not be read" for a PDF that is just broken, which is not the same as too complex', async () => {
    const error = await parseEstimate(Buffer.from('%PDF-1.4\ngarbage')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EstimateTooComplexError);
  });

  it('leaves images alone', async () => {
    expect((await parseEstimate(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { maxPages: 0, timeoutMs: 1 })).kind).toBe('image');
  });

  it('reads a long text layer split over a few pages the way makePdf wrote it', async () => {
    const est = await parseEstimate(makePdf([[{ x: 60, y: 700, text: 'Hello' }], [{ x: 60, y: 700, text: 'World' }]]));
    expect(est.kind === 'pdf' && est.rows).toEqual([
      { page: 1, text: 'Hello' },
      { page: 2, text: 'World' },
    ]);
  });
});
