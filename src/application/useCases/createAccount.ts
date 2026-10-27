import { openAccount, type Account } from '../../domain/account.js';
import type { Clock, IdGenerator, LedgerRepository } from '../ports.js';

export interface CreateAccountCommand {
  readonly name: string;
  readonly currency: string;
  readonly allowNegativeBalance: boolean;
}

export class CreateAccount {
  constructor(
    private readonly repository: LedgerRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateAccountCommand): Promise<Account> {
    const account = openAccount({ id: this.ids.next(), ...command, createdAt: this.clock.now() });
    await this.repository.saveAccount(account);
    return account;
  }
}
