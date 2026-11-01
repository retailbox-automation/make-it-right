import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openJournal } from '../src/journal.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mir-journal-'));
  dirs.push(dir);
  return dir;
};
const entry = { ts: '2026-11-01T12:00:00.000Z', method: 'GET', path: '/v2/payments/captures/X', status: 200, ms: 12, debug_id: 'dbg' };

describe('call journal file', () => {
  it('opens the file when it is created, so a bad path fails at once', () => {
    expect(() => openJournal(join(tmp(), 'missing-dir', 'calls.jsonl'), () => undefined)).toThrow(/ENOENT/);
    expect(() => openJournal(tmp(), () => undefined)).toThrow(); // a directory is not a file
  });

  it('appends one JSON line per entry, also to a file that already has lines', () => {
    const path = join(tmp(), 'calls.jsonl');
    const first = openJournal(path, () => undefined);
    first.write(entry);
    first.close();
    const second = openJournal(path, () => undefined);
    second.write({ ...entry, status: 404 });
    second.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual([200, 404]);
  });

  it('logs a failed write and carries on instead of throwing', () => {
    const logged: string[] = [];
    const journal = openJournal(join(tmp(), 'calls.jsonl'), (m) => logged.push(m));
    journal.close();
    expect(() => journal.write(entry)).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^journal write failed: /);
  });

  it('can be closed twice', () => {
    const journal = openJournal(join(tmp(), 'calls.jsonl'), () => undefined);
    journal.close();
    expect(() => journal.close()).not.toThrow();
  });
});
