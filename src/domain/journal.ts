import type { AccountId } from './account.js';
import { DomainError } from './errors.js';
import { assertValidAmount, type Currency } from './money.js';

export type Direction = 'debit' | 'credit';

export interface JournalLine {
  readonly accountId: AccountId;
  readonly direction: Direction;
  readonly amount: bigint;
  readonly currency: Currency;
}

/** A journal line as persisted, with a monotonically increasing sequence used for ordering and cursors. */
export interface Posting extends JournalLine {
  readonly seq: bigint;
  readonly transferId: string;
  readonly createdAt: Date;
}

/**
 * Balances follow the convention of customer (liability) accounts: credits increase, debits decrease.
 * The sign convention is irrelevant to the balancing rule, which only requires debits == credits.
 */
export function signedAmount(line: Pick<JournalLine, 'direction' | 'amount'>): bigint {
  return line.direction === 'credit' ? line.amount : -line.amount;
}

export function sumBalance(lines: Iterable<Pick<JournalLine, 'direction' | 'amount'>>): bigint {
  let balance = 0n;
  for (const line of lines) balance += signedAmount(line);
  return balance;
}

/** An entry balances when, for every currency it touches, total debits equal total credits. */
export function assertBalanced(lines: readonly JournalLine[]): void {
  if (lines.length < 2) {
    throw new DomainError('UNBALANCED_ENTRY', 'A journal entry needs at least two lines');
  }
  const totals = new Map<Currency, bigint>();
  for (const line of lines) {
    assertValidAmount(line.amount);
    totals.set(line.currency, (totals.get(line.currency) ?? 0n) + signedAmount(line));
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new DomainError('UNBALANCED_ENTRY', `Journal entry does not balance in ${currency}`, {
        currency,
        difference: total.toString(),
      });
    }
  }
}
