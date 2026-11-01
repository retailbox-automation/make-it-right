// Runs in a worker thread, started by parseEstimate (src/core/estimate.ts): reads the text of a PDF with pdf.js.
// It is plain JavaScript, so it loads the same way under node, tsx and the tests. The thread can be stopped from outside at any time.
// Answers with {ok: true, numPages, pages: [[{x, y, s}, ...], ...]} or {ok: false, reason: 'too_complex' | 'unreadable', message}.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const { bytes, standardFontDataUrl, maxPages, maxChars } = workerData;

async function read() {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl });
  try {
    const doc = await task.promise;
    // Look at the page count before any page is opened: a page tree can claim any number of pages
    if (doc.numPages > maxPages) {
      return { ok: false, reason: 'too_complex', message: `it has ${doc.numPages} pages, and at most ${maxPages} can be read` };
    }
    const pages = [];
    let used = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const reader = page.streamTextContent().getReader();
      const pieces = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const item of value.items) {
          if (!('str' in item)) continue;
          used += Math.max(1, item.str.length); // an empty text run counts too
          if (used > maxChars) {
            // The page is left half read; the thread is stopped as soon as this answer arrives
            return { ok: false, reason: 'too_complex', message: `it has more than ${maxChars} characters of text` };
          }
          if (item.str.trim()) pieces.push({ x: item.transform[4], y: item.transform[5], s: item.str });
        }
      }
      pages.push(pieces);
    }
    return { ok: true, numPages: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
}

read().then(
  (answer) => parentPort.postMessage(answer),
  (error) => parentPort.postMessage({ ok: false, reason: 'unreadable', message: error instanceof Error ? error.message : String(error) }),
);
