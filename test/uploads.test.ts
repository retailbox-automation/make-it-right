import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadStore } from '../src/uploads.js';
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
});
