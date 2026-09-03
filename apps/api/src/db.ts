import pg from "pg";
import type { Config } from "@proofrelay/config";

/**
 * Postgres access.
 *
 * numeric(78,0) columns hold wei, which does not fit a double. node-postgres
 * parses NUMERIC as a JS string by default and that is what we want — every
 * amount stays a decimal string until something converts it to a bigint on
 * purpose. int8 is likewise left as a string by default; we override that,
 * because block numbers and counts are small and a string block number is a
 * papercut in every comparison.
 */
pg.types.setTypeParser(20, (value) => Number(value)); // int8

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.api.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "proofrelay-api",
  });
  // An idle client that errors (a server restart, a dropped socket) would
  // otherwise reach the process as an unhandled 'error' event and kill the API.
  pool.on("error", () => undefined);
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(
  db: pg.Pool | pg.PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await db.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(
  db: pg.Pool | pg.PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, values);
  return result.rows;
}

export async function databaseHealth(pool: pg.Pool): Promise<{ ok: boolean; detail: string | null; latencyMs: number }> {
  const started = Date.now();
  try {
    const result = await pool.query<{ n: number }>("SELECT 1 AS n");
    return {
      ok: result.rows[0]?.n === 1,
      detail: `pool ${pool.totalCount} total / ${pool.idleCount} idle`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, detail: String((error as Error).message).slice(0, 200), latencyMs: Date.now() - started };
  }
}

/** Seconds-since-epoch from the chain, or null when the field is unset (0). */
export function chainTimeToDate(seconds: number | bigint | null | undefined): Date | null {
  const value = Number(seconds ?? 0);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}
