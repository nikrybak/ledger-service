import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { openAccount } from '../../src/domain/account.js';
import { PostgresLedgerRepository } from '../../src/infrastructure/persistence/postgres/postgresLedgerRepository.js';

interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

type Responder = (text: string, values: unknown[] | undefined) => { rows: unknown[]; rowCount?: number };

/** Minimal stand-in for pg.Pool that records SQL, so the adapter's protocol can be tested without a database. */
function fakePool(respond: Responder = () => ({ rows: [] })) {
  const queries: RecordedQuery[] = [];
  const released: unknown[] = [];
  const query = (text: string, values?: unknown[]) => {
    queries.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    try {
      const result = respond(text, values);
      return Promise.resolve({ rowCount: result.rows.length, ...result });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const client = {
    query,
    release: (error?: unknown) => {
      released.push(error);
    },
  };
  const pool = { query, connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, queries, released, statements: () => queries.map((q) => q.text) };
}

const accountRow = (id: string) => ({
  id,
  name: id,
  currency: 'USD',
  allow_negative_balance: false,
  system_role: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
});

describe('PostgresLedgerRepository', () => {
  it('wraps work in a READ COMMITTED transaction and commits on success', async () => {
    const db = fakePool();
    const repository = new PostgresLedgerRepository(db.pool);

    const result = await repository.transaction(() => Promise.resolve('done'));

    expect(result).toBe('done');
    expect(db.statements()).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'COMMIT']);
    expect(db.released).toEqual([undefined]);
  });

  it('rolls back, releases the client and rethrows when work fails', async () => {
    const db = fakePool();
    const repository = new PostgresLedgerRepository(db.pool);
    const failure = new Error('boom');

    await expect(repository.transaction(() => Promise.reject(failure))).rejects.toBe(failure);

    expect(db.statements()).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK']);
    expect(db.released).toEqual([undefined]);
  });

  it('destroys the connection when ROLLBACK itself fails', async () => {
    const db = fakePool((text) => {
      if (text === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [] };
    });
    const repository = new PostgresLedgerRepository(db.pool);

    await expect(repository.transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(db.released[0]).toBeInstanceOf(Error);
  });

  it('locks accounts with SELECT ... FOR UPDATE in a deterministic order', async () => {
    const db = fakePool((text) =>
      text.includes('FOR UPDATE') ? { rows: [accountRow('a'), accountRow('b')] } : { rows: [] },
    );
    const repository = new PostgresLedgerRepository(db.pool);

    const locked = await repository.transaction((tx) => tx.lockAccounts(['b', 'a', 'b']));

    const lock = db.queries.find((q) => q.text.includes('FOR UPDATE'));
    expect(lock?.text).toMatch(/WHERE id = ANY\(\$1::uuid\[\]\) ORDER BY id FOR UPDATE$/);
    expect(lock?.values).toEqual([['b', 'a']]);
    expect(locked.map((account) => account.id)).toEqual(['a', 'b']);
  });

  it('parses balances exactly, beyond the range of a double', async () => {
    const db = fakePool(() => ({ rows: [{ balance: '-92233720368547758' }] }));
    const repository = new PostgresLedgerRepository(db.pool);

    expect(await repository.getBalance('a')).toBe(-92_233_720_368_547_758n);
  });

  it('reports an existing idempotency key when the insert conflicts', async () => {
    const db = fakePool((text) =>
      text.includes('SELECT request_hash')
        ? { rows: [{ request_hash: 'h1', transfer_id: 't-original' }] }
        : { rows: [], rowCount: 0 },
    );
    const repository = new PostgresLedgerRepository(db.pool);

    const claim = await repository.transaction((tx) => tx.claimIdempotencyKey('k', 'h2', 't-new'));

    expect(claim).toEqual({ status: 'existing', requestHash: 'h1', transferId: 't-original' });
  });

  it('stores amounts as strings to avoid precision loss', async () => {
    const db = fakePool();
    const repository = new PostgresLedgerRepository(db.pool);
    const account = openAccount({ id: 'a', name: 'A', currency: 'USD', createdAt: new Date() });

    await repository.saveAccount(account);
    await repository.listPostings('a', { limit: 10, beforeSeq: 9_007_199_254_740_993n });

    expect(db.queries[1]?.values).toEqual(['a', '9007199254740993', 10]);
  });
});
