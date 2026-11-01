// Keeps the photo check from being run over: one check at a time (each one holds up to 50 MB and a local model for minutes),
// and a few per client in a while. Everything is in memory; a restart starts with a clean slate.
import { HttpError } from './errors.js';

export interface GateOptions {
  /** Checks a client may start at once after a quiet time */
  burst: number;
  /** One more check is allowed per client every this many milliseconds */
  refillMs: number;
  /** Retry-After while another check is running, in seconds */
  busyRetrySeconds: number;
  now?: () => number;
}

/** 5 checks per client per 10 minutes */
export const GATE_DEFAULTS = { burst: 5, refillMs: 120_000, busyRetrySeconds: 60 } as const;

/** Clients remembered at most; a client whose allowance is full again is forgotten */
const MAX_REMEMBERED = 1000;

export class PhotoCheckGate {
  private running = false;
  private readonly clients = new Map<string, { tokens: number; at: number }>();
  private readonly options: GateOptions & { now: () => number };

  constructor(options: Partial<GateOptions> = {}) {
    this.options = { ...GATE_DEFAULTS, now: Date.now, ...options };
  }

  /**
   * Lets one check start and returns the function to call when it is over, or throws a 429 that says when to come back.
   * A check turned away because another one is running does not use up the client's allowance.
   */
  enter(client: string): () => void {
    if (this.running) {
      throw new HttpError(429, 'PHOTO_CHECK_BUSY', 'another photo check is running; try again in a minute', { 'retry-after': String(this.options.busyRetrySeconds) });
    }
    const now = this.options.now();
    const seen = this.clients.get(client) ?? { tokens: this.options.burst, at: now };
    const tokens = Math.min(this.options.burst, seen.tokens + (now - seen.at) / this.options.refillMs);
    if (tokens < 1) {
      this.clients.set(client, { tokens, at: now });
      const seconds = Math.ceil(((1 - tokens) * this.options.refillMs) / 1000);
      throw new HttpError(429, 'RATE_LIMITED', `too many photo checks from this address; try again in ${Math.ceil(seconds / 60)} minute(s)`, { 'retry-after': String(seconds) });
    }
    this.clients.set(client, { tokens: tokens - 1, at: now });
    if (this.clients.size > MAX_REMEMBERED) this.forgetRested(now);
    this.running = true;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.running = false;
    };
  }

  private forgetRested(now: number): void {
    for (const [client, seen] of this.clients) {
      if (seen.tokens + (now - seen.at) / this.options.refillMs >= this.options.burst) this.clients.delete(client);
    }
  }
}
