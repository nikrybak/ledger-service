import type { AccountWithBalance } from '../../application/useCases/getAccount.js';
import type { EntriesPage } from '../../application/useCases/listAccountEntries.js';
import type { Account } from '../../domain/account.js';
import { formatFxRate } from '../../domain/fxRate.js';
import type { Posting } from '../../domain/journal.js';
import type { Transfer } from '../../domain/transfer.js';

// Every bigint leaves the service as a decimal string; JSON numbers would silently lose precision.

export function presentAccount({ account, balance }: AccountWithBalance) {
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    allowNegativeBalance: account.allowNegativeBalance,
    systemRole: account.systemRole,
    balance: balance.toString(),
    createdAt: account.createdAt.toISOString(),
  };
}

export const presentNewAccount = (account: Account) => presentAccount({ account, balance: 0n });

export function presentTransfer(transfer: Transfer) {
  return {
    id: transfer.id,
    sourceAccountId: transfer.sourceAccountId,
    destinationAccountId: transfer.destinationAccountId,
    amount: transfer.amount.toString(),
    currency: transfer.currency,
    destinationAmount: transfer.destinationAmount.toString(),
    destinationCurrency: transfer.destinationCurrency,
    fxRate: transfer.fxRate === null ? null : formatFxRate(transfer.fxRate),
    description: transfer.description,
    entries: transfer.lines.map((line) => ({
      accountId: line.accountId,
      direction: line.direction,
      amount: line.amount.toString(),
      currency: line.currency,
    })),
    createdAt: transfer.createdAt.toISOString(),
  };
}

function presentPosting(posting: Posting) {
  return {
    transferId: posting.transferId,
    direction: posting.direction,
    amount: posting.amount.toString(),
    currency: posting.currency,
    createdAt: posting.createdAt.toISOString(),
  };
}

export function presentEntriesPage(page: EntriesPage) {
  return { data: page.entries.map(presentPosting), nextCursor: page.nextCursor };
}
