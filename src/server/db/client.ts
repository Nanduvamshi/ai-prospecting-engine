import 'server-only';

import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { required } from '@/server/env';

/**
 * Database access.
 *
 * The pool is cached on globalThis for the same reason the DynamoDB document
 * client was: Next's dev server re-evaluates modules on every hot reload, and
 * without this you leak a connection pool per edit until Postgres refuses new
 * connections.
 */

type Db = NodePgDatabase<typeof schema>;

interface DbGlobal {
  __prospectingPool?: Pool;
  __prospectingDb?: Db;
}

const globalRef = globalThis as unknown as DbGlobal;

export function getPool(): Pool {
  if (!globalRef.__prospectingPool) {
    const connectionString = required('DATABASE_URL');
    globalRef.__prospectingPool = new Pool({
      connectionString,
      // Managed Postgres over the public internet needs TLS, but the common
      // providers use certs that Node will not chain to a known root. This
      // matches what `sslmode=require` means in psql: encrypt, don't verify.
      ssl: connectionString.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
      max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    globalRef.__prospectingPool.on('error', (err) => {
      // An idle client erroring out is recoverable — pg will discard it and
      // open a new one. Log it rather than letting it reach process level.
      console.error('[db] idle client error:', err.message);
    });
  }
  return globalRef.__prospectingPool;
}

export function getDb(): Db {
  if (!globalRef.__prospectingDb) {
    globalRef.__prospectingDb = drizzle(getPool(), { schema });
  }
  return globalRef.__prospectingDb;
}

/** Convenience accessor. Prefer this in repository modules. */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    return Reflect.get(getDb(), prop);
  },
}) as Db;

/**
 * Run a function inside a transaction, tagging the connection with the acting
 * org so row-level security policies can see it.
 *
 * The contact graph is deliberately cross-tenant, which means one careless
 * JOIN could expose another org's contributions. In DynamoDB the partition
 * key made that structurally impossible; here it is only a WHERE clause away.
 * `app.org_id` is defence in depth behind the orgId-first repository
 * signatures — it is set even before any policy uses it, so enabling RLS
 * later is a migration rather than an application rewrite.
 */
export async function withTx<T>(
  orgId: string | null,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    if (orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    }
    return fn(tx);
  });
}

/** Liveness probe used by /api/health. */
export async function pingDatabase(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const result = await getDb().execute(sql`select version() as version`);
    const row = (result.rows?.[0] ?? {}) as { version?: string };
    return { ok: true, version: row.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { schema };
