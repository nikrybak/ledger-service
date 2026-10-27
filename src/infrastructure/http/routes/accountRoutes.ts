import type { FastifyInstance } from 'fastify';

import type { LedgerUseCases } from '../../../application/useCases/index.js';
import { presentAccount, presentEntriesPage, presentNewAccount } from '../presenters.js';
import { accountParams, createAccountBody, entriesQuery } from '../schemas.js';

export function registerAccountRoutes(app: FastifyInstance, useCases: LedgerUseCases): void {
  app.post('/accounts', async (request, reply) => {
    const body = createAccountBody.parse(request.body);
    const account = await useCases.createAccount.execute(body);
    return reply.code(201).header('location', `/accounts/${account.id}`).send(presentNewAccount(account));
  });

  app.get('/accounts/:id', async (request) => {
    const { id } = accountParams.parse(request.params);
    return presentAccount(await useCases.getAccount.execute(id));
  });

  app.get('/accounts/:id/entries', async (request) => {
    const { id } = accountParams.parse(request.params);
    const { limit, cursor } = entriesQuery.parse(request.query);
    const page = await useCases.listAccountEntries.execute({ accountId: id, limit, cursor: cursor ?? null });
    return presentEntriesPage(page);
  });
}
