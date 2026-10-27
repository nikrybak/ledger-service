import type { FastifyInstance } from 'fastify';

import type { LedgerUseCases } from '../../../application/useCases/index.js';
import { presentTransfer } from '../presenters.js';
import { idempotencyKeyHeader, transferBody } from '../schemas.js';

export function registerTransferRoutes(app: FastifyInstance, useCases: LedgerUseCases): void {
  app.post('/transfers', async (request, reply) => {
    const idempotencyKey = idempotencyKeyHeader.parse(request.headers['idempotency-key']);
    const body = transferBody.parse(request.body);

    const { transfer, replayed } = await useCases.transferFunds.execute({
      idempotencyKey,
      sourceAccountId: body.sourceAccountId,
      destinationAccountId: body.destinationAccountId,
      amount: body.amount,
      fxRate: body.fxRate ?? null,
      description: body.description ?? null,
    });

    return reply.code(201).header('idempotent-replayed', String(replayed)).send(presentTransfer(transfer));
  });
}
