import { describe, expect, it } from 'vitest';
import { MAX_TEXTS_CHARS, maxBodyBytes, readIntake, sizeText, UPLOAD_LIMITS, type UploadLimits } from '../src/intake.js';
import { JPEG_HEAD, PNG_1PX } from './helpers.js';
import { file, MINI_JOB, miniForm } from './helpers/upload.js';

const read = (form: FormData | string, limits: UploadLimits = UPLOAD_LIMITS, headers?: Record<string, string>) =>
  readIntake(new Request('http://localhost/api/cases/analyze', { method: 'POST', body: form, ...(headers ? { headers } : {}) }), limits);

/** A PNG (valid first bytes) of exactly this many bytes */
const png = (size: number) => Buffer.concat([PNG_1PX.subarray(0, 8), Buffer.alloc(size - 8, 1)]);
const rejects = (form: FormData | string, status: number, code: string, message: RegExp, limits?: UploadLimits) =>
  expect(read(form, limits)).rejects.toMatchObject({ status, code, message: expect.stringMatching(message) });
const invalid = (form: FormData | string, message: RegExp, limits?: UploadLimits) => rejects(form, 400, 'INVALID_INPUT', message, limits);

/** The mini form after `change` */
const edited = (change: (form: FormData) => void) => {
  const form = miniForm();
  change(form);
  return form;
};
const SMALL: UploadLimits = { maxFileBytes: 100, maxTotalBytes: 250, maxPhotos: 3 };

describe('readIntake', () => {
  it('reads the fields and the files; the photos are named by the order they were added in', async () => {
    const intake = await read(miniForm());
    expect(intake).toMatchObject({ payee_name: 'Harbor Plumbing & Bath', paid_amount: '2200.00', paid_at: '2026-08-12', texts: MINI_JOB.texts });
    expect(intake.estimate).toEqual({ name: 'estimate.pdf', bytes: MINI_JOB.estimate });
    expect(intake.photos).toEqual([
      { id: 'photo-1', name: 'photo-1.png', bytes: MINI_JOB.photos[0] },
      { id: 'photo-2', name: 'photo-2.png', bytes: MINI_JOB.photos[1] },
    ]);
  });

  it('tidies the fields: the name trimmed, the amount to cents, texts optional', async () => {
    const intake = await read(
      edited((f) => {
        f.set('payee_name', '  Harbor Plumbing & Bath ');
        f.set('paid_amount', '2200');
        f.delete('texts');
      }),
    );
    expect(intake).toMatchObject({ payee_name: 'Harbor Plumbing & Bath', paid_amount: '2200.00', texts: '' });
    expect((await read(edited((f) => f.set('paid_amount', '0.5')))).paid_amount).toBe('0.50');
  });

  it('tells file types by their first bytes, not by their names', async () => {
    const intake = await read(
      edited((f) => {
        f.set('estimate', file(PNG_1PX, 'estimate.pdf')); // a PNG called .pdf
        f.delete('photos');
        f.append('photos', file(JPEG_HEAD, 'a.png')); // a JPEG called .png
        f.append('photos', file(PNG_1PX, 'b.jpeg')); // a PNG called .jpeg
        f.append('photos', file(PNG_1PX, 'c')); // no extension at all
      }),
    );
    expect(intake.estimate.name).toBe('estimate.png');
    expect(intake.photos.map((p) => p.name)).toEqual(['photo-1.jpg', 'photo-2.png', 'photo-3.png']);
  });

  it('takes a JPEG or PNG estimate as well as a PDF', async () => {
    expect((await read(edited((f) => f.set('estimate', file(JPEG_HEAD, 'scan.jpg'))))).estimate.name).toBe('estimate.jpg');
  });

  it('takes 20 photos and texts of exactly the longest allowed length', async () => {
    const form = edited((f) => {
      f.delete('photos');
      for (let i = 0; i < 20; i++) f.append('photos', file(PNG_1PX, `${i}.png`));
      f.set('texts', 'x'.repeat(MAX_TEXTS_CHARS));
    });
    const intake = await read(form);
    expect(intake.photos).toHaveLength(20);
    expect(intake.photos.at(-1)!.id).toBe('photo-20');
  });

  describe('refuses, saying what is wrong', () => {
    it('a body that is not a form', async () => {
      await invalid(JSON.stringify({ payee_name: 'x' }), /multipart\/form-data/);
    });

    it('a multipart body that is cut off', async () => {
      const cutOff = '--nope\r\nContent-Disposition: form-data; name="payee_name"\r\n\r\nx';
      await expect(read(cutOff, UPLOAD_LIMITS, { 'content-type': 'multipart/form-data; boundary=nope' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/multipart\/form-data/) });
    });

    it.each([
      ['payee_name', /payee_name is required/],
      ['paid_amount', /paid_amount is required/],
      ['paid_at', /paid_at is required/],
      ['estimate', /estimate is required/],
      ['photos', /at least one photo/],
    ])('a missing %s', async (name, message) => {
      await invalid(edited((f) => f.delete(name)), message);
    });

    it('a blank payee, or one over 500 characters', async () => {
      await invalid(edited((f) => f.set('payee_name', '   ')), /payee_name is required/);
      await invalid(edited((f) => f.set('payee_name', 'x'.repeat(501))), /payee_name is longer than 500/);
    });

    it.each(['abc', '', '12.345', '-5', '1e3', '$100', '1,000.00', '12345678901'])('the amount %j', async (amount) => {
      await invalid(edited((f) => f.set('paid_amount', amount)), /paid_amount/);
    });

    it.each(['0', '0.00'])('an amount of %s', async (amount) => {
      await invalid(edited((f) => f.set('paid_amount', amount)), /paid_amount must be more than zero/);
    });

    it.each(['09/12/2026', '2026-9-1', '2026-02-30', '2026-13-01', 'yesterday', ''])('the date %j', async (date) => {
      await invalid(edited((f) => f.set('paid_at', date)), /paid_at must be a date like 2026-09-12/);
    });

    it('texts that are too long', async () => {
      await invalid(edited((f) => f.set('texts', 'x'.repeat(MAX_TEXTS_CHARS + 1))), /texts is longer than 20000/);
    });

    it('a field it does not know, and a field given twice', async () => {
      await invalid(edited((f) => f.set('photo', file(PNG_1PX, 'x.png'))), /unknown field "photo"/);
      await invalid(edited((f) => f.append('paid_at', '2026-08-13')), /paid_at must be given once/);
      await invalid(edited((f) => f.append('estimate', file(MINI_JOB.estimate, 'again.pdf'))), /estimate must be given once/);
    });

    it('a file where text is expected, and text where a file is expected', async () => {
      await invalid(edited((f) => f.set('texts', file(Buffer.from('hi'), 'texts.txt'))), /texts must be text/);
      await invalid(edited((f) => f.set('payee_name', file(Buffer.from('hi'), 'name.txt'))), /payee_name must be text/);
      await invalid(edited((f) => f.set('estimate', 'a string')), /estimate must be a file/);
      await invalid(edited((f) => f.append('photos', 'a string')), /photo 3 must be a file/);
    });

    it('an estimate that is not a PDF, JPEG or PNG, whatever its name says', async () => {
      await invalid(edited((f) => f.set('estimate', file(Buffer.from('Kitchen remodel, $4,200'), 'estimate.pdf', 'application/pdf'))), /estimate is not a PDF, JPEG or PNG/);
      await invalid(edited((f) => f.set('estimate', file(Buffer.alloc(0), 'estimate.pdf'))), /estimate is not a PDF, JPEG or PNG/);
      await invalid(edited((f) => f.set('estimate', file(Buffer.from('GIF89a....'), 'estimate.png', 'image/png'))), /estimate is not a PDF, JPEG or PNG/);
    });

    it('a photo that is not a JPEG or PNG, saying which one', async () => {
      const text = file(Buffer.from('this is not a picture'), 'photo.png', 'image/png');
      await invalid(edited((f) => f.append('photos', text)), /photo 3 is not a JPEG or PNG image/);
      await invalid(edited((f) => f.set('photos', text)), /photo 1 is not a JPEG or PNG image/);
      await invalid(edited((f) => f.append('photos', file(Buffer.from('%PDF-1.4 x'), 'plan.jpg', 'image/jpeg'))), /photo 3 is not a JPEG or PNG image/);
      await invalid(edited((f) => f.append('photos', file(Buffer.alloc(0), 'empty.jpg'))), /photo 3 is not a JPEG or PNG image/);
    });

    it('more than 20 photos', async () => {
      const form = edited((f) => {
        f.delete('photos');
        for (let i = 0; i < 21; i++) f.append('photos', file(PNG_1PX, `${i}.png`));
      });
      await invalid(form, /at most 20 photos/);
    });
  });

  describe('sizes', () => {
    const sized = (...sizes: number[]) =>
      edited((f) => {
        f.set('estimate', file(png(sizes[0]!), 'estimate.png'));
        f.delete('photos');
        for (const size of sizes.slice(1)) f.append('photos', file(png(size), 'p.png'));
      });

    it('takes a file of exactly the limit and refuses one byte more, naming it', async () => {
      expect((await read(sized(100, 100), SMALL)).photos[0]!.bytes).toHaveLength(100);
      await rejects(sized(101, 10), 413, 'PAYLOAD_TOO_LARGE', /estimate is larger than 100 bytes/, SMALL);
      await rejects(sized(10, 10, 101), 413, 'PAYLOAD_TOO_LARGE', /photo 2 is larger than 100 bytes/, SMALL);
    });

    it('takes files that add up to exactly the limit and refuses one byte more', async () => {
      expect((await read(sized(100, 100, 50), SMALL)).photos).toHaveLength(2);
      await rejects(sized(100, 100, 51), 413, 'PAYLOAD_TOO_LARGE', /files together are larger than 250 bytes/, SMALL);
    });

    it('sets a limit of 10 MB for a file, 50 MB for all files and 20 photos; the body may hold the form on top', () => {
      expect(UPLOAD_LIMITS).toEqual({ maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxPhotos: 20 });
      expect(maxBodyBytes(UPLOAD_LIMITS)).toBeGreaterThan(50 * 1024 * 1024 + 20 * 1024); // the fields and part headers fit
      expect(sizeText(UPLOAD_LIMITS.maxFileBytes)).toBe('10 MB');
      expect(sizeText(100)).toBe('100 bytes');
    });
  });
});
