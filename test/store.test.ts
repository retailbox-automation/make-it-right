import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaseRecord } from '../src/model.js';
import { MemoryStore, PgliteStore, type Store } from '../src/store.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './helpers/demo.js';

const record = (id: string, created_at = '2026-11-01T10:00:00.000Z'): CaseRecord => ({
  id, created_at, payee_name: 'Ridgeway Electric', promised_items: RIDGEWAY_ITEMS, verdicts: RIDGEWAY_VERDICTS, paid_at: '2026-09-12',
  payment: { order_id: 'O1', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=O1', status: 'created', capture_id: null, capture_status: null, captured_at: null, method: null },
  buyer_transaction_id: null, dispute: null, offer: null, outcome: null,
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const kinds: Array<[string, () => Promise<Store>]> = [
  ['MemoryStore', async () => new MemoryStore()],
  ['PgliteStore (in memory)', async () => {
    const store = await PgliteStore.open();
    cleanups.push(() => store.close());
    return store;
  }],
];

describe.each(kinds)('%s', (_name, make) => {
  it('gives back what was stored, and nothing for an unknown id', async () => {
    const store = await make();
    await store.put(record('one'));
    expect(await store.get('one')).toEqual(record('one'));
    expect(await store.get('two')).toBeUndefined();
  });

  it('replaces a case when it is stored again', async () => {
    const store = await make();
    await store.put(record('one'));
    await store.put({ ...record('one'), buyer_transaction_id: '27S431280V029084G' });
    expect((await store.get('one'))?.buyer_transaction_id).toBe('27S431280V029084G');
    expect(await store.list()).toHaveLength(1);
  });

  it('lists cases oldest first', async () => {
    const store = await make();
    await store.put(record('b', '2026-11-01T11:00:00.000Z'));
    await store.put(record('a', '2026-11-01T10:00:00.000Z'));
    await store.put(record('c', '2026-11-01T12:00:00.000Z'));
    expect((await store.list()).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('knows which orders and disputes are on a case, without handing out the cases', async () => {
    const store = await make();
    const withDispute: CaseRecord = {
      ...record('one'),
      dispute: { id: 'PP-R-ONE', status: 'OPEN', life_cycle_stage: 'INQUIRY', opened_at: 'x', escalated_at: null, dispute_amount: '1.00', original_claim_amount: '1.00' },
    };
    await store.put(withDispute);
    await store.put({ ...record('two'), payment: null });
    expect(await store.hasOrder('O1')).toBe(true);
    expect(await store.hasOrder('O2')).toBe(false);
    expect(await store.hasDispute('PP-R-ONE')).toBe(true);
    expect(await store.hasDispute('PP-R-TWO')).toBe(false);
    await store.put({ ...withDispute, payment: { ...withDispute.payment!, order_id: 'O2' } });
    expect(await store.hasOrder('O1')).toBe(false);
    expect(await store.hasOrder('O2')).toBe(true);
  });

  it('hands out copies: changing one does not change the store', async () => {
    const store = await make();
    await store.put(record('one'));
    const copy = (await store.get('one'))!;
    copy.payee_name = 'Changed';
    copy.promised_items.pop();
    expect((await store.get('one'))?.payee_name).toBe('Ridgeway Electric');
    expect((await store.get('one'))?.promised_items).toHaveLength(6);
    const input = record('two');
    await store.put(input);
    input.payee_name = 'Changed after put';
    expect((await store.get('two'))?.payee_name).toBe('Ridgeway Electric');
  });
});

describe('PgliteStore on disk', () => {
  it('keeps cases across restarts, in a single table cases(id, data jsonb, updated_at timestamptz)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-store-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = await PgliteStore.open(join(dir, 'db'));
    await first.put(record('kept'));
    await first.close();

    const second = await PgliteStore.open(join(dir, 'db'));
    expect(await second.get('kept')).toEqual(record('kept'));
    await second.close();

    const raw = new PGlite(join(dir, 'db'));
    const columns = await raw.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'cases' order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'data', data_type: 'jsonb' },
      { column_name: 'id', data_type: 'text' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ]);
    await raw.close();
  });
});
