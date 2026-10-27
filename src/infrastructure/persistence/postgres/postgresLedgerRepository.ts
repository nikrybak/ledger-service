import type { Pool, PoolClient } from 'pg';

import type {
  IdempotencyClaim,
  LedgerRepository,
  LedgerTransaction,
  PostingPage,
} from '../../../application/ports.js';
import type { Account, AccountId } from '../../../domain/account.js';
import { formatFxRate } from '../../../domain/fxRate.js';
import type { Posting } from '../../../domain/journal.js';
import type { Transfer, TransferId } from '../../../domain/transfer.js';
import {
  ACCOUNT_COLUMNS,
  toAccount,
  toPosting,
  toTransfer,
  type AccountRow,
  type PostingRow,
  type TransferRow,
} from './rowMappers.js';

type Queryable = Pick<PoolClient, 'query'>;

const POSTING_COLUMNS = 7;

const INSERT_ACCOUNT = `
  INSERT INTO accounts (${ACCOUNT_COLUMNS})
  VALUES ($1, $2, $3, $4, $5, $6)`;

const BALANCE = `
  SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0)::text AS balance
  FROM postings
  WHERE account_id = $1`;

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async saveAccount(account: Account): Promise<void> {
    await this.pool.query(INSERT_ACCOUNT, accountParams(account));
  }

  async findAccount(id: AccountId): Promise<Account | null> {
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
      [id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  getBalance(accountId: AccountId): Promise<bigint> {
    return balanceOf(this.pool, accountId);
  }

  async listPostings(accountId: AccountId, page: PostingPage): Promise<Posting[]> {
    const { rows } = await this.pool.query<PostingRow>(
      `SELECT seq::text, transfer_id, account_id, direction, amount::text, currency, created_at
       FROM postings
       WHERE account_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
       ORDER BY seq DESC
       LIMIT $3`,
      [accountId, page.beforeSeq?.toString() ?? null, page.limit],
    );
    return rows.map(toPosting);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let brokenConnection: Error | undefined;
    try {
      // READ COMMITTED on purpose: every statement takes a fresh snapshot, so the balance read
      // after SELECT ... FOR UPDATE sees postings committed by the transaction we waited for.
      // Under REPEATABLE READ the snapshot would predate the lock and the balance could be stale.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(new PostgresTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        brokenConnection = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      // Passing an error destroys the connection instead of returning a dirty one to the pool.
      client.release(brokenConnection);
    }
  }
}

class PostgresTransaction implements LedgerTransaction {
  constructor(private readonly client: PoolClient) {}

  async lockAccounts(ids: readonly AccountId[]): Promise<Account[]> {
    // ORDER BY id makes every transaction acquire row locks in the same order, which rules out deadlocks.
    const { rows } = await this.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[...new Set(ids)]],
    );
    return rows.map(toAccount);
  }

  getBalance(accountId: AccountId): Promise<bigint> {
    return balanceOf(this.client, accountId);
  }

  async ensureFxClearingAccount(candidate: Account): Promise<Account> {
    await this.client.query(
      `${INSERT_ACCOUNT} ON CONFLICT (currency) WHERE system_role = 'fx_clearing' DO NOTHING`,
      accountParams(candidate),
    );
    const { rows } = await this.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE system_role = 'fx_clearing' AND currency = $1`,
      [candidate.currency],
    );
    if (!rows[0]) throw new Error(`FX clearing account for ${candidate.currency} could not be created`);
    return toAccount(rows[0]);
  }

  async claimIdempotencyKey(
    key: string,
    requestHash: string,
    transferId: TransferId,
  ): Promise<IdempotencyClaim> {
    // A concurrent transaction holding the same key makes this INSERT wait until it commits or rolls back.
    const inserted = await this.client.query(
      `INSERT INTO idempotency_keys (key, request_hash, transfer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, requestHash, transferId],
    );
    if (inserted.rowCount === 1) return { status: 'claimed' };

    const { rows } = await this.client.query<{ request_hash: string; transfer_id: string }>(
      'SELECT request_hash, transfer_id FROM idempotency_keys WHERE key = $1',
      [key],
    );
    const row = rows[0];
    if (!row) throw new Error(`Idempotency key ${key} vanished after a conflict`);
    return { status: 'existing', requestHash: row.request_hash, transferId: row.transfer_id };
  }

  async saveTransfer(transfer: Transfer): Promise<void> {
    await this.client.query(
      `INSERT INTO transfers (id, source_account_id, destination_account_id, amount, currency,
                              destination_amount, destination_currency, fx_rate, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        transfer.id,
        transfer.sourceAccountId,
        transfer.destinationAccountId,
        transfer.amount.toString(),
        transfer.currency,
        transfer.destinationAmount.toString(),
        transfer.destinationCurrency,
        transfer.fxRate === null ? null : formatFxRate(transfer.fxRate),
        transfer.description,
        transfer.createdAt,
      ],
    );

    const values = transfer.lines.flatMap((line, lineNo) => [
      transfer.id,
      lineNo,
      line.accountId,
      line.direction,
      line.amount.toString(),
      line.currency,
      transfer.createdAt,
    ]);
    const tuples = transfer.lines.map(
      (_, row) =>
        `(${Array.from({ length: POSTING_COLUMNS }, (_, col) => `$${row * POSTING_COLUMNS + col + 1}`).join(', ')})`,
    );
    await this.client.query(
      `INSERT INTO postings (transfer_id, line_no, account_id, direction, amount, currency, created_at)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  async findTransfer(id: TransferId): Promise<Transfer | null> {
    const { rows } = await this.client.query<TransferRow>(
      `SELECT id, source_account_id, destination_account_id, amount::text, currency,
              destination_amount::text, destination_currency, fx_rate::text, description, created_at
       FROM transfers WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const postings = await this.client.query<PostingRow>(
      `SELECT seq::text, transfer_id, account_id, direction, amount::text, currency, created_at
       FROM postings WHERE transfer_id = $1 ORDER BY line_no`,
      [id],
    );
    const lines = postings.rows.map(toPosting).map(({ accountId, direction, amount, currency }) => ({
      accountId,
      direction,
      amount,
      currency,
    }));
    return toTransfer(row, lines);
  }
}

async function balanceOf(db: Queryable, accountId: AccountId): Promise<bigint> {
  const { rows } = await db.query<{ balance: string }>(BALANCE, [accountId]);
  return BigInt(rows[0]?.balance ?? '0');
}

function accountParams(account: Account): unknown[] {
  return [
    account.id,
    account.name,
    account.currency,
    account.allowNegativeBalance,
    account.systemRole,
    account.createdAt,
  ];
}
