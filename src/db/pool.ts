import pg from "pg";
import { getConfig } from "../config.ts";

// pg returns int8 (bigserial ids, count(*)) as strings. Our row interfaces type ids as number,
// and the scheduler keys its in-memory task map by id — with string ids, pause/delete lookups
// miss (tasks.get(6) vs key "6") and dead cron tasks keep firing until the next restart.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
	if (pool) return pool;
	pool = new pg.Pool({
		connectionString: getConfig().databaseUrl,
		max: 10,
		idleTimeoutMillis: 30_000,
	});
	return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[],
): Promise<pg.QueryResult<T>> {
	return getPool().query<T>(text, params as pg.QueryConfigValues<unknown[]>);
}

export async function closePool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
	}
}
