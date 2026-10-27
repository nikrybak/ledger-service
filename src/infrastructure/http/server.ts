import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { LedgerUseCases } from '../../application/useCases/index.js';
import { errorHandler } from './errorHandler.js';
import { registerAccountRoutes } from './routes/accountRoutes.js';
import { registerHealthRoutes } from './routes/healthRoutes.js';
import { registerTransferRoutes } from './routes/transferRoutes.js';

export interface ServerDependencies {
  readonly useCases: LedgerUseCases;
  readonly healthCheck: () => Promise<void>;
  readonly logger: FastifyServerOptions['logger'];
}

export function buildServer({ useCases, healthCheck, logger }: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` } }),
  );
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerHealthRoutes(app, healthCheck);
  registerAccountRoutes(app, useCases);
  registerTransferRoutes(app, useCases);

  return app;
}
