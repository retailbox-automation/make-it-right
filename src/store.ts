// Where cases live: one table, one JSON document per case.
import { PGlite } from '@electric-sql/pglite';
import type { CaseRecord } from './model.js';

/** Places counted per key and day, kept with the cases so a restart does not reset them (the public demo's refund cap) */
export interface DailyPlaces {
  /** Takes one of `limit` places of `key` on `day`, or answers null when all are taken. One answer at a time: two callers never get the last place. */
  takeDailyPlace(key: string, day: string, limit: number, note: string): Promise<number | null>;
  /** Gives back a place taken with takeDailyPlace */
  releaseDailyPlace(id: number): Promise<void>;
}

export interface Store extends DailyPlaces {
  get(id: string): Promise<CaseRecord | undefined>;
  /** Insert or replace */
  put(record: CaseRecord): Promise<void>;
  /** Oldest first */
  list(): Promise<CaseRecord[]>;
  /** Is this PayPal order recorded on a case? Answered without reading the cases. */
  hasOrder(orderId: string): Promise<boolean>;
  /** The id of the case that recorded this PayPal order, if any */
  caseIdForOrder(orderId: string): Promise<string | undefined>;
  /** Is this PayPal dispute recorded on a case? */
  hasDispute(disputeId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** For tests. Copies on the way in and out, like a database does. */
export class MemoryStore implements Store {
  private readonly cases = new Map<string, CaseRecord>();
  private readonly places: Array<{ id: number; key: string; day: string }> = [];
  private lastPlace = 0;

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

  async caseIdForOrder(orderId: string): Promise<string | undefined> {
    return [...this.cases.values()].find((c) => c.payment?.order_id === orderId)?.id;
  }

  async hasDispute(disputeId: string): Promise<boolean> {
    return [...this.cases.values()].some((c) => c.dispute?.id === disputeId);
  }

  async takeDailyPlace(key: string, day: string, limit: number): Promise<number | null> {
    if (this.places.filter((p) => p.key === key && p.day === day).length >= limit) return null;
    const id = ++this.lastPlace;
    this.places.push({ id, key, day });
    return id;
  }

  async releaseDailyPlace(id: number): Promise<void> {
    const at = this.places.findIndex((p) => p.id === id);
    if (at >= 0) this.places.splice(at, 1);
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
    create index if not exists cases_dispute_id on cases ((data->'dispute'->>'id'));
    create table if not exists daily_places (
      id serial primary key,
      key text not null,
      day text not null,
      note text not null,
      taken_at timestamptz not null default now()
    );
    create index if not exists daily_places_key_day on daily_places (key, day)`);
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

  async caseIdForOrder(orderId: string): Promise<string | undefined> {
    const result = await this.db.query<{ id: string }>(`select id from cases where data->'payment'->>'order_id' = $1 order by id limit 1`, [orderId]);
    return result.rows[0]?.id;
  }

  async hasDispute(disputeId: string): Promise<boolean> {
    const result = await this.db.query(`select 1 from cases where data->'dispute'->>'id' = $1 limit 1`, [disputeId]);
    return result.rows.length > 0;
  }

  async takeDailyPlace(key: string, day: string, limit: number, note: string): Promise<number | null> {
    // One statement: the count and the insert cannot be split by another caller
    const result = await this.db.query<{ id: number }>(
      `insert into daily_places (key, day, note)
       select $1, $2, $3 where (select count(*) from daily_places where key = $1 and day = $2) < $4
       returning id`,
      [key, day, note, limit],
    );
    return result.rows[0]?.id ?? null;
  }

  async releaseDailyPlace(id: number): Promise<void> {
    await this.db.query('delete from daily_places where id = $1', [id]);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
