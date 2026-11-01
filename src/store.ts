// Where cases live: one table, one JSON document per case.
import { PGlite } from '@electric-sql/pglite';
import type { CaseRecord } from './model.js';

export interface Store {
  get(id: string): Promise<CaseRecord | undefined>;
  /** Insert or replace */
  put(record: CaseRecord): Promise<void>;
  /** Oldest first */
  list(): Promise<CaseRecord[]>;
  /** Is this PayPal order recorded on a case? Answered without reading the cases. */
  hasOrder(orderId: string): Promise<boolean>;
  /** Is this PayPal dispute recorded on a case? */
  hasDispute(disputeId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** For tests. Copies on the way in and out, like a database does. */
export class MemoryStore implements Store {
  private readonly cases = new Map<string, CaseRecord>();

  async get(id: string): Promise<CaseRecord | undefined> {
    const found = this.cases.get(id);
    return found && structuredClone(found);
  }

  async put(record: CaseRecord): Promise<void> {
    this.cases.set(record.id, structuredClone(record));
  }

  async list(): Promise<CaseRecord[]> {
    return [...this.cases.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => structuredClone(c));
  }

  async hasOrder(orderId: string): Promise<boolean> {
    return [...this.cases.values()].some((c) => c.payment?.order_id === orderId);
  }

  async hasDispute(disputeId: string): Promise<boolean> {
    return [...this.cases.values()].some((c) => c.dispute?.id === disputeId);
  }

  async close(): Promise<void> {}
}

/** PGlite: Postgres in-process. With a data directory it survives restarts; without one it lives in memory. */
export class PgliteStore implements Store {
  private constructor(private readonly db: PGlite) {}

  static async open(dataDir?: string): Promise<PgliteStore> {
    const db = new PGlite(dataDir);
    await db.exec(`create table if not exists cases (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz
    );
    create index if not exists cases_order_id on cases ((data->'payment'->>'order_id'));
    create index if not exists cases_dispute_id on cases ((data->'dispute'->>'id'))`);
    return new PgliteStore(db);
  }

  async get(id: string): Promise<CaseRecord | undefined> {
    const result = await this.db.query<{ data: CaseRecord }>('select data from cases where id = $1', [id]);
    return result.rows[0]?.data;
  }

  async put(record: CaseRecord): Promise<void> {
    await this.db.query(
      `insert into cases (id, data, updated_at) values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [record.id, JSON.stringify(record)],
    );
  }

  async list(): Promise<CaseRecord[]> {
    const result = await this.db.query<{ data: CaseRecord }>(`select data from cases order by data->>'created_at', id`);
    return result.rows.map((r) => r.data);
  }

  async hasOrder(orderId: string): Promise<boolean> {
    const result = await this.db.query(`select 1 from cases where data->'payment'->>'order_id' = $1 limit 1`, [orderId]);
    return result.rows.length > 0;
  }

  async hasDispute(disputeId: string): Promise<boolean> {
    const result = await this.db.query(`select 1 from cases where data->'dispute'->>'id' = $1 limit 1`, [disputeId]);
    return result.rows.length > 0;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
