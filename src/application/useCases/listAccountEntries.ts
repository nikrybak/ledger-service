import type { AccountId } from '../../domain/account.js';
import { DomainError } from '../../domain/errors.js';
import type { Posting } from '../../domain/journal.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import type { LedgerRepository } from '../ports.js';

export interface ListAccountEntriesQuery {
  readonly accountId: AccountId;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface EntriesPage {
  readonly entries: readonly Posting[];
  readonly nextCursor: string | null;
}

export class ListAccountEntries {
  constructor(private readonly repository: LedgerRepository) {}

  async execute(query: ListAccountEntriesQuery): Promise<EntriesPage> {
    const beforeSeq = query.cursor === null ? null : decodeCursor(query.cursor);
    const account = await this.repository.findAccount(query.accountId);
    if (!account) {
      throw new DomainError('ACCOUNT_NOT_FOUND', `Account ${query.accountId} not found`, {
        accountId: query.accountId,
      });
    }

    // Fetching one extra row tells us whether another page exists without a COUNT query.
    const rows = await this.repository.listPostings(account.id, { limit: query.limit + 1, beforeSeq });
    const entries = rows.slice(0, query.limit);
    const last = entries.at(-1);
    return {
      entries,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.seq) : null,
    };
  }
}
