import { describe, expect, it } from 'vitest';
import { ownershipFrom } from '../src/ownership.js';
import { MemoryStore } from '../src/store.js';
import { paidCase } from './helpers/records.js';
import { DISPUTE_ID, ORDER_ID } from './helpers/world.js';

describe('ownershipFrom', () => {
  it('owns the orders and disputes recorded on a case, and nothing else', async () => {
    const store = new MemoryStore();
    const owns = ownershipFrom(store);
    expect(await owns.order(ORDER_ID)).toBe(false);
    await store.put(paidCase({ dispute: { id: DISPUTE_ID, status: 'OPEN', life_cycle_stage: 'INQUIRY', opened_at: 'x', escalated_at: null, dispute_amount: '1.00', original_claim_amount: '1.00' } }));
    expect(await owns.order(ORDER_ID)).toBe(true);
    expect(await owns.dispute(DISPUTE_ID)).toBe(true);
    expect(await owns.order('SOMEONEELSES')).toBe(false);
    expect(await owns.dispute('PP-R-OTHER')).toBe(false);
  });

  it('does not read every case to answer', async () => {
    const store = new MemoryStore();
    let listed = 0;
    const list = store.list.bind(store);
    store.list = async () => {
      listed += 1;
      return list();
    };
    await store.put(paidCase());
    await ownershipFrom(store).order(ORDER_ID);
    await ownershipFrom(store).dispute('PP-R-X');
    expect(listed).toBe(0);
  });
});
