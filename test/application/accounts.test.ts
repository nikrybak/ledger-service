import { beforeEach, describe, expect, it } from 'vitest';

import { expectDomainErrorAsync } from '../support/assertions.js';
import { createLedger, type Ledger } from '../support/fixtures.js';

describe('account use cases', () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = createLedger();
  });

  it('creates an account with a zero balance', async () => {
    const account = await ledger.useCases.createAccount.execute({
      name: ' Operating ',
      currency: 'EUR',
      allowNegativeBalance: false,
    });

    const { account: stored, balance } = await ledger.useCases.getAccount.execute(account.id);
    expect(stored).toMatchObject({ name: 'Operating', currency: 'EUR', systemRole: null });
    expect(balance).toBe(0n);
  });

  it('reports a missing account', async () => {
    await expectDomainErrorAsync(ledger.useCases.getAccount.execute('nope'), 'ACCOUNT_NOT_FOUND');
  });

  describe('ListAccountEntries', () => {
    it('pages through postings newest first with an opaque cursor', async () => {
      const alice = await ledger.fundedAccount('alice', 'USD', 1_000n);
      const bob = await ledger.fundedAccount('bob', 'USD', 0n);
      for (let i = 1; i <= 4; i++) {
        await ledger.useCases.transferFunds.execute({
          idempotencyKey: `t-${String(i)}`,
          sourceAccountId: alice.id,
          destinationAccountId: bob.id,
          amount: BigInt(i),
          fxRate: null,
          description: null,
        });
      }

      const list = (cursor: string | null) =>
        ledger.useCases.listAccountEntries.execute({ accountId: alice.id, limit: 2, cursor });

      const first = await list(null);
      expect(first.entries.map((e) => [e.direction, e.amount])).toEqual([
        ['debit', 4n],
        ['debit', 3n],
      ]);
      expect(first.nextCursor).not.toBeNull();

      const second = await list(first.nextCursor);
      expect(second.entries.map((e) => e.amount)).toEqual([2n, 1n]);

      const third = await list(second.nextCursor);
      expect(third.entries.map((e) => [e.direction, e.amount])).toEqual([['credit', 1_000n]]);
      expect(third.nextCursor).toBeNull();
    });

    it('rejects a tampered cursor', async () => {
      const alice = await ledger.fundedAccount('alice', 'USD', 0n);
      await expectDomainErrorAsync(
        ledger.useCases.listAccountEntries.execute({ accountId: alice.id, limit: 10, cursor: 'garbage' }),
        'INVALID_CURSOR',
      );
    });
  });
});
