import type { Account, AccountId } from '../domain/account.js';
import type { Posting } from '../domain/journal.js';
import type { Transfer, TransferId } from '../domain/transfer.js';

export interface PostingPage {
  readonly limit: number;
  /** Return postings strictly older than this sequence; `null` starts from the newest. */
  readonly beforeSeq: bigint | null;
}

export type IdempotencyClaim =
  | { readonly status: 'claimed' }
  | { readonly status: 'existing'; readonly requestHash: string; readonly transferId: TransferId };

/** Operations that must run inside a single atomic, isolated unit of work. */
export interface LedgerTransaction {
  /**
   * Locks the given accounts until the transaction ends and returns those that exist.
   * Implementations must lock in a deterministic order so concurrent transfers cannot deadlock.
   */
  lockAccounts(ids: readonly AccountId[]): Promise<Account[]>;
  getBalance(accountId: AccountId): Promise<bigint>;
  /** Returns the FX clearing account for `candidate.currency`, persisting `candidate` if none exists yet. */
  ensureFxClearingAccount(candidate: Account): Promise<Account>;
  /**
   * Reserves the key for `transferId`, or reports the request that already owns it.
   * Must block while another in-flight transaction holds the same key.
   */
  claimIdempotencyKey(key: string, requestHash: string, transferId: TransferId): Promise<IdempotencyClaim>;
  saveTransfer(transfer: Transfer): Promise<void>;
  findTransfer(id: TransferId): Promise<Transfer | null>;
}

export interface LedgerRepository {
  saveAccount(account: Account): Promise<void>;
  findAccount(id: AccountId): Promise<Account | null>;
  getBalance(accountId: AccountId): Promise<bigint>;
  /** Postings of one account, newest first. */
  listPostings(accountId: AccountId, page: PostingPage): Promise<Posting[]>;
  /** Runs `work` atomically; any thrown error rolls back every write made through `tx`. */
  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
