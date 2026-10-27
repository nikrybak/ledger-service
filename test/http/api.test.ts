import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUseCases } from '../../src/application/useCases/index.js';
import { buildServer } from '../../src/infrastructure/http/server.js';
import { InMemoryLedgerRepository } from '../../src/infrastructure/persistence/memory/inMemoryLedgerRepository.js';
import { systemClock, uuidGenerator } from '../../src/infrastructure/system.js';

interface AccountDto {
  id: string;
  balance: string;
  currency: string;
}

describe('HTTP API', () => {
  let app: FastifyInstance;
  let healthy: boolean;

  beforeEach(() => {
    healthy = true;
    const repository = new InMemoryLedgerRepository();
    app = buildServer({
      useCases: createUseCases(repository, uuidGenerator, systemClock),
      healthCheck: () => (healthy ? Promise.resolve() : Promise.reject(new Error('db down'))),
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const createAccount = async (payload: Record<string, unknown>): Promise<AccountDto> => {
    const response = await app.inject({ method: 'POST', url: '/accounts', payload });
    expect(response.statusCode).toBe(201);
    return response.json<AccountDto>();
  };

  const transfer = (payload: Record<string, unknown>, key: string | null = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/transfers',
      headers: key === null ? {} : { 'idempotency-key': key },
      payload,
    });

  const getAccount = async (id: string) =>
    (await app.inject({ method: 'GET', url: `/accounts/${id}` })).json<AccountDto>();

  async function fundedPair(amount = '10000') {
    const funding = await createAccount({ name: 'Funding', currency: 'USD', allowNegativeBalance: true });
    const alice = await createAccount({ name: 'Alice', currency: 'USD' });
    const bob = await createAccount({ name: 'Bob', currency: 'USD' });
    const response = await transfer({ sourceAccountId: funding.id, destinationAccountId: alice.id, amount });
    expect(response.statusCode).toBe(201);
    return { funding, alice, bob };
  }

  describe('GET /health', () => {
    it('reports ok when the repository is reachable', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(response.headers['x-request-id']).toBeTypeOf('string');
    });

    it('returns 503 when the repository is not', async () => {
      healthy = false;
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
    });
  });

  describe('accounts', () => {
    it('creates an account and reads it back with a derived balance', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts',
        payload: { name: 'Alice', currency: 'EUR' },
      });

      expect(response.statusCode).toBe(201);
      const created = response.json<AccountDto>();
      expect(response.headers.location).toBe(`/accounts/${created.id}`);
      expect(await getAccount(created.id)).toMatchObject({ currency: 'EUR', balance: '0' });
    });

    it('validates the payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts',
        payload: { name: '', currency: 'euro', extra: true },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 404 for an unknown account and 400 for a malformed id', async () => {
      const missing = await app.inject({ method: 'GET', url: `/accounts/${randomUUID()}` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });

      const malformed = await app.inject({ method: 'GET', url: '/accounts/not-a-uuid' });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe('POST /transfers', () => {
    it('moves money and returns balanced entries with string amounts', async () => {
      const { alice, bob } = await fundedPair();

      const response = await transfer({
        sourceAccountId: alice.id,
        destinationAccountId: bob.id,
        amount: '2500',
        description: 'dinner',
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['idempotent-replayed']).toBe('false');
      expect(response.json()).toMatchObject({
        amount: '2500',
        currency: 'USD',
        description: 'dinner',
        entries: [
          { accountId: alice.id, direction: 'debit', amount: '2500' },
          { accountId: bob.id, direction: 'credit', amount: '2500' },
        ],
      });
      expect((await getAccount(alice.id)).balance).toBe('7500');
      expect((await getAccount(bob.id)).balance).toBe('2500');
    });

    it('preserves precision beyond Number.MAX_SAFE_INTEGER', async () => {
      const { alice, bob } = await fundedPair('9007199254740993');
      await transfer({ sourceAccountId: alice.id, destinationAccountId: bob.id, amount: '9007199254740993' });
      expect((await getAccount(bob.id)).balance).toBe('9007199254740993');
    });

    it('requires an Idempotency-Key header', async () => {
      const { alice, bob } = await fundedPair();
      const response = await transfer(
        { sourceAccountId: alice.id, destinationAccountId: bob.id, amount: '1' },
        null,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('replays the original response for a repeated key and payload', async () => {
      const { alice, bob } = await fundedPair();
      const payload = { sourceAccountId: alice.id, destinationAccountId: bob.id, amount: '100' };

      const first = await transfer(payload, 'same-key');
      const second = await transfer(payload, 'same-key');

      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
      expect((await getAccount(bob.id)).balance).toBe('100');
    });

    it('returns 409 when a key is reused with a different payload', async () => {
      const { alice, bob } = await fundedPair();
      await transfer({ sourceAccountId: alice.id, destinationAccountId: bob.id, amount: '100' }, 'k');
      const response = await transfer(
        { sourceAccountId: alice.id, destinationAccountId: bob.id, amount: '200' },
        'k',
      );

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT' } });
    });

    it.each([
      ['insufficient funds', { amount: '10001' }, 422, 'INSUFFICIENT_FUNDS'],
      ['zero amount', { amount: '0' }, 422, 'INVALID_AMOUNT'],
      ['fractional amount', { amount: 1.5 }, 400, 'VALIDATION_ERROR'],
      ['decimal string amount', { amount: '1.50' }, 400, 'VALIDATION_ERROR'],
    ])('rejects %s', async (_, overrides, status, code) => {
      const { alice, bob } = await fundedPair();
      const response = await transfer({
        sourceAccountId: alice.id,
        destinationAccountId: bob.id,
        ...overrides,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
    });

    it('rejects cross-currency transfers without fxRate and converts with one', async () => {
      const { alice } = await fundedPair();
      const euro = await createAccount({ name: 'Euro', currency: 'EUR' });

      const rejected = await transfer({
        sourceAccountId: alice.id,
        destinationAccountId: euro.id,
        amount: '1000',
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({ error: { code: 'CURRENCY_MISMATCH' } });

      const converted = await transfer({
        sourceAccountId: alice.id,
        destinationAccountId: euro.id,
        amount: '1000',
        fxRate: '0.9150',
      });
      expect(converted.statusCode).toBe(201);
      expect(converted.json()).toMatchObject({
        destinationAmount: '915',
        destinationCurrency: 'EUR',
        fxRate: '0.915',
      });
      expect((await getAccount(euro.id)).balance).toBe('915');
    });

    it('rejects malformed JSON with a client error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/transfers',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'x' },
        payload: '{"amount":',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /accounts/:id/entries', () => {
    it('paginates with an opaque cursor', async () => {
      const { alice, bob } = await fundedPair();
      for (const amount of ['1', '2', '3']) {
        await transfer({ sourceAccountId: alice.id, destinationAccountId: bob.id, amount });
      }

      const page = async (query: string) => {
        const response = await app.inject({ method: 'GET', url: `/accounts/${alice.id}/entries${query}` });
        expect(response.statusCode).toBe(200);
        return response.json<{ data: { amount: string; direction: string }[]; nextCursor: string | null }>();
      };

      const first = await page('?limit=3');
      expect(first.data.map((entry) => entry.amount)).toEqual(['3', '2', '1']);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await page(`?limit=3&cursor=${first.nextCursor ?? ''}`);
      expect(second.data).toEqual([expect.objectContaining({ amount: '10000', direction: 'credit' })]);
      expect(second.nextCursor).toBeNull();
    });

    it('validates limit and cursor', async () => {
      const { alice } = await fundedPair();
      const tooBig = await app.inject({ method: 'GET', url: `/accounts/${alice.id}/entries?limit=1000` });
      expect(tooBig.statusCode).toBe(400);

      const badCursor = await app.inject({ method: 'GET', url: `/accounts/${alice.id}/entries?cursor=zzz` });
      expect(badCursor.statusCode).toBe(400);
      expect(badCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
    });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
