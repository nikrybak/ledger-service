import type { Clock, IdGenerator, LedgerRepository } from '../ports.js';
import { CreateAccount } from './createAccount.js';
import { GetAccount } from './getAccount.js';
import { ListAccountEntries } from './listAccountEntries.js';
import { TransferFunds } from './transferFunds.js';

export interface LedgerUseCases {
  readonly createAccount: CreateAccount;
  readonly getAccount: GetAccount;
  readonly transferFunds: TransferFunds;
  readonly listAccountEntries: ListAccountEntries;
}

export function createUseCases(repository: LedgerRepository, ids: IdGenerator, clock: Clock): LedgerUseCases {
  return {
    createAccount: new CreateAccount(repository, ids, clock),
    getAccount: new GetAccount(repository),
    transferFunds: new TransferFunds(repository, ids, clock),
    listAccountEntries: new ListAccountEntries(repository),
  };
}
