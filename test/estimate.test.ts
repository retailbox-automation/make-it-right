import { describe, expect, it } from 'vitest';
import { estimateKind, estimateText, joinRows, parseEstimate } from '../src/core/estimate.js';
import { JPEG_HEAD, makePdf, PNG_1PX } from './helpers.js';

describe('estimate', () => {
  it('tells a PDF from a JPEG or PNG by its first bytes', () => {
    expect(estimateKind(Buffer.from('%PDF-1.4\n'))).toBe('pdf');
    expect(estimateKind(JPEG_HEAD)).toBe('image/jpeg');
    expect(estimateKind(PNG_1PX)).toBe('image/png');
    expect(estimateKind(Buffer.from('hello'))).toBeNull();
    expect(estimateKind(Buffer.alloc(0))).toBeNull();
  });

  it('rebuilds rows by vertical position, pieces left to right, small jitter on one row', () => {
    const rows = joinRows([
      { x: 400, y: 598, s: '4' },
      { x: 60, y: 598.8, s: 'GFCI outlets' },
      { x: 510, y: 597.5, s: '$260.00' },
      { x: 60, y: 740, s: 'Ridgeway Electric' },
      { x: 60, y: 582, s: 'Ceiling   fan' },
    ]);
    expect(rows).toEqual(['Ridgeway Electric', 'GFCI outlets 4 $260.00', 'Ceiling fan']);
  });

  it('reads the text layer of a PDF page by page', async () => {
    const pdf = makePdf([
      [
        { x: 60, y: 740, text: 'Ridgeway Electric' },
        { x: 510, y: 598, text: '$1,800.00' },
        { x: 400, y: 598, text: '1' },
        { x: 60, y: 598, text: 'Main panel upgrade (200A)' },
      ],
      [{ x: 60, y: 700, text: 'Payment in full before work starts.' }],
    ]);
    const est = await parseEstimate(pdf);
    expect(est.kind).toBe('pdf');
    if (est.kind !== 'pdf') return;
    expect(est.pages).toBe(2);
    expect(est.rows).toEqual([
      { page: 1, text: 'Ridgeway Electric' },
      { page: 1, text: 'Main panel upgrade (200A) 1 $1,800.00' },
      { page: 2, text: 'Payment in full before work starts.' },
    ]);
    expect(estimateText(est)).toBe('Page 1:\nRidgeway Electric\nMain panel upgrade (200A) 1 $1,800.00\nPage 2:\nPayment in full before work starts.');
  });

  it('keeps an image estimate as an image', async () => {
    const est = await parseEstimate(PNG_1PX);
    expect(est).toEqual({ kind: 'image', mime: 'image/png', image: PNG_1PX });
  });

  it('refuses anything else, and a broken PDF', async () => {
    await expect(parseEstimate(Buffer.from('not a document'))).rejects.toThrow(/not a PDF, JPEG or PNG/);
    await expect(parseEstimate(Buffer.from('%PDF-1.4\ngarbage'))).rejects.toThrow();
  });
});
