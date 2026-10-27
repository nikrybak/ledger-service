import { createHash } from 'node:crypto';

import { openFxClearingAccount, type Account, type AccountId } from '../../domain/account.js';
import { DomainError } from '../../domain/errors.js';
import { formatFxRate, parseFxRate, type FxRate } from '../../domain/fxRate.js';
import { planTransfer, requiresFx, type FxClearingAccounts, type Transfer } from '../../domain/transfer.js';
import type { Clock, IdGenerator, LedgerRepository, LedgerTransaction } from '../ports.js';

export interface TransferFundsCommand {
  readonly idempotencyKey: string;
  readonly sourceAccountId: AccountId;
  readonly destinationAccountId: AccountId;
  readonly amount: bigint;
  readonly fxRate: string | null;
  readonly description: string | null;
}

export interface TransferFundsResult {
  readonly transfer: Transfer;
  /** True when the response is the stored result of an earlier request with the same idempotency key. */
  readonly replayed: boolean;
}

export class TransferFunds {
  constructor(
    private readonly repository: LedgerRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: TransferFundsCommand): Promise<TransferFundsResult> {
    const fxRate = command.fxRate === null ? null : parseFxRate(command.fxRate);
    const requestHash = hashRequest(command, fxRate);
    const transferId = this.ids.next();

    return this.repository.transaction(async (tx) => {
      const claim = await tx.claimIdempotencyKey(command.idempotencyKey, requestHash, transferId);
      if (claim.status === 'existing') {
        return {
          transfer: await this.replay(tx, command.idempotencyKey, claim, requestHash),
          replayed: true,
        };
      }

      const { source, destination } = await this.lockParticipants(tx, command);
      const createdAt = this.clock.now();
      const fxClearing =
        fxRate !== null && requiresFx(source, destination)
          ? await this.fxClearingAccounts(tx, source, destination, createdAt)
          : null;

      const transfer = planTransfer({
        id: transferId,
        source,
        destination,
        sourceBalance: await tx.getBalance(source.id),
        amount: command.amount,
        fxRate,
        fxClearing,
        description: command.description,
        createdAt,
      });
      await tx.saveTransfer(transfer);
      return { transfer, replayed: false };
    });
  }

  private async replay(
    tx: LedgerTransaction,
    key: string,
    claim: { requestHash: string; transferId: string },
    requestHash: string,
  ): Promise<Transfer> {
    if (claim.requestHash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency-Key was already used with a different request payload',
      );
    }
    const original = await tx.findTransfer(claim.transferId);
    if (!original) {
      throw new Error(`Idempotency key ${key} references missing transfer ${claim.transferId}`);
    }
    return original;
  }

  private async lockParticipants(
    tx: LedgerTransaction,
    command: TransferFundsCommand,
  ): Promise<{ source: Account; destination: Account }> {
    const locked = await tx.lockAccounts([command.sourceAccountId, command.destinationAccountId]);
    const byId = new Map(locked.map((account) => [account.id, account]));
    const source = this.requireTransferable(byId.get(command.sourceAccountId), command.sourceAccountId);
    const destination = this.requireTransferable(
      byId.get(command.destinationAccountId),
      command.destinationAccountId,
    );
    return { source, destination };
  }

  private requireTransferable(account: Account | undefined, accountId: AccountId): Account {
    if (!account) {
      throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${accountId} not found`, { accountId });
    }
    if (account.systemRole !== null) {
      throw new DomainError('INVALID_ACCOUNT', 'System accounts cannot be used in transfers', { accountId });
    }
    return account;
  }

  private async fxClearingAccounts(
    tx: LedgerTransaction,
    source: Account,
    destination: Account,
    createdAt: Date,
  ): Promise<FxClearingAccounts> {
    return {
      source: await tx.ensureFxClearingAccount(
        openFxClearingAccount(this.ids.next(), source.currency, createdAt),
      ),
      destination: await tx.ensureFxClearingAccount(
        openFxClearingAccount(this.ids.next(), destination.currency, createdAt),
      ),
    };
  }
}

function hashRequest(command: TransferFundsCommand, fxRate: FxRate | null): string {
  const canonical = JSON.stringify([
    command.sourceAccountId,
    command.destinationAccountId,
    command.amount.toString(),
    fxRate === null ? null : formatFxRate(fxRate),
    command.description,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
