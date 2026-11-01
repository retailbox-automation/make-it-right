// The call journal as a file: one JSON line per PayPal call (method, path, status, time, debug id), never a token or a secret.
import { closeSync, openSync, writeSync } from 'node:fs';
import type { JournalEntry } from './paypal/client.js';

export interface Journal {
  write(entry: JournalEntry): void;
  close(): void;
}

/** Opens (creates) the file now, so a bad path stops the start. A write that fails later is logged and never reaches the PayPal call. */
export function openJournal(path: string, log: (message: string) => void): Journal {
  const fd = openSync(path, 'a');
  let open = true;
  return {
    write(entry) {
      try {
        writeSync(fd, `${JSON.stringify(entry)}\n`);
      } catch (error) {
        log(`journal write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}
