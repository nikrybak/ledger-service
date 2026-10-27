import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import pg from 'pg';

import type { LedgerRepository } from './application/ports.js';
import { createUseCases } from './application/useCases/index.js';
import type { Config } from './config/env.js';
import { buildServer } from './infrastructure/http/server.js';
import { InMemoryLedgerRepository } from './infrastructure/persistence/memory/inMemoryLedgerRepository.js';
import { PostgresLedgerRepository } from './infrastructure/persistence/postgres/postgresLedgerRepository.js';
import { systemClock, uuidGenerator } from './infrastructure/system.js';

/** Wires every adapter by hand; this is the only module that knows about concrete implementations. */
export function buildApplication(config: Config): FastifyInstance {
  const pool =
    config.storage.kind === 'postgres'
      ? new pg.Pool({ connectionString: config.storage.url, max: config.storage.poolSize })
      : null;
  const repository: LedgerRepository = pool
    ? new PostgresLedgerRepository(pool)
    : new InMemoryLedgerRepository();

  const app = buildServer({
    useCases: createUseCases(repository, uuidGenerator, systemClock),
    healthCheck: () => repository.ping(),
    logger: loggerOptions(config),
  });

  if (pool) {
    // Without a listener, an error on an idle pooled connection would crash the process.
    pool.on('error', (error) => {
      app.log.error({ err: error }, 'idle PostgreSQL client error');
    });
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }
  return app;
}

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(config.env === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  };
}
