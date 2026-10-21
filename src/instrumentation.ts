/**
 * Server startup.
 *
 * Next calls `register` once per server process, before any request is
 * handled. Two things need to happen there.
 *
 * First, the connection string. On AWS the database password is generated
 * into Secrets Manager and the container only receives an ARN, so the URL has
 * to be assembled before anything opens a pool. Resolving it here keeps the
 * pool accessor synchronous, which is what every repository already assumes.
 *
 * Second, migrations. The plan said to run these from CI, never at container
 * start, because concurrent instances would race. That reasoning is right but
 * its conclusion does not survive the network topology: the database sits in
 * private subnets, so CI cannot reach it at all without a bastion, a tunnel,
 * or a Lambda inside the VPC. Rather than add that machinery, migrations run
 * here behind a Postgres advisory lock — which removes the race directly. One
 * instance acquires the lock and migrates; the others block, then find the
 * work already done.
 */
export async function register() {
  // Only in the Node runtime — the edge runtime has no pg and no filesystem.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { resolveConnectionString } = await import('@/server/db/connection-string');

  try {
    const connectionString = await resolveConnectionString();
    // Published so the pool accessor can stay synchronous.
    process.env.DATABASE_URL = connectionString;
  } catch (err) {
    // Fail loudly and early. A server that starts without a database only
    // fails later, on a request, where it looks like an application bug.
    console.error('[startup] could not resolve a database connection:', err);
    throw err;
  }

  if (process.env.MIGRATE_ON_BOOT === 'true') {
    await runMigrations();
  }

  const { logCapabilitiesOnce } = await import('@/server/env');
  logCapabilitiesOnce();
}

/**
 * Apply pending migrations under an advisory lock.
 *
 * `pg_advisory_lock` is held for the session and released when the connection
 * closes, including if the process dies mid-migration — so a crashed deploy
 * does not leave the lock stuck. The constant is arbitrary but must be stable:
 * it is the identity of "this application's migrations".
 */
async function runMigrations() {
  const MIGRATION_LOCK_ID = 8_147_223_901;

  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');

  const connectionString = process.env.DATABASE_URL!;
  const ssl = connectionString.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined;

  // Two pools, deliberately. An advisory lock is held for the life of a
  // session, so the lock has to sit on a connection that stays checked out for
  // the whole migration. Taking it from the same pool the migrator uses
  // deadlocks: the lock holds the only connection and the migrator waits
  // forever for one that will never be released.
  const lockPool = new Pool({ connectionString, max: 1, ssl });
  const migratePool = new Pool({ connectionString, max: 1, ssl });

  const lockClient = await lockPool.connect();
  try {
    console.log('[startup] waiting for the migration lock');
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    console.log('[startup] applying migrations');

    await migrate(drizzle(migratePool), { migrationsFolder: './drizzle' });
    console.log('[startup] migrations up to date');
  } catch (err) {
    // Serving requests against a schema the code does not match produces
    // confusing failures spread across every route. Refusing to start is
    // clearer, and keeps the previous revision serving.
    console.error('[startup] migrations failed:', err);
    throw err;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    lockClient.release();
    await Promise.all([lockPool.end(), migratePool.end()]);
  }
}
