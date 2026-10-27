import type {
  IdempotencyClaim,
  LedgerRepository,
  LedgerTransaction,
  PostingPage,
} from '../../../application/ports.js';
import type { Account, AccountId } from '../../../domain/account.js';
import type { JournalLine, Posting } from '../../../domain/journal.js';
import { sumBalance } from '../../../domain/journal.js';
import type { Transfer, TransferId } from '../../../domain/transfer.js';

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly transferId: TransferId;
}

/** Serialises async critical sections; the in-memory equivalent of a database lock. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Reference adapter for tests and local development. Transactions are fully serialised and
 * buffer their writes, which are applied only after `work` resolves, so a failure leaves no trace.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly accounts = new Map<AccountId, Account>();
  private readonly transfers = new Map<TransferId, Transfer>();
  private readonly postingsByAccount = new Map<AccountId, Posting[]>();
  private readonly idempotencyKeys = new Map<string, IdempotencyRecord>();
  private readonly mutex = new Mutex();
  private lastSeq = 0n;

  saveAccount(account: Account): Promise<void> {
    this.accounts.set(account.id, account);
    return Promise.resolve();
  }

  findAccount(id: AccountId): Promise<Account | null> {
    return Promise.resolve(this.accounts.get(id) ?? null);
  }

  getBalance(accountId: AccountId): Promise<bigint> {
    return Promise.resolve(sumBalance(this.postingsByAccount.get(accountId) ?? []));
  }

  listPostings(accountId: AccountId, page: PostingPage): Promise<Posting[]> {
    const postings = this.postingsByAccount.get(accountId) ?? [];
    const result: Posting[] = [];
    for (let i = postings.length - 1; i >= 0 && result.length < page.limit; i--) {
      const posting = postings[i];
      if (posting && (page.beforeSeq === null || posting.seq < page.beforeSeq)) result.push(posting);
    }
    return Promise.resolve(result);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const tx = new InMemoryTransaction(
        this.accounts,
        this.transfers,
        this.postingsByAccount,
        this.idempotencyKeys,
      );
      const result = await work(tx);
      this.commit(tx);
      return result;
    });
  }

  private commit(tx: InMemoryTransaction): void {
    for (const account of tx.stagedAccounts.values()) this.accounts.set(account.id, account);
    for (const [key, record] of tx.stagedKeys) this.idempotencyKeys.set(key, record);
    for (const transfer of tx.stagedTransfers.values()) {
      this.transfers.set(transfer.id, transfer);
      for (const line of transfer.lines) this.appendPosting(transfer, line);
    }
  }

  private appendPosting(transfer: Transfer, line: JournalLine): void {
    this.lastSeq += 1n;
    const posting: Posting = {
      ...line,
      seq: this.lastSeq,
      transferId: transfer.id,
      createdAt: transfer.createdAt,
    };
    const postings = this.postingsByAccount.get(line.accountId);
    if (postings) postings.push(posting);
    else this.postingsByAccount.set(line.accountId, [posting]);
  }
}

class InMemoryTransaction implements LedgerTransaction {
  readonly stagedAccounts = new Map<AccountId, Account>();
  readonly stagedTransfers = new Map<TransferId, Transfer>();
  readonly stagedKeys = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly accounts: ReadonlyMap<AccountId, Account>,
    private readonly transfers: ReadonlyMap<TransferId, Transfer>,
    private readonly postingsByAccount: ReadonlyMap<AccountId, readonly Posting[]>,
    private readonly idempotencyKeys: ReadonlyMap<string, IdempotencyRecord>,
  ) {}

  lockAccounts(ids: readonly AccountId[]): Promise<Account[]> {
    const found = ids.map((id) => this.stagedAccounts.get(id) ?? this.accounts.get(id));
    return Promise.resolve(found.filter((account): account is Account => account !== undefined));
  }

  getBalance(accountId: AccountId): Promise<bigint> {
    const staged = [...this.stagedTransfers.values()].flatMap((t) =>
      t.lines.filter((line) => line.accountId === accountId),
    );
    const committed = this.postingsByAccount.get(accountId) ?? [];
    return Promise.resolve(sumBalance(committed) + sumBalance(staged));
  }

  ensureFxClearingAccount(candidate: Account): Promise<Account> {
    const isMatch = (account: Account) =>
      account.systemRole === 'fx_clearing' && account.currency === candidate.currency;
    const existing = [...this.accounts.values(), ...this.stagedAccounts.values()].find(isMatch);
    if (existing) return Promise.resolve(existing);
    this.stagedAccounts.set(candidate.id, candidate);
    return Promise.resolve(candidate);
  }

  claimIdempotencyKey(key: string, requestHash: string, transferId: TransferId): Promise<IdempotencyClaim> {
    const existing = this.stagedKeys.get(key) ?? this.idempotencyKeys.get(key);
    if (existing) return Promise.resolve({ status: 'existing', ...existing });
    this.stagedKeys.set(key, { requestHash, transferId });
    return Promise.resolve({ status: 'claimed' });
  }

  saveTransfer(transfer: Transfer): Promise<void> {
    this.stagedTransfers.set(transfer.id, transfer);
    return Promise.resolve();
  }

  findTransfer(id: TransferId): Promise<Transfer | null> {
    return Promise.resolve(this.stagedTransfers.get(id) ?? this.transfers.get(id) ?? null);
  }
}
