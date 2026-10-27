import { fileURLToPath } from 'node:url';

import pg from 'pg';
import pino from 'pino';

import { loadConfig } from './config/env.js';
import { runMigrations } from './infrastructure/persistence/postgres/migrator.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });

if (config.storage.kind !== 'postgres') {
  logger.error('Set STORAGE=postgres and DATABASE_URL to run migrations');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.storage.url, max: 1 });
try {
  // Resolves to <repo>/migrations from both src/ (tsx) and dist/ (compiled).
  const directory = fileURLToPath(new URL('../migrations', import.meta.url));
  const applied = await runMigrations(pool, directory);
  logger.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema is up to date');
} catch (error) {
  logger.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
