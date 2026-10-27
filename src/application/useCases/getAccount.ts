import type { Account, AccountId } from '../../domain/account.js';
import { DomainError } from '../../domain/errors.js';
import type { LedgerRepository } from '../ports.js';

export interface AccountWithBalance {
  readonly account: Account;
  readonly balance: bigint;
}

export class GetAccount {
  constructor(private readonly repository: LedgerRepository) {}

  async execute(accountId: AccountId): Promise<AccountWithBalance> {
    const account = await this.repository.findAccount(accountId);
    if (!account) {
      throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${accountId} not found`, { accountId });
    }
    return { account, balance: await this.repository.getBalance(accountId) };
  }
}
