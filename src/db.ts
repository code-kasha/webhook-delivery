import pg from 'pg';
import { readFile } from 'node:fs/promises';

export function createPool(url: string) {
  return new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 10000,
  });
}
export type Pool = pg.Pool;
export type Client = pg.PoolClient;
export async function transaction<T>(
  pool: Pool,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(pool: Pool) {
  const migration = await readFile(
    new URL('../migrations/001_initial.sql', import.meta.url),
    'utf8',
  );
  await transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(79482391)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    if (
      (await c.query('SELECT version FROM migrations WHERE version = 1'))
        .rowCount
    )
      return;
    await c.query(migration);
    await c.query('INSERT INTO migrations (version) VALUES (1)');
  });
}
export async function audit(
  c: Client,
  action: string,
  target: string,
  actor: string | null = null,
) {
  await c.query(
    'INSERT INTO audit_log (action, target_id, actor_id) VALUES ($1,$2,$3)',
    [action, target, actor],
  );
}
