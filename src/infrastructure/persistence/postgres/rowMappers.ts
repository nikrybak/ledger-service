import type { Account } from '../../../domain/account.js';
import { parseFxRate } from '../../../domain/fxRate.js';
import type { Direction, JournalLine, Posting } from '../../../domain/journal.js';
import { parseCurrency } from '../../../domain/money.js';
import type { Transfer } from '../../../domain/transfer.js';

// node-postgres returns bigint and numeric columns as strings, which is what keeps them exact.

export interface AccountRow {
  id: string;
  name: string;
  currency: string;
  allow_negative_balance: boolean;
  system_role: 'fx_clearing' | null;
  created_at: Date;
}

export interface PostingRow {
  seq: string;
  transfer_id: string;
  account_id: string;
  direction: Direction;
  amount: string;
  currency: string;
  created_at: Date;
}

export interface TransferRow {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount: string;
  currency: string;
  destination_amount: string;
  destination_currency: string;
  fx_rate: string | null;
  description: string | null;
  created_at: Date;
}

export const ACCOUNT_COLUMNS = 'id, name, currency, allow_negative_balance, system_role, created_at';

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    currency: parseCurrency(row.currency),
    allowNegativeBalance: row.allow_negative_balance,
    systemRole: row.system_role,
    createdAt: row.created_at,
  };
}

export function toPosting(row: PostingRow): Posting {
  return {
    seq: BigInt(row.seq),
    transferId: row.transfer_id,
    accountId: row.account_id,
    direction: row.direction,
    amount: BigInt(row.amount),
    currency: parseCurrency(row.currency),
    createdAt: row.created_at,
  };
}

export function toTransfer(row: TransferRow, lines: readonly JournalLine[]): Transfer {
  return {
    id: row.id,
    sourceAccountId: row.source_account_id,
    destinationAccountId: row.destination_account_id,
    amount: BigInt(row.amount),
    currency: parseCurrency(row.currency),
    destinationAmount: BigInt(row.destination_amount),
    destinationCurrency: parseCurrency(row.destination_currency),
    fxRate: row.fx_rate === null ? null : parseFxRate(row.fx_rate),
    description: row.description,
    lines,
    createdAt: row.created_at,
  };
}
