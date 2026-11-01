// The files a homeowner uploaded for a case, kept on disk under <root>/<caseId>/:
// estimate.<pdf|jpg|png> and photo-N.<jpg|png>, N = the order the photos were added in.
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Uploads } from './model.js';

export interface UploadedFile {
  /** The name on disk, see FILE_NAME */
  name: string;
  bytes: Buffer;
}

/** Ids come from the app, but they end up in a path, so the store only accepts plain ones */
const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PHOTO_NAME = /^photo-\d{1,2}\.(jpg|jpeg|png)$/;
const ESTIMATE_NAME = /^estimate\.(pdf|jpg|jpeg|png)$/;
const ESTIMATE_EXTENSIONS = ['pdf', 'jpg', 'png'] as const;

const CONTENT_TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export const isUploadName = (name: string): boolean => PHOTO_NAME.test(name) || ESTIMATE_NAME.test(name);
const contentType = (name: string): string => CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)]!;

export interface StoredUpload {
  bytes: Buffer;
  contentType: string;
}

/** The uploads directory has no room for what was offered */
export class UploadQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadQuotaError';
  }
}

/** The name mkdtemp gives the scratch directory of a save: ".incoming-" and six characters */
const SCRATCH_NAME = /^\.incoming-[A-Za-z0-9]{6}$/;

export const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export class UploadStore {
  /** Nothing is created until the first save */
  constructor(
    private readonly root: string,
    private readonly quotaBytes: number = DEFAULT_QUOTA_BYTES,
  ) {}

  /** Bytes in all case directories (and scratch directories) now */
  async usedBytes(): Promise<number> {
    let total = 0;
    for (const entry of await this.directories()) {
      for (const file of await readdir(join(this.root, entry), { withFileTypes: true })) {
        if (file.isFile()) total += (await stat(join(this.root, entry, file.name))).size;
      }
    }
    return total;
  }

  /** Throws UploadQuotaError when `bytes` more would go over the quota */
  async ensureRoom(bytes: number): Promise<void> {
    if ((await this.usedBytes()) + bytes > this.quotaBytes) throw new UploadQuotaError(`the uploads directory is limited to ${this.quotaBytes} bytes`);
  }

  /**
   * Removes what a crashed or interrupted run left: scratch directories of saves that never finished, and case directories
   * whose case is not known to the caller. Only directories that sit directly in the uploads directory and have a name this
   * store writes are touched; files, links and anything else with another name are left alone.
   */
  async sweep(isKnownCase: (caseId: string) => Promise<boolean>): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await this.directories()) {
      if (SCRATCH_NAME.test(name) || (CASE_ID.test(name) && !(await isKnownCase(name)))) {
        await rm(join(this.root, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
    return removed;
  }

  /** Names of the real directories (not links) in the uploads directory */
  private async directories(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Writes all files of a case or none: they go to a scratch directory of their own first and are renamed into place at the end.
   * A case that already has uploads is never overwritten.
   */
  async save(caseId: string, files: UploadedFile[]): Promise<Uploads> {
    if (!CASE_ID.test(caseId)) throw new Error(`not a usable case id: "${caseId}"`);
    const estimates = files.filter((f) => ESTIMATE_NAME.test(f.name));
    const photos = files.filter((f) => PHOTO_NAME.test(f.name));
    if (estimates.length !== 1 || estimates.length + photos.length !== files.length) throw new Error('uploads are one estimate and photos with names photo-N.<jpg|png>');
    await this.ensureRoom(files.reduce((sum, f) => sum + f.bytes.length, 0));

    await mkdir(this.root, { recursive: true });
    const scratch = await mkdtemp(join(this.root, '.incoming-'));
    try {
      for (const file of files) await writeFile(join(scratch, file.name), file.bytes, { flag: 'wx' });
      await rename(scratch, join(this.root, caseId));
    } catch (error) {
      await rm(scratch, { recursive: true, force: true }); // the scratch directory was made above, by this call
      throw error;
    }
    return { estimate: estimates[0]!.name, photos: photos.map((f) => f.name) };
  }

  /** Removes what save wrote for this case; the case id must be one the caller just saved */
  async remove(caseId: string): Promise<void> {
    if (!CASE_ID.test(caseId)) return;
    await rm(join(this.root, caseId), { recursive: true, force: true });
  }

  /** One uploaded file, or null when the case or the file does not exist (or the case id or name is not one we write) */
  async read(caseId: string, name: string): Promise<StoredUpload | null> {
    if (!CASE_ID.test(caseId) || !isUploadName(name)) return null;
    try {
      return { bytes: await readFile(join(this.root, caseId, name)), contentType: contentType(name) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** The estimate of a case, whichever kind of file it was */
  async readEstimate(caseId: string): Promise<StoredUpload | null> {
    for (const extension of ESTIMATE_EXTENSIONS) {
      const found = await this.read(caseId, `estimate.${extension}`);
      if (found) return found;
    }
    return null;
  }
}
