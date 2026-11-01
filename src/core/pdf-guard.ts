// A look at a PDF before pdf.js opens it: how much would its compressed streams unpack to?
// A file of a few hundred KB can unpack to gigabytes (a "zip bomb" inside a PDF), and pdf.js unpacks whatever it is given.
//
// The scan does not trust the PDF's own structure. It tries every place where the word "stream" starts data and looks at the
// data itself: a zlib stream is unpacked (against a budget for the whole file), an ASCII85 or ASCII-hex wrapper is taken off first.
// This way a lying /Length, a hidden or misspelled /Filter entry, or an object that is only reachable through the
// cross-reference table cannot hide a stream from it. Filters that cannot be checked this way (LZW, run-length, Brotli, Crypt)
// and encryption are refused wherever the name appears.
import { constants, inflateRawSync, inflateSync } from 'node:zlib';

/** The estimate cannot be read within the limits (size when unpacked, pages, text, time). The message is safe to show. */
export class EstimateTooComplexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstimateTooComplexError';
  }
}

export interface GuardLimits {
  /** Everything all streams unpack to, layers included */
  maxInflatedBytes: number;
  /** Places where stream data starts */
  maxStreams: number;
}

/** Names pdf.js would act on that this scan cannot size up, and the marker of an encrypted file (its streams are not readable). */
const UNCHECKABLE = /\/(LZWDecode|LZW|RunLengthDecode|RL|BrotliDecode|Crypt|Encrypt)(?![A-Za-z0-9])/;
const MAX_LAYERS = 4;
/** The most text-like data looked at in front of one stream */
const WRAPPER_LOOK = 8 * 1048576;

const isAlphanumeric = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isSpace = (code: number) => code === 32 || code === 10 || code === 13 || code === 9 || code === 12 || code === 0;

/** CMF/FLG of a zlib stream: deflate, a window of at most 32 KB, check bits right. pdf.js refuses a flate stream without one. */
function startsZlib(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  const [cmf, flg] = [data[0]!, data[1]!];
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/** PDF names may spell a letter as #xx: "/Fl#61teDecode" is "/FlateDecode" */
const unescapeNames = (text: string) => (text.includes('#') ? text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text);

function refuseUncheckable(text: string): void {
  const found = UNCHECKABLE.exec(unescapeNames(text));
  if (found) throw new EstimateTooComplexError(`it uses ${found[0]}, which cannot be checked for size`);
}

/** ASCII85 → bytes. `chars` is the data up to where it stopped looking like ASCII85 ("~>" ends it). */
function ascii85(chars: string): Buffer {
  let zeros = 0;
  for (let i = 0; i < chars.length; i++) if (chars.charCodeAt(i) === 0x7a) zeros++;
  const out = Buffer.alloc(zeros * 4 + Math.ceil(((chars.length - zeros) * 4) / 5) + 4);
  let length = 0;
  const digits: number[] = [];
  const flush = (count: number) => {
    for (let i = digits.length; i < 5; i++) digits.push(84);
    let n = 0;
    for (const d of digits) n = n * 85 + d;
    for (let i = 0; i < count; i++) out[length++] = Math.floor(n / 256 ** (3 - i)) & 255;
    digits.length = 0;
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars.charCodeAt(i);
    if (isSpace(c)) continue;
    if (c === 0x7e) break;
    if (c === 0x7a && digits.length === 0) {
      length += 4; // "z" is four zero bytes
      continue;
    }
    digits.push(c - 33);
    if (digits.length === 5) flush(4);
  }
  if (digits.length > 1) flush(digits.length - 1);
  return out.subarray(0, length);
}

/** ASCII hex → bytes; ">" ends it */
function asciiHex(chars: string): Buffer {
  const out = Buffer.alloc(Math.ceil(chars.length / 2));
  let length = 0;
  let high = -1;
  for (let i = 0; i < chars.length; i++) {
    const c = chars.charCodeAt(i);
    if (c === 0x3e) break;
    if (isSpace(c)) continue;
    const value = parseInt(chars[i]!, 16);
    if (high < 0) high = value;
    else {
      out[length++] = high * 16 + value;
      high = -1;
    }
  }
  if (high >= 0) out[length++] = high * 16;
  return out.subarray(0, length);
}

/** How many bytes from the start of `data` the characters `ok` accepts, looking at no more than `max` */
function runLength(data: Uint8Array, ok: (code: number) => boolean, max: number): number {
  let end = 0;
  const stop = Math.min(data.length, max);
  while (end < stop && ok(data[end]!)) end++;
  return end;
}

const isAscii85Char = (c: number) => (c >= 33 && c <= 117) || c === 0x7a || isSpace(c);
const isHexChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) || isSpace(c);

class Budget {
  inflated = 0;
  /** Bytes looked at to see whether data is ASCII85 or hex, all streams together; a few times the file is plenty */
  looked = 0;
  constructor(
    readonly limits: GuardLimits,
    readonly lookLimit: number,
  ) {}
}

function inflateWithin(data: Uint8Array, budget: Budget): Buffer {
  const room = budget.limits.maxInflatedBytes - budget.inflated;
  const tooBig = () => new EstimateTooComplexError(`its compressed data unpacks to more than ${Math.round(budget.limits.maxInflatedBytes / 1048576)} MB`);
  if (room < 1) throw tooBig();
  const options = { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH };
  let out: Buffer;
  try {
    try {
      out = inflateSync(data, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw error;
      out = inflateRawSync(data.subarray(2), options); // a wrong or missing checksum: pdf.js reads such a stream anyway
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
    throw new EstimateTooComplexError('it has compressed data that is damaged, so its size cannot be checked');
  }
  budget.inflated += out.length;
  return out;
}

/**
 * Follows the layers of one piece of stream data and counts what they unpack to. `raw` is true for data as it lies in the file and
 * for what comes out of an ASCII85 or hex wrapper, where another wrapper or compression may follow; what comes out of a
 * decompression is only looked at for more compression (that is how the data is wrapped by PDF writers and by attackers).
 */
function follow(data: Buffer, depth: number, budget: Budget, raw: boolean): void {
  if (depth > MAX_LAYERS) throw new EstimateTooComplexError('its streams are wrapped in too many layers');
  if (startsZlib(data)) {
    const out = inflateWithin(data, budget);
    refuseUncheckable(out.toString('latin1'));
    follow(out, depth + 1, budget, false);
    return;
  }
  if (!raw) return;
  // ASCII85 or hex text around the data: it has to be text from the first byte, which binary data shows at once
  for (const [ok, decode] of [
    [isAscii85Char, ascii85],
    [isHexChar, asciiHex],
  ] as const) {
    const length = runLength(data, ok, WRAPPER_LOOK);
    budget.looked += length;
    if (budget.looked > budget.lookLimit) throw new EstimateTooComplexError('it has too much text-like data to check');
    if (length < 2) continue;
    const decoded = decode(data.subarray(0, length).toString('latin1'));
    if (startsZlib(decoded)) {
      follow(decoded, depth + 1, budget, true);
      return;
    }
  }
}

/**
 * Throws EstimateTooComplexError when the PDF's streams unpack to more than `maxInflatedBytes`, when it has more than
 * `maxStreams` places where stream data starts, or when it uses a filter or encryption this scan cannot size up.
 */
export function checkPdfBudget(bytes: Uint8Array, limits: GuardLimits): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const text = buffer.toString('latin1');
  refuseUncheckable(text);

  const budget = new Budget(limits, 8 * bytes.length + 1048576);
  let streams = 0;
  for (let at = text.indexOf('stream'); at >= 0; at = text.indexOf('stream', at + 6)) {
    if (at > 0 && isAlphanumeric(text.charCodeAt(at - 1))) continue; // "endstream", or a longer word that only ends in "stream"
    let start = at + 6;
    if (text[start] === '\r' && text[start + 1] === '\n') start += 2;
    else if (text[start] === '\n' || text[start] === '\r') start += 1;
    else continue;
    if (++streams > limits.maxStreams) throw new EstimateTooComplexError(`it has more than ${limits.maxStreams} streams`);
    follow(buffer.subarray(start), 0, budget, true);
  }
}
