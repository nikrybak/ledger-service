import { describe, expect, it } from 'vitest';

import { expectDomainError } from '../support/assertions.js';
import { openAccount, openFxClearingAccount, type Account } from '../../src/domain/account.js';
import { parseFxRate } from '../../src/domain/fxRate.js';
import { sumBalance } from '../../src/domain/journal.js';
import { parseCurrency } from '../../src/domain/money.js';
import { planTransfer, type TransferPlan } from '../../src/domain/transfer.js';

const now = new Date('2026-01-01T00:00:00Z');
const account = (id: string, currency: string, allowNegativeBalance = false): Account =>
  openAccount({ id, name: id, currency, allowNegativeBalance, createdAt: now });

const alice = account('alice', 'USD');
const bob = account('bob', 'USD');
const eve = account('eve', 'EUR');

const plan = (overrides: Partial<TransferPlan> = {}): TransferPlan => ({
  id: 't-1',
  source: alice,
  destination: bob,
  sourceBalance: 1_000n,
  amount: 250n,
  fxRate: null,
  fxClearing: null,
  description: null,
  createdAt: now,
  ...overrides,
});

describe('planTransfer', () => {
  it('debits the source and credits the destination with a balanced entry', () => {
    const transfer = planTransfer(plan());

    expect(transfer.lines).toEqual([
      { accountId: 'alice', direction: 'debit', amount: 250n, currency: 'USD' },
      { accountId: 'bob', direction: 'credit', amount: 250n, currency: 'USD' },
    ]);
    expect(sumBalance(transfer.lines)).toBe(0n);
    expect(transfer.destinationAmount).toBe(250n);
  });

  it('allows spending the exact balance', () => {
    expect(() => planTransfer(plan({ amount: 1_000n }))).not.toThrow();
  });

  it('rejects overdrafts on regular accounts', () => {
    expectDomainError(() => planTransfer(plan({ amount: 1_001n })), 'INSUFFICIENT_FUNDS');
  });

  it('lets accounts flagged allowNegativeBalance go below zero', () => {
    const funding = account('funding', 'USD', true);
    expect(() => planTransfer(plan({ source: funding, sourceBalance: 0n, amount: 5_000n }))).not.toThrow();
  });

  it('rejects transfers to the same account', () => {
    expectDomainError(() => planTransfer(plan({ destination: alice })), 'SAME_ACCOUNT_TRANSFER');
  });

  it.each([0n, -1n, 2n ** 63n])('rejects amount %s', (amount) => {
    expectDomainError(() => planTransfer(plan({ amount })), 'INVALID_AMOUNT');
  });

  describe('currency rules', () => {
    const fxClearing = {
      source: openFxClearingAccount('fx-usd', parseCurrency('USD'), now),
      destination: openFxClearingAccount('fx-eur', parseCurrency('EUR'), now),
    };

    it('rejects cross-currency transfers without an explicit rate', () => {
      expectDomainError(() => planTransfer(plan({ destination: eve, fxClearing })), 'CURRENCY_MISMATCH');
    });

    it('rejects an fxRate on a same-currency transfer', () => {
      expectDomainError(() => planTransfer(plan({ fxRate: parseFxRate('1') })), 'INVALID_FX_RATE');
    });

    it('routes cross-currency transfers through clearing accounts so each currency balances', () => {
      const transfer = planTransfer(plan({ destination: eve, fxRate: parseFxRate('0.92'), fxClearing }));

      expect(transfer.destinationAmount).toBe(230n);
      expect(transfer.lines).toEqual([
        { accountId: 'alice', direction: 'debit', amount: 250n, currency: 'USD' },
        { accountId: 'fx-usd', direction: 'credit', amount: 250n, currency: 'USD' },
        { accountId: 'fx-eur', direction: 'debit', amount: 230n, currency: 'EUR' },
        { accountId: 'eve', direction: 'credit', amount: 230n, currency: 'EUR' },
      ]);
    });

    it('rejects a conversion that rounds to zero', () => {
      expectDomainError(
        () => planTransfer(plan({ destination: eve, amount: 1n, fxRate: parseFxRate('0.1'), fxClearing })),
        'INVALID_AMOUNT',
      );
    });
  });
});

describe('openAccount', () => {
  it('validates currency and name', () => {
    expectDomainError(() => account('x', 'usd'), 'INVALID_CURRENCY');
    expectDomainError(
      () => openAccount({ id: 'x', name: '  ', currency: 'USD', createdAt: now }),
      'INVALID_ACCOUNT',
    );
  });
});
