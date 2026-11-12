// "Try a hostile file": a read-only page that replays the hostile-file evaluation (eval/hostile/) on the hosted demo.
// The data is a byte-for-byte copy of eval/hostile/RESULTS.json and of the case files it lists, kept in demo/hostile/
// (the image copies demo/, not eval/); test/hostile.test.ts keeps the copy equal to the original. Nothing here calls a
// model or PayPal.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { notFound } from './errors.js';

export const HOSTILE_DIR = fileURLToPath(new URL('../demo/hostile/', import.meta.url));

/** Where the evaluation keeps a case's files; the same tree is copied under demo/hostile/ */
const EVAL_PREFIX = 'eval/hostile/';
/** A case file as RESULTS.json lists it: eval/hostile/cases/<id>/[one or two folders/]<name>, no dot-only segments */
export const LISTED_FILE = /^eval\/hostile\/cases\/[A-Z]\d{2}\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,40}\/){0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * The case files RESULTS.json lists, by the path the page asks for (relative to eval/hostile/, e.g. cases/H07/photos/photo-4.png).
 * Anything that is not a plain listed path is left out.
 */
export function hostileFiles(results: unknown, dir: string = HOSTILE_DIR): Map<string, string> {
  const files = new Map<string, string>();
  const cases = (results as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(cases)) return files;
  for (const c of cases) {
    const list = (c as { files?: unknown } | null)?.files;
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (typeof f !== 'string' || !LISTED_FILE.test(f) || f.includes('..')) continue;
      const rel = f.slice(EVAL_PREFIX.length);
      files.set(rel, join(dir, ...rel.split('/')));
    }
  }
  return files;
}

async function readResults(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, 'RESULTS.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** The page and file senders of src/web.ts, passed in so both use the same headers and page policy */
export interface Senders {
  page: (file: string) => Promise<Response>;
  sendFile: (path: string, what: string, cache: string) => Promise<Response>;
  /** Tests point this at a fixture; the app uses demo/hostile/ */
  dir?: string;
}

const FILES_PREFIX = '/hostile/files/';

export function registerHostile(app: Hono, { page, sendFile, dir = HOSTILE_DIR }: Senders): void {
  app.get('/hostile', () => page('hostile.html'));
  app.get('/hostile/results.json', () => sendFile(join(dir, 'RESULTS.json'), 'results', 'no-cache'));
  // A file is sent only when the path asked for is, character for character, one RESULTS.json lists;
  // the path on disk is the listed one, never one built from the request.
  app.get(`${FILES_PREFIX}*`, async (c) => {
    const asked = new URL(c.req.url).pathname.slice(FILES_PREFIX.length);
    const path = hostileFiles(await readResults(dir), dir).get(asked);
    if (!path) throw notFound('file');
    return sendFile(path, 'file', 'public, max-age=3600');
  });
}
