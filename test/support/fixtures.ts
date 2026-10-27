import type { Clock, IdGenerator } from '../../src/application/ports.js';
import { createUseCases, type LedgerUseCases } from '../../src/application/useCases/index.js';
import type { Account } from '../../src/domain/account.js';
import { InMemoryLedgerRepository } from '../../src/infrastructure/persistence/memory/inMemoryLedgerRepository.js';

export function sequentialIds(prefix = 'id'): IdGenerator {
  let counter = 0;
  return { next: () => `${prefix}-${String(++counter).padStart(4, '0')}` };
}

export const fixedClock = (iso = '2026-01-01T12:00:00.000Z'): Clock => ({ now: () => new Date(iso) });

export interface Ledger {
  readonly repository: InMemoryLedgerRepository;
  readonly useCases: LedgerUseCases;
  /** Opens an account and funds it from a dedicated funding account. */
  fundedAccount(name: string, currency: string, balance: bigint): Promise<Account>;
}

export function createLedger(): Ledger {
  const repository = new InMemoryLedgerRepository();
  const useCases = createUseCases(repository, sequentialIds(), fixedClock());
  let funding = 0;

  return {
    repository,
    useCases,
    async fundedAccount(name, currency, balance) {
      const account = await useCases.createAccount.execute({ name, currency, allowNegativeBalance: false });
      if (balance > 0n) {
        const source = await useCases.createAccount.execute({
          name: `funding ${name}`,
          currency,
          allowNegativeBalance: true,
        });
        await useCases.transferFunds.execute({
          idempotencyKey: `funding-${String(++funding)}`,
          sourceAccountId: source.id,
          destinationAccountId: account.id,
          amount: balance,
          fxRate: null,
          description: 'initial funding',
        });
      }
      return account;
    },
  };
}
