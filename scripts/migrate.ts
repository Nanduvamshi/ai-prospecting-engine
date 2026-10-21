/**
 * Apply pending migrations.
 *
 * Run as a CI step before the app deploys, never from the container
 * entrypoint: multiple instances starting at once would race each other.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. See .env.example.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    console.log('[migrate] applying migrations from ./drizzle');
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('[migrate] done');
  } catch (err) {
    console.error('[migrate] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
