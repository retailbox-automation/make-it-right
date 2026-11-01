// Follows the claim the homeowner files on PayPal's site. The app never files it; it finds it and keeps our copy current.
import { isDeepStrictEqual } from 'node:util';
import { notFound } from '../errors.js';
import type { KeyedLock } from '../lock.js';
import type { CaseRecord } from '../model.js';
import { computeClaim } from '../money.js';
import type { PayPalClient } from '../paypal/client.js';
import { belongsToCase, buyerTransactionId, getDispute, listDisputes, mapDispute, mapOffer, mapOutcome, type RawDispute } from '../paypal/disputes.js';
import { customIdFor } from '../paypal/orders.js';
import type { Store } from '../store.js';

export interface TrackerDeps {
  store: Store;
  paypal: PayPalClient;
  locks: KeyedLock;
  log?: (message: string) => void;
}

export class Tracker {
  private readonly log: (message: string) => void;

  constructor(private readonly deps: TrackerDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * One look at PayPal for one case. Safe to repeat: the same PayPal answer leaves the stored case as it was.
   * PayPal lists a new claim only minutes after it exists, so "not found" means "look again later".
   */
  tick(caseId: string): Promise<CaseRecord> {
    return this.deps.locks.run(caseId, () => this.look(caseId));
  }

  /** Ticks every paid case whose claim is not resolved. One case failing does not stop the others. */
  async tickOpenCases(): Promise<{ checked: number; failed: number }> {
    const open = (await this.deps.store.list()).filter((c) => c.payment?.capture_id && c.dispute?.status !== 'RESOLVED');
    let failed = 0;
    for (const c of open) {
      try {
        await this.tick(c.id);
      } catch (error) {
        failed += 1;
        this.log(`tick ${c.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { checked: open.length, failed };
  }

  private async look(caseId: string): Promise<CaseRecord> {
    const { store, paypal } = this.deps;
    const record = await store.get(caseId);
    if (!record) throw notFound(`case ${caseId}`);
    const captureId = record.payment?.capture_id;
    if (!captureId) return record;
    if (record.dispute?.status === 'RESOLVED') return record;

    const ids = { capture_id: captureId, custom_id: customIdFor(record.id) };
    let raw: RawDispute | null;
    if (record.dispute) {
      raw = await getDispute(paypal, record.dispute.id);
      if (!belongsToCase(raw, ids)) throw new Error(`dispute ${record.dispute.id} does not match case ${record.id} any more`);
    } else {
      raw = await this.find(captureId, ids);
    }
    if (!raw) return record;

    const claim = computeClaim(record.promised_items, record.verdicts, { payee_name: record.payee_name });
    const next: CaseRecord = {
      ...record,
      dispute: mapDispute(raw, { previous: record.dispute, claim_amount: claim.amount }),
      offer: mapOffer(raw),
      outcome: mapOutcome(raw),
      buyer_transaction_id: buyerTransactionId(raw, ids) ?? record.buyer_transaction_id,
    };
    if (!isDeepStrictEqual(next, record)) await store.put(next);
    return next;
  }

  /** The list does not say whose claim it is, so each listed claim is read and checked, newest first. */
  private async find(captureId: string, ids: { capture_id: string; custom_id: string }): Promise<RawDispute | null> {
    const listed = await listDisputes(this.deps.paypal, { disputed_transaction_id: captureId });
    const newestFirst = [...listed].sort((a, b) => (b.create_time ?? '').localeCompare(a.create_time ?? ''));
    for (const item of newestFirst) {
      const raw = await getDispute(this.deps.paypal, item.dispute_id);
      if (belongsToCase(raw, ids)) return raw;
    }
    return null;
  }
}

/** Runs `job` every `intervalMs`, never two at once. A failing run is reported and the polling goes on. */
export function startPoller(job: () => Promise<unknown>, intervalMs: number, onError: (error: unknown) => void = () => undefined): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
