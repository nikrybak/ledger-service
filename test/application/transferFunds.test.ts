import { beforeEach, describe, expect, it } from 'vitest';

import type { TransferFundsCommand } from '../../src/application/useCases/transferFunds.js';
import type { Account } from '../../src/domain/account.js';
import { expectDomainErrorAsync } from '../support/assertions.js';
import { createLedger, type Ledger } from '../support/fixtures.js';

describe('TransferFunds', () => {
  let ledger: Ledger;
  let alice: Account;
  let bob: Account;

  const command = (overrides: Partial<TransferFundsCommand> = {}): TransferFundsCommand => ({
    idempotencyKey: 'key-1',
    sourceAccountId: alice.id,
    destinationAccountId: bob.id,
    amount: 300n,
    fxRate: null,
    description: 'rent',
    ...overrides,
  });

  const balanceOf = async (accountId: string) =>
    (await ledger.useCases.getAccount.execute(accountId)).balance;

  beforeEach(async () => {
    ledger = createLedger();
    alice = await ledger.fundedAccount('alice', 'USD', 1_000n);
    bob = await ledger.fundedAccount('bob', 'USD', 0n);
  });

  it('moves funds and derives both balances from the postings', async () => {
    const { transfer, replayed } = await ledger.useCases.transferFunds.execute(command());

    expect(replayed).toBe(false);
    expect(transfer.amount).toBe(300n);
    expect(await balanceOf(alice.id)).toBe(700n);
    expect(await balanceOf(bob.id)).toBe(300n);
  });

  describe('idempotency', () => {
    it('returns the original transfer for a repeated key and payload without posting twice', async () => {
      const first = await ledger.useCases.transferFunds.execute(command());
      const second = await ledger.useCases.transferFunds.execute(command());

      expect(second.replayed).toBe(true);
      expect(second.transfer).toEqual(first.transfer);
      expect(await balanceOf(alice.id)).toBe(700n);
    });

    it('treats equivalent fx rates as the same payload', async () => {
      const eve = await ledger.fundedAccount('eve', 'EUR', 0n);
      await ledger.useCases.transferFunds.execute(command({ destinationAccountId: eve.id, fxRate: '0.9' }));
      const again = await ledger.useCases.transferFunds.execute(
        command({ destinationAccountId: eve.id, fxRate: '0.900' }),
      );
      expect(again.replayed).toBe(true);
    });

    it('rejects a repeated key with a different payload', async () => {
      await ledger.useCases.transferFunds.execute(command());
      await expectDomainErrorAsync(
        ledger.useCases.transferFunds.execute(command({ amount: 301n })),
        'IDEMPOTENCY_KEY_CONFLICT',
      );
      expect(await balanceOf(alice.id)).toBe(700n);
    });

    it('does not burn the key when the transfer fails', async () => {
      await expectDomainErrorAsync(
        ledger.useCases.transferFunds.execute(command({ amount: 5_000n })),
        'INSUFFICIENT_FUNDS',
      );
      const retry = await ledger.useCases.transferFunds.execute(command({ amount: 1_000n }));
      expect(retry.replayed).toBe(false);
    });
  });

  it('never overdraws under concurrent transfers', async () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      ledger.useCases.transferFunds.execute(command({ idempotencyKey: `k-${String(i)}`, amount: 150n })),
    );
    const results = await Promise.allSettled(attempts);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(await balanceOf(alice.id)).toBe(100n);
    expect(await balanceOf(bob.id)).toBe(900n);
  });

  it('rejects unknown accounts', async () => {
    await expectDomainErrorAsync(
      ledger.useCases.transferFunds.execute(command({ destinationAccountId: 'missing' })),
      'ACCOUNT_NOT_FOUND',
    );
  });

  describe('cross-currency', () => {
    let eve: Account;

    beforeEach(async () => {
      eve = await ledger.fundedAccount('eve', 'EUR', 0n);
    });

    it('requires an explicit fx rate', async () => {
      await expectDomainErrorAsync(
        ledger.useCases.transferFunds.execute(command({ destinationAccountId: eve.id })),
        'CURRENCY_MISMATCH',
      );
    });

    it('converts with the given rate and keeps every currency balanced ledger-wide', async () => {
      const { transfer } = await ledger.useCases.transferFunds.execute(
        command({ destinationAccountId: eve.id, amount: 1_000n, fxRate: '0.92' }),
      );

      expect(transfer.destinationAmount).toBe(920n);
      expect(await balanceOf(alice.id)).toBe(0n);
      expect(await balanceOf(eve.id)).toBe(920n);

      const [usdClearing, eurClearing] = transfer.lines.slice(1, 3).map((line) => line.accountId);
      expect(await balanceOf(usdClearing ?? '')).toBe(1_000n);
      expect(await balanceOf(eurClearing ?? '')).toBe(-920n);
    });

    it('does not allow clearing accounts to be used directly', async () => {
      const { transfer } = await ledger.useCases.transferFunds.execute(
        command({ destinationAccountId: eve.id, amount: 100n, fxRate: '0.92' }),
      );
      const clearingId = transfer.lines[1]?.accountId ?? '';
      await expectDomainErrorAsync(
        ledger.useCases.transferFunds.execute(
          command({ idempotencyKey: 'k-2', sourceAccountId: clearingId }),
        ),
        'INVALID_ACCOUNT',
      );
    });
  });
});
