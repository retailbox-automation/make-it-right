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

/** PayPal accepts a "not received" claim up to 180 days after the payment */
const WINDOW_MS = 180 * 86_400_000;
/** After this many failures in a row a case is left alone for a while: 5 minutes, doubling, at most 30 */
const BACKOFF_AFTER = 3;
const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export interface TrackerDeps {
  store: Store;
  paypal: PayPalClient;
  locks: KeyedLock;
  now?: () => Date;
  log?: (message: string) => void;
}

export class Tracker {
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  /** Failures in a row and when to try again, for cases the poller could not read; in memory only */
  private readonly trouble = new Map<string, { failures: number; retryAt: number }>();

  constructor(private readonly deps: TrackerDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * One look at PayPal for one case. Safe to repeat: the same PayPal answer leaves the stored case as it was.
   * PayPal lists a new claim only minutes after it exists, so "not found" means "look again later".
   */
  tick(caseId: string): Promise<CaseRecord> {
    return this.deps.locks.run(caseId, async () => {
      const record = await this.look(caseId);
      this.trouble.delete(caseId);
      return record;
    });
  }

  /**
   * Ticks every paid case whose claim can still be filed or is not resolved: not past day 180 of the payment, not resolved,
   * not waiting out a run of failures. One case failing does not stop the others.
   */
  async tickOpenCases(): Promise<{ checked: number; failed: number }> {
    const now = this.now().getTime();
    const open = (await this.deps.store.list()).filter(
      (c) => c.payment?.status === 'captured' && c.payment.capture_id && c.dispute?.status !== 'RESOLVED' && withinWindow(c, now) && (this.trouble.get(c.id)?.retryAt ?? 0) <= now,
    );
    let failed = 0;
    for (const c of open) {
      try {
        await this.tick(c.id);
      } catch (error) {
        failed += 1;
        this.log(`tick ${c.id} failed: ${error instanceof Error ? error.message : String(error)}${this.noteFailure(c.id, now)}`);
      }
    }
    return { checked: open.length, failed };
  }

  /** Counts a failure; returns a note for the log when the case now has to wait */
  private noteFailure(caseId: string, now: number): string {
    const failures = (this.trouble.get(caseId)?.failures ?? 0) + 1;
    const wait = failures >= BACKOFF_AFTER ? Math.min(BACKOFF_FIRST_MS * 2 ** (failures - BACKOFF_AFTER), BACKOFF_MAX_MS) : 0;
    this.trouble.set(caseId, { failures, retryAt: now + wait });
    return wait ? ` (${failures} failures in a row, the poller waits ${wait / 60_000} minutes)` : '';
  }

  private async look(caseId: string): Promise<CaseRecord> {
    const { store, paypal } = this.deps;
    const record = await store.get(caseId);
    if (!record) throw notFound(`case ${caseId}`);
    const captureId = record.payment?.status === 'captured' ? record.payment.capture_id : null;
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

function withinWindow(record: CaseRecord, now: number): boolean {
  const paid = Date.parse(record.payment?.captured_at ?? '');
  return Number.isNaN(paid) || now - paid <= WINDOW_MS;
}

/**
 * Runs `job` every `intervalMs`, never two at once. A failing run is reported and the polling goes on.
 * `stop()` ends the polling and waits for a run that is still going, so nothing is left running against a closed database.
 */
export function startPoller(job: () => Promise<unknown>, intervalMs: number, onError: (error: unknown) => void = () => undefined): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = job()
      .then(
        () => undefined,
        (error) => onError(error),
      )
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
