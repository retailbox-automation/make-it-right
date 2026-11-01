import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/errors.js';
import { Tracker, startPoller } from '../../src/disputes/tracker.js';
import { KeyedLock } from '../../src/lock.js';
import type { CaseRecord } from '../../src/model.js';
import { fixture } from '../helpers/fake-paypal.js';
import { NOW, paidCase } from '../helpers/records.js';
import { CASE_ID, DISPUTE_ID, makeWorld, type World } from '../helpers/world.js';

let world: World;
let logged: string[];
let tracker: Tracker;
let clock: Date;
const minutes = (n: number) => n * 60_000;
const later = (ms: number) => (clock = new Date(clock.getTime() + ms));

beforeEach(async () => {
  world = makeWorld();
  logged = [];
  clock = NOW;
  tracker = new Tracker({ store: world.store, paypal: world.client, locks: new KeyedLock(), now: () => clock, log: (m) => logged.push(m) });
  await world.store.put(paidCase());
});

const stored = async () => (await world.store.get(CASE_ID))!;
const gets = () => world.disputeCalls().filter((c) => c.method === 'GET');
const lists = () => gets().filter((c) => c.path === '/v1/customer/disputes');
const byId = () => gets().filter((c) => c.path !== '/v1/customer/disputes');

describe('finding the claim', () => {
  it('does nothing for a case that is not paid yet', async () => {
    await world.store.put(paidCase({ payment: { order_id: 'O9', approve_url: 'x', status: 'created', capture_id: null, capture_status: null, captured_at: null, method: null } }));
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute).toBeNull();
    expect(world.fake.calls).toHaveLength(0);
  });

  it('does nothing for a capture PayPal has not completed (nobody can dispute it yet)', async () => {
    await world.store.put(paidCase({ payment: { order_id: 'O9', approve_url: 'x', status: 'pending', capture_id: 'CAP9', capture_status: 'PENDING', captured_at: null, method: null } }));
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute).toBeNull();
    expect(world.fake.calls).toHaveLength(0);
    expect(await tracker.tickOpenCases()).toEqual({ checked: 0, failed: 0 });
  });

  it('waits when PayPal does not list a claim yet', async () => {
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute).toBeNull();
    expect(lists()).toHaveLength(1);
    expect(lists()[0]!.search).toContain('disputed_transaction_id=9UA851170T503222E');
    expect(byId()).toHaveLength(0);
  });

  it('finds the claim by our capture id, then reads it by its id and keeps what it learned', async () => {
    world.dispute = fixture('dispute-a-open');
    world.listed = true;
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute).toEqual({
      id: DISPUTE_ID, status: 'OPEN', life_cycle_stage: 'INQUIRY', opened_at: '2026-10-31T18:25:35.592Z',
      escalated_at: null, dispute_amount: '400.00', original_claim_amount: '400.00',
    });
    expect(rec.buyer_transaction_id).toBe('27S431280V029084G');
    expect(rec.offer).toBeNull();
    expect(rec.outcome).toBeNull();
    expect(await stored()).toEqual(rec);
  });

  it('follows the claim by its id once it is known (no more listing)', async () => {
    world.dispute = fixture('dispute-a-open');
    world.listed = true;
    await tracker.tick(CASE_ID);
    world.fake.calls.length = 0;
    world.dispute = fixture('dispute-a-waiting-for-seller');
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute?.status).toBe('WAITING_FOR_SELLER_RESPONSE');
    expect(lists()).toHaveLength(0);
    expect(byId()).toHaveLength(1);
  });

  it('ignores a listed dispute that is not for this case', async () => {
    world.fake.setRoute((call) => {
      if (call.path === '/v1/customer/disputes') return { body: { items: [{ dispute_id: 'PP-R-GWA-10195522', create_time: '2026-10-31T18:29:56.000Z' }] } };
      if (call.path === '/v1/customer/disputes/PP-R-GWA-10195522') return { body: fixture('dispute-b-open') };
      return undefined;
    });
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute).toBeNull();
    expect(rec.buyer_transaction_id).toBeNull();
  });

  it('checks the newest listed disputes first and takes the one that belongs to the case', async () => {
    world.fake.setRoute((call) => {
      if (call.path === '/v1/customer/disputes') {
        return { body: { items: [
          { dispute_id: 'PP-R-GWA-10195522', create_time: '2026-10-31T18:29:56.000Z' },
          { dispute_id: DISPUTE_ID, create_time: '2026-10-31T18:25:35.000Z' },
        ] } };
      }
      if (call.path === '/v1/customer/disputes/PP-R-GWA-10195522') return { body: fixture('dispute-b-open') };
      if (call.path === `/v1/customer/disputes/${DISPUTE_ID}`) return { body: fixture('dispute-a-open') };
      return undefined;
    });
    const rec = await tracker.tick(CASE_ID);
    expect(rec.dispute?.id).toBe(DISPUTE_ID);
    expect(byId().map((c) => c.path.split('/').pop())).toEqual(['PP-R-GWA-10195522', DISPUTE_ID]);
  });

  it('refuses to follow a stored dispute that stopped matching its case', async () => {
    world.dispute = fixture('dispute-b-open');
    const rec = paidCase({ dispute: { id: DISPUTE_ID, status: 'OPEN', life_cycle_stage: 'INQUIRY', opened_at: 'x', escalated_at: null, dispute_amount: '400.00', original_claim_amount: '400.00' } });
    await world.store.put(rec);
    await expect(tracker.tick(CASE_ID)).rejects.toThrow(/does not match/);
    expect(await stored()).toEqual(rec);
  });

  it('says so for an unknown case', async () => {
    await expect(tracker.tick('nope')).rejects.toMatchObject({ status: 404 });
    await expect(tracker.tick('nope')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('following the claim to its end', () => {
  it('goes from claim to offer to accepted offer to money, keeping the original claim amount', async () => {
    world.listed = true;
    world.dispute = fixture('dispute-a-open');
    await tracker.tick(CASE_ID);

    world.dispute = fixture('dispute-a-offer-pending');
    let rec = await tracker.tick(CASE_ID);
    expect(rec.offer).toMatchObject({ amount: '300.00', status: 'pending', type: 'REFUND' });
    expect(rec.outcome).toBeNull();

    world.dispute = fixture('dispute-a-offer-accepted');
    rec = await tracker.tick(CASE_ID);
    expect(rec.offer?.status).toBe('accepted');
    expect(rec.outcome).toMatchObject({ status: 'money_back', amount_refunded: '300.00', outcome_code: null });
    expect(rec.dispute).toMatchObject({ dispute_amount: '300.00', original_claim_amount: '400.00' });

    world.dispute = fixture('dispute-a-resolved');
    rec = await tracker.tick(CASE_ID);
    expect(rec.dispute?.status).toBe('RESOLVED');
    expect(rec.outcome).toMatchObject({ status: 'money_back', amount_refunded: '300.00', outcome_code: 'RESOLVED_BUYER_FAVOUR' });
    expect(rec.dispute).toMatchObject({ dispute_amount: '300.00', original_claim_amount: '400.00' });
  });

  it('stops asking PayPal once the claim is resolved', async () => {
    world.listed = true;
    world.dispute = fixture('dispute-a-resolved');
    await tracker.tick(CASE_ID);
    const before = world.fake.calls.length;
    const again = await tracker.tick(CASE_ID);
    expect(world.fake.calls.length).toBe(before);
    expect(again.dispute?.status).toBe('RESOLVED');
  });

  it('is idempotent: the same answer twice writes nothing the second time', async () => {
    world.listed = true;
    world.dispute = fixture('dispute-a-offer-pending');
    const puts = vi.spyOn(world.store, 'put');
    const first = await tracker.tick(CASE_ID);
    const second = await tracker.tick(CASE_ID);
    expect(second).toEqual(first);
    expect(puts).toHaveBeenCalledTimes(1);
  });

  it('runs two ticks of one case one after the other', async () => {
    world.listed = true;
    world.dispute = fixture('dispute-a-open');
    await Promise.all([tracker.tick(CASE_ID), tracker.tick(CASE_ID)]);
    expect(lists()).toHaveLength(1); // the second tick already saw the dispute the first one stored
    expect(byId()).toHaveLength(2);
  });
});

describe('ticking every open case', () => {
  const cases = async () => {
    const open = paidCase({ id: 'open1' });
    const unpaid = paidCase({ id: 'unpaid', payment: null });
    const resolved = paidCase({ id: 'done', dispute: { id: 'PP-R-DONE', status: 'RESOLVED', life_cycle_stage: 'INQUIRY', opened_at: 'x', escalated_at: null, dispute_amount: '1.00', original_claim_amount: '1.00' } });
    for (const c of [open, unpaid, resolved]) await world.store.put(c);
  };

  it('looks at paid cases whose claim is not resolved', async () => {
    await world.store.put(paidCase({ id: 'only' }));
    await cases();
    const result = await tracker.tickOpenCases();
    expect(result).toEqual({ checked: 3, failed: 0 }); // B1-A, only and open1; not the unpaid or the resolved one
    expect(lists()).toHaveLength(3);
  });

  it('logs a case that fails and carries on with the rest', async () => {
    await world.store.put(paidCase({ id: 'second' }));
    let first = true;
    world.fake.setRoute((call) => {
      if (call.path === '/v1/customer/disputes') {
        if (first) {
          first = false;
          return { status: 500, body: { name: 'INTERNAL_SERVER_ERROR', message: 'try later' } };
        }
        return { body: { items: [] } };
      }
      return undefined;
    });
    const result = await tracker.tickOpenCases();
    expect(result).toEqual({ checked: 2, failed: 1 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^tick B1-A failed: PayPal 500/);
  });
});

describe('which cases the poller looks at', () => {
  const dayMs = 86_400_000;
  const paidDaysAgo = (id: string, days: number) => {
    const at = new Date(NOW.getTime() - days * dayMs).toISOString();
    return paidCase({ id, payment: { ...paidCase().payment!, captured_at: at } });
  };

  it('leaves out payments past day 180, but not day 180 itself', async () => {
    await world.store.put(paidDaysAgo('day180', 180));
    await world.store.put(paidDaysAgo('day181', 181));
    await world.store.put(paidDaysAgo('old', 400));
    const result = await tracker.tickOpenCases();
    expect(result).toEqual({ checked: 2, failed: 0 }); // the fresh case B1-A and the one on day 180
    expect(lists()).toHaveLength(2);
  });

  it('still looks when a person asks about an old case', async () => {
    await world.store.put(paidDaysAgo('old', 400));
    await tracker.tick('old');
    expect(lists()).toHaveLength(1);
  });
});

describe('a case that keeps failing', () => {
  const failOne = () => {
    world.fake.setRoute((call) => (call.path === '/v1/customer/disputes' ? { status: 500, body: { name: 'INTERNAL_SERVER_ERROR', message: 'try later' } } : undefined));
  };

  it('is tried every time for the first two failures, then left alone for 5, 10, 20 and at most 30 minutes', async () => {
    failOne();
    const tries = async () => (await tracker.tickOpenCases()).checked;
    expect(await tries()).toBe(1); // failure 1
    expect(await tries()).toBe(1); // failure 2
    expect(await tries()).toBe(1); // failure 3: now it waits 5 minutes
    expect(await tries()).toBe(0);
    later(minutes(4));
    expect(await tries()).toBe(0);
    later(minutes(1));
    expect(await tries()).toBe(1); // failure 4: waits 10 minutes
    later(minutes(9));
    expect(await tries()).toBe(0);
    later(minutes(1));
    expect(await tries()).toBe(1); // failure 5: waits 20 minutes
    later(minutes(20));
    expect(await tries()).toBe(1); // failure 6: waits 30 minutes
    later(minutes(29));
    expect(await tries()).toBe(0);
    later(minutes(1));
    expect(await tries()).toBe(1); // failure 7: still 30 minutes
    later(minutes(29));
    expect(await tries()).toBe(0);
    expect(logged.some((m) => /3 failures in a row/.test(m))).toBe(true);
  });

  it('starts over after one good look', async () => {
    failOne();
    for (let i = 0; i < 3; i++) await tracker.tickOpenCases();
    expect((await tracker.tickOpenCases()).checked).toBe(0);
    later(minutes(5));
    world.fake.setRoute(() => ({ body: { items: [] } }));
    expect(await tracker.tickOpenCases()).toEqual({ checked: 1, failed: 0 });
    failOne();
    expect((await tracker.tickOpenCases()).checked).toBe(1); // counting from one again
    expect((await tracker.tickOpenCases()).checked).toBe(1);
    expect((await tracker.tickOpenCases()).checked).toBe(1);
    expect((await tracker.tickOpenCases()).checked).toBe(0);
  });

  it('does not stop a person who asks about it', async () => {
    failOne();
    for (let i = 0; i < 3; i++) await tracker.tickOpenCases();
    world.fake.calls.length = 0;
    world.fake.setRoute(() => ({ body: { items: [] } }));
    await tracker.tick(CASE_ID);
    expect(lists()).toHaveLength(1);
    expect((await tracker.tickOpenCases()).checked).toBe(1); // the good look cleared the wait
  });
});

describe('poller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the job on every interval until stopped', async () => {
    const job = vi.fn(async () => undefined);
    const poller = startPoller(job, 90_000);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(job).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(job).toHaveBeenCalledTimes(3);
    await poller.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(job).toHaveBeenCalledTimes(3);
  });

  it('waits for a run that is still going when asked to stop', async () => {
    let release!: () => void;
    const job = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const poller = startPoller(job, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    const stopping = poller.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false); // the run has not finished
    expect(job).toHaveBeenCalledTimes(1); // and no new run was started
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stops at once when nothing is running', async () => {
    const poller = startPoller(async () => undefined, 1000);
    await expect(poller.stop()).resolves.toBeUndefined();
  });

  it('does not start a run while the previous one is still going', async () => {
    let release!: () => void;
    const job = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const poller = startPoller(job, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(job).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(job).toHaveBeenCalledTimes(2);
    release();
    await poller.stop();
  });

  it('reports a failing run and keeps polling', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const poller = startPoller(async () => { if (++n === 1) throw new Error('boom'); }, 1000, (e) => errors.push(e));
    await vi.advanceTimersByTimeAsync(3500);
    expect(n).toBe(3);
    expect(errors).toHaveLength(1);
    await poller.stop();
  });
});
