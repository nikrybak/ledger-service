import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance, healthCheck: () => Promise<void>): void {
  app.get('/health', async (request, reply) => {
    try {
      await healthCheck();
      return { status: 'ok' };
    } catch (error) {
      request.log.warn({ err: error }, 'health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
