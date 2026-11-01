import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadQuotaError, UploadStore } from '../src/uploads.js';
import { JPEG_HEAD, PNG_1PX } from './helpers.js';

let dir: string;
let root: string;
let store: UploadStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mir-uploads-'));
  root = join(dir, 'uploads');
  store = new UploadStore(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pdf = Buffer.from('%PDF-1.4 test');
const job = [
  { name: 'estimate.pdf', bytes: pdf },
  { name: 'photo-1.png', bytes: PNG_1PX },
  { name: 'photo-2.jpg', bytes: JPEG_HEAD },
];

describe('UploadStore', () => {
  it('creates nothing until the first save', () => {
    expect(existsSync(root)).toBe(false);
  });

  it('saves the files of a case and says which names it wrote', async () => {
    expect(await store.save('case-1', job)).toEqual({ estimate: 'estimate.pdf', photos: ['photo-1.png', 'photo-2.jpg'] });
    expect(readdirSync(join(root, 'case-1')).sort()).toEqual(['estimate.pdf', 'photo-1.png', 'photo-2.jpg']);
    expect(readFileSync(join(root, 'case-1', 'photo-1.png'))).toEqual(PNG_1PX);
    expect(readdirSync(root)).toEqual(['case-1']); // no scratch directory left
  });

  it('reads a file back with its content type, and the estimate whatever its kind', async () => {
    await store.save('case-1', job);
    expect(await store.read('case-1', 'photo-2.jpg')).toEqual({ bytes: JPEG_HEAD, contentType: 'image/jpeg' });
    expect(await store.read('case-1', 'photo-1.png')).toMatchObject({ contentType: 'image/png' });
    expect(await store.readEstimate('case-1')).toEqual({ bytes: pdf, contentType: 'application/pdf' });
    await store.save('case-2', [{ name: 'estimate.png', bytes: PNG_1PX }, { name: 'photo-1.jpg', bytes: JPEG_HEAD }]);
    expect(await store.readEstimate('case-2')).toEqual({ bytes: PNG_1PX, contentType: 'image/png' });
  });

  it('answers null for what is not there', async () => {
    expect(await store.read('case-1', 'photo-1.png')).toBeNull(); // no uploads directory at all
    expect(await store.readEstimate('case-1')).toBeNull();
    await store.save('case-1', job);
    expect(await store.read('case-1', 'photo-3.png')).toBeNull();
    expect(await store.read('nope', 'photo-1.png')).toBeNull();
    expect(await store.readEstimate('nope')).toBeNull();
  });

  it('reads only names and case ids it would have written', async () => {
    writeFileSync(join(dir, 'photo-1.png'), PNG_1PX); // beside the uploads root, where ".." would lead
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    await store.save('case-1', job);
    for (const id of ['..', '../x', 'a/b', '', '.hidden', 'x'.repeat(65)]) expect(await store.read(id, 'photo-1.png'), `case id "${id}"`).toBeNull();
    for (const name of ['../secret.txt', '../../secret.txt', 'photo-1.gif', 'photo-001.png', 'photo-1.png.txt', 'photo-1', '.png', 'estimate.exe', 'secret.txt']) {
      expect(await store.read('case-1', name), `name "${name}"`).toBeNull();
    }
  });

  it('writes all files or none: a failing save leaves no case directory and no scratch directory', async () => {
    mkdirSync(root);
    await expect(store.save('case-1', [job[0]!, job[1]!, job[1]!])).rejects.toThrow(/EEXIST/); // the same name twice
    expect(readdirSync(root)).toEqual([]);
  });

  it('never overwrites the uploads of a case', async () => {
    await store.save('case-1', job);
    await expect(store.save('case-1', [{ name: 'estimate.pdf', bytes: Buffer.from('%PDF-other') }, { name: 'photo-1.png', bytes: PNG_1PX }])).rejects.toThrow();
    expect(readdirSync(root)).toEqual(['case-1']);
    expect(readFileSync(join(root, 'case-1', 'estimate.pdf'))).toEqual(pdf);
  });

  it('refuses ids and file sets it cannot keep, before writing anything', async () => {
    await expect(store.save('../case', job)).rejects.toThrow(/case id/);
    await expect(store.save('case-1', [job[1]!])).rejects.toThrow(/one estimate/);
    await expect(store.save('case-1', [job[0]!, job[0]!])).rejects.toThrow(/one estimate/);
    await expect(store.save('case-1', [job[0]!, { name: 'notes.txt', bytes: pdf }])).rejects.toThrow(/one estimate/);
    expect(existsSync(root)).toBe(false);
  });

  it('removes one case and leaves the others', async () => {
    await store.save('case-1', job);
    await store.save('case-2', job);
    await store.remove('case-1');
    await store.remove('case-1'); // twice is fine
    await store.remove('../');
    expect(readdirSync(root)).toEqual(['case-2']);
    expect(existsSync(dir)).toBe(true);
  });

  describe('the quota', () => {
    const size = pdf.length + PNG_1PX.length + JPEG_HEAD.length;

    it('counts what is on disk, scratch directories included', async () => {
      expect(await store.usedBytes()).toBe(0);
      await store.save('case-1', job);
      expect(await store.usedBytes()).toBe(size);
      mkdirSync(join(root, '.incoming-abc123'));
      writeFileSync(join(root, '.incoming-abc123', 'photo-1.png'), PNG_1PX);
      expect(await store.usedBytes()).toBe(size + PNG_1PX.length);
    });

    it('takes a save that fits exactly and refuses one byte more, writing nothing', async () => {
      const small = new UploadStore(root, size);
      await small.save('case-1', job);
      await expect(new UploadStore(root, size * 2 - 1).save('case-2', job)).rejects.toThrow(UploadQuotaError);
      expect(readdirSync(root)).toEqual(['case-1']);
      await new UploadStore(root, size * 2).save('case-2', job);
      expect(readdirSync(root).sort()).toEqual(['case-1', 'case-2']);
    });

    it('answers ensureRoom without writing', async () => {
      const small = new UploadStore(root, 100);
      await small.ensureRoom(100);
      await expect(small.ensureRoom(101)).rejects.toThrow(UploadQuotaError);
      expect(existsSync(root)).toBe(false);
    });
  });

  describe('the sweep', () => {
    const known = (...ids: string[]) => async (id: string) => ids.includes(id);

    it('removes scratch directories and the directories of cases nobody knows, and keeps the rest', async () => {
      await store.save('case-1', job);
      await store.save('case-2', job);
      await store.save('orphan', job);
      mkdirSync(join(root, '.incoming-Ab12Cd'));
      writeFileSync(join(root, '.incoming-Ab12Cd', 'estimate.pdf'), pdf);
      expect((await store.sweep(known('case-1', 'case-2'))).sort()).toEqual(['.incoming-Ab12Cd', 'orphan']);
      expect(readdirSync(root).sort()).toEqual(['case-1', 'case-2']);
      expect(readFileSync(join(root, 'case-1', 'photo-1.png'))).toEqual(PNG_1PX);
    });

    it('does nothing when there is no uploads directory, and nothing twice', async () => {
      expect(await store.sweep(known())).toEqual([]);
      await store.save('orphan', job);
      expect(await store.sweep(known())).toEqual(['orphan']);
      expect(await store.sweep(known())).toEqual([]);
    });

    it('touches only directories directly in the root with names this store writes', async () => {
      mkdirSync(join(root, 'not a case id'), { recursive: true });
      mkdirSync(join(root, '.incoming-toolong1'));
      mkdirSync(join(root, '.hidden'));
      writeFileSync(join(root, 'stray-file'), 'x');
      writeFileSync(join(root, 'orphan-file'), 'x');
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      symlinkSync(outside, join(root, 'linked-case'));
      expect(await store.sweep(known())).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(['.hidden', '.incoming-toolong1', 'linked-case', 'not a case id', 'orphan-file', 'stray-file']);
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    });

    it('asks only about the names it might remove', async () => {
      await store.save('case-1', job);
      mkdirSync(join(root, '.hidden'));
      const asked: string[] = [];
      await store.sweep(async (id) => (asked.push(id), true));
      expect(asked).toEqual(['case-1']);
    });
  });
});
