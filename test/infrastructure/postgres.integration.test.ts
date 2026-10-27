import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUseCases, type LedgerUseCases } from '../../src/application/useCases/index.js';
import { runMigrations } from '../../src/infrastructure/persistence/postgres/migrator.js';
import { PostgresLedgerRepository } from '../../src/infrastructure/persistence/postgres/postgresLedgerRepository.js';
import { systemClock, uuidGenerator } from '../../src/infrastructure/system.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

// Opt-in: runs only when TEST_DATABASE_URL points at a disposable database (see docker-compose.yml).
describe.skipIf(!databaseUrl)('PostgreSQL adapter (integration)', () => {
  const schema = `ledger_test_${randomUUID().replace(/-/g, '')}`;
  let pool: pg.Pool;
  let useCases: LedgerUseCases;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema}` });
    await runMigrations(pool, fileURLToPath(new URL('../../migrations', import.meta.url)));
    useCases = createUseCases(new PostgresLedgerRepository(pool), uuidGenerator, systemClock);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  async function fundedAccount(balance: bigint) {
    const funding = await useCases.createAccount.execute({
      name: 'funding',
      currency: 'USD',
      allowNegativeBalance: true,
    });
    const account = await useCases.createAccount.execute({
      name: 'customer',
      currency: 'USD',
      allowNegativeBalance: false,
    });
    await useCases.transferFunds.execute({
      idempotencyKey: randomUUID(),
      sourceAccountId: funding.id,
      destinationAccountId: account.id,
      amount: balance,
      fxRate: null,
      description: null,
    });
    return account;
  }

  it('never overdraws under concurrent transfers', async () => {
    const source = await fundedAccount(1_000n);
    const destination = await fundedAccount(0n);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        useCases.transferFunds.execute({
          idempotencyKey: randomUUID(),
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          amount: 150n,
          fxRate: null,
          description: null,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect((await useCases.getAccount.execute(source.id)).balance).toBe(100n);
    expect((await useCases.getAccount.execute(destination.id)).balance).toBe(900n);
  });

  it('applies a key only once when the same request races itself', async () => {
    const source = await fundedAccount(1_000n);
    const destination = await fundedAccount(0n);
    const command = {
      idempotencyKey: randomUUID(),
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: 10n,
      fxRate: null,
      description: null,
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => useCases.transferFunds.execute(command)),
    );

    expect(new Set(results.map((r) => r.transfer.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await useCases.getAccount.execute(destination.id)).balance).toBe(10n);
  });

  it('round-trips cross-currency transfers through clearing accounts', async () => {
    const source = await fundedAccount(1_000n);
    const euro = await useCases.createAccount.execute({
      name: 'eur',
      currency: 'EUR',
      allowNegativeBalance: false,
    });
    const command = {
      idempotencyKey: randomUUID(),
      sourceAccountId: source.id,
      destinationAccountId: euro.id,
      amount: 500n,
      fxRate: '0.92',
      description: 'fx',
    };

    const first = await useCases.transferFunds.execute(command);
    const replay = await useCases.transferFunds.execute(command);

    expect(first.transfer.lines).toHaveLength(4);
    expect(replay.transfer).toEqual(first.transfer);
    expect((await useCases.getAccount.execute(euro.id)).balance).toBe(460n);
  });
});
