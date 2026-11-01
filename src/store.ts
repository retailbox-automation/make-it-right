// Where cases live: one table, one JSON document per case.
import { PGlite } from '@electric-sql/pglite';
import type { CaseRecord } from './model.js';

export interface Store {
  get(id: string): Promise<CaseRecord | undefined>;
  /** Insert or replace */
  put(record: CaseRecord): Promise<void>;
  /** Oldest first */
  list(): Promise<CaseRecord[]>;
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
    )`);
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

  async close(): Promise<void> {
    await this.db.close();
  }
}
