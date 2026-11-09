// Daily caps on new demo cases in the public demo: so many per client address and so many in all, per UTC day.
// Everything is in memory, like the photo-check gate; a restart starts the day's count again.
import { HttpError } from './errors.js';

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
