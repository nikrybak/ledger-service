import type { Account, AccountId } from './account.js';
import { DomainError } from './errors.js';
import { convertAmount, type FxRate } from './fxRate.js';
import { assertBalanced, type JournalLine } from './journal.js';
import { assertValidAmount, type Currency } from './money.js';

export type TransferId = string;

export interface Transfer {
  readonly id: TransferId;
  readonly sourceAccountId: AccountId;
  readonly destinationAccountId: AccountId;
  /** Amount debited from the source, in the source currency. */
  readonly amount: bigint;
  readonly currency: Currency;
  /** Amount credited to the destination, in the destination currency. */
  readonly destinationAmount: bigint;
  readonly destinationCurrency: Currency;
  readonly fxRate: FxRate | null;
  readonly description: string | null;
  readonly lines: readonly JournalLine[];
  readonly createdAt: Date;
}

export interface FxClearingAccounts {
  readonly source: Account;
  readonly destination: Account;
}

export interface TransferPlan {
  readonly id: TransferId;
  readonly source: Account;
  readonly destination: Account;
  /** Current derived balance of the source; must be read under the same lock that guards the write. */
  readonly sourceBalance: bigint;
  readonly amount: bigint;
  readonly fxRate: FxRate | null;
  readonly fxClearing: FxClearingAccounts | null;
  readonly description: string | null;
  readonly createdAt: Date;
}

export const requiresFx = (source: Account, destination: Account): boolean =>
  source.currency !== destination.currency;

export function planTransfer(plan: TransferPlan): Transfer {
  const { source, destination, amount, fxRate } = plan;
  assertValidAmount(amount);

  if (source.id === destination.id) {
    throw new DomainError('SAME_ACCOUNT_TRANSFER', 'Source and destination accounts must differ');
  }

  const crossCurrency = requiresFx(source, destination);
  if (crossCurrency && fxRate === null) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `Cannot transfer ${source.currency} to ${destination.currency} without an explicit fxRate`,
    );
  }
  if (!crossCurrency && fxRate !== null) {
    throw new DomainError('INVALID_FX_RATE', 'fxRate is only allowed for cross-currency transfers');
  }

  const destinationAmount = fxRate === null ? amount : convertAmount(amount, fxRate);
  if (destinationAmount <= 0n) {
    throw new DomainError('INVALID_AMOUNT', 'Converted amount rounds to zero');
  }
  assertValidAmount(destinationAmount);

  if (!source.allowNegativeBalance && plan.sourceBalance < amount) {
    throw new DomainError('INSUFFICIENT_FUNDS', 'Source account has insufficient funds', {
      accountId: source.id,
      balance: plan.sourceBalance.toString(),
      requested: amount.toString(),
    });
  }

  const lines = crossCurrency
    ? crossCurrencyLines(plan, destinationAmount)
    : [
        line(source.id, 'debit', amount, source.currency),
        line(destination.id, 'credit', amount, destination.currency),
      ];
  assertBalanced(lines);

  return {
    id: plan.id,
    sourceAccountId: source.id,
    destinationAccountId: destination.id,
    amount,
    currency: source.currency,
    destinationAmount,
    destinationCurrency: destination.currency,
    fxRate,
    description: plan.description,
    lines,
    createdAt: plan.createdAt,
  };
}

function crossCurrencyLines(plan: TransferPlan, destinationAmount: bigint): JournalLine[] {
  const { source, destination, fxClearing } = plan;
  if (fxClearing === null) {
    throw new Error('FX clearing accounts are required for a cross-currency transfer');
  }
  if (
    fxClearing.source.currency !== source.currency ||
    fxClearing.destination.currency !== destination.currency
  ) {
    throw new Error('FX clearing accounts do not match the transfer currencies');
  }
  return [
    line(source.id, 'debit', plan.amount, source.currency),
    line(fxClearing.source.id, 'credit', plan.amount, source.currency),
    line(fxClearing.destination.id, 'debit', destinationAmount, destination.currency),
    line(destination.id, 'credit', destinationAmount, destination.currency),
  ];
}

const line = (
  accountId: AccountId,
  direction: JournalLine['direction'],
  amount: bigint,
  currency: Currency,
) => ({
  accountId,
  direction,
  amount,
  currency,
});
