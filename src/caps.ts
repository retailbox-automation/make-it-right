// Limits of the public demo. New demo cases: so many per client address and so many in all per UTC day, in memory like
// the photo-check gate (a restart starts the day's count again). Steps that call PayPal: so many per address in a time
// window, in memory. Refunds the app itself sets off: so many per UTC day in all, kept in the database.
import { HttpError } from './errors.js';
import type { DailyPlaces } from './store.js';

export interface DailyCapsOptions {
  perAddressPerDay: number;
  perDay: number;
  now?: () => Date;
}

export class DailyCaps {
  private day = '';
  private total = 0;
  /** Only addresses that started a case today are kept, so there are never more of them than `perDay` */
  private readonly byAddress = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly options: DailyCapsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Counts one new case for this address, or throws a 429 that says which cap was reached.
   * Returns a function that gives the place back, for a case that could not be made after all.
   */
  take(address: string): () => void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0;
      this.byAddress.clear();
    }
    const retry = { 'retry-after': String(secondsToMidnight(this.now())) };
    if (this.total >= this.options.perDay) {
      throw new HttpError(429, 'DEMO_DAILY_LIMIT', `The demo has started its ${this.options.perDay} live cases for today; please try again tomorrow (the count starts again at midnight UTC).`, retry);
    }
    const used = this.byAddress.get(address) ?? 0;
    if (used >= this.options.perAddressPerDay) {
      throw new HttpError(429, 'DEMO_ADDRESS_LIMIT', `This address has started ${this.options.perAddressPerDay} live demo cases today, the most allowed; please try again tomorrow (midnight UTC).`, retry);
    }
    this.byAddress.set(address, used + 1);
    this.total += 1;
    const day = today;
    let given = false;
    return () => {
      if (given || day !== this.day) return;
      given = true;
      this.total -= 1;
      const left = (this.byAddress.get(address) ?? 1) - 1;
      if (left > 0) this.byAddress.set(address, left);
      else this.byAddress.delete(address);
    };
  }
}

function secondsToMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

export interface WindowLimitOptions {
  /** Requests one address may make in a window */
  limit: number;
  windowMs: number;
  /** Addresses tracked at most; when that many have open windows, a new address is refused until the oldest window closes */
  maxAddresses?: number;
  now?: () => number;
}

export const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * So many requests per client address in a fixed time window (the steps that call PayPal). Windows are kept in the order
 * they opened, so the closed ones are dropped from the front without looking at the rest; at most `maxAddresses` are kept.
 */
export class WindowLimit {
  private readonly seen = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  private readonly maxAddresses: number;

  constructor(private readonly options: WindowLimitOptions) {
    this.now = options.now ?? Date.now;
    this.maxAddresses = options.maxAddresses ?? MAX_TRACKED_ADDRESSES;
  }

  /** Counts one request, or throws a 429 that says when to come back */
  take(address: string): void {
    const now = this.now();
    const { windowMs, limit } = this.options;
    for (const [key, value] of this.seen) {
      if (now - value.start < windowMs) break; // the rest opened later
      this.seen.delete(key);
    }
    let entry = this.seen.get(address);
    if (!entry) {
      if (this.seen.size >= this.maxAddresses) {
        const oldest = this.seen.values().next().value!;
        throw this.tooMany(oldest.start + windowMs - now, 'The demo is busy right now; please try again in a few minutes.');
      }
      entry = { start: now, count: 0 };
      this.seen.set(address, entry); // a new window goes to the end, keeping the order of opening
    }
    if (entry.count >= limit) {
      const seconds = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
      throw this.tooMany(entry.start + windowMs - now, `Too many PayPal steps from this address; please wait ${Math.ceil(seconds / 60)} minute(s) and try again.`);
    }
    entry.count += 1;
  }

  /** Addresses with an open window now */
  get tracked(): number {
    return this.seen.size;
  }

  private tooMany(ms: number, message: string): HttpError {
    return new HttpError(429, 'TOO_MANY_PAYPAL_STEPS', message, { 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
  }
}

const REFUND_KEY = 'demo-refund';

/**
 * Refunds the app itself sets off (PayPal deciding a claim for the homeowner, the contractor stand-in accepting one, or its
 * offer, which the homeowner accepts on PayPal's site where the app cannot see it) come out of the shared
 * sandbox contractor's balance, so the public demo allows only so many per UTC day, for everyone together. The count is
 * kept in the database, so a restart does not reset it. A place is taken before PayPal is asked, so callers at the same
 * moment cannot pass the cap together, and given back when PayPal refused the step.
 */
export class RefundCap {
  private readonly now: () => Date;

  constructor(
    private readonly places: DailyPlaces,
    private readonly perDay: number,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async take(caseId: string, action: string): Promise<{ giveBack(): Promise<void> }> {
    const day = this.now().toISOString().slice(0, 10);
    const id = await this.places.takeDailyPlace(REFUND_KEY, day, this.perDay, `${action} ${caseId}`);
    if (id === null) {
      throw new HttpError(429, 'DEMO_REFUND_LIMIT', `The demo has used its ${this.perDay} refunds for today (each offer from the contractor, accepted claim or decision for the homeowner counts as one); please try again tomorrow (the count starts again at midnight UTC).`, {
        'retry-after': String(secondsToMidnight(this.now())),
      });
    }
    return { giveBack: () => this.places.releaseDailyPlace(id) };
  }
}
