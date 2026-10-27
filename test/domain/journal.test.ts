import { describe, expect, it } from 'vitest';

import { expectDomainError } from '../support/assertions.js';
import { assertBalanced, sumBalance, type JournalLine } from '../../src/domain/journal.js';
import { parseCurrency } from '../../src/domain/money.js';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');

const debit = (accountId: string, amount: bigint, currency = USD): JournalLine => ({
  accountId,
  direction: 'debit',
  amount,
  currency,
});
const credit = (accountId: string, amount: bigint, currency = USD): JournalLine => ({
  accountId,
  direction: 'credit',
  amount,
  currency,
});

describe('assertBalanced', () => {
  it('accepts an entry whose debits equal its credits', () => {
    expect(() => {
      assertBalanced([debit('a', 100n), credit('b', 60n), credit('c', 40n)]);
    }).not.toThrow();
  });

  it('rejects an entry that does not balance', () => {
    expectDomainError(() => {
      assertBalanced([debit('a', 100n), credit('b', 99n)]);
    }, 'UNBALANCED_ENTRY');
  });

  it('requires balance per currency, not across currencies', () => {
    expectDomainError(() => {
      assertBalanced([debit('a', 100n, USD), credit('b', 100n, EUR)]);
    }, 'UNBALANCED_ENTRY');
  });

  it('rejects single-line entries and non-positive amounts', () => {
    expectDomainError(() => {
      assertBalanced([debit('a', 0n)]);
    }, 'UNBALANCED_ENTRY');
    expectDomainError(() => {
      assertBalanced([debit('a', 0n), credit('b', 0n)]);
    }, 'INVALID_AMOUNT');
  });
});

describe('sumBalance', () => {
  it('treats credits as increases and debits as decreases', () => {
    expect(sumBalance([credit('a', 500n), debit('a', 120n), credit('a', 20n)])).toBe(400n);
    expect(sumBalance([])).toBe(0n);
  });
});
