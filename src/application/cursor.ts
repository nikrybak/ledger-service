import { DomainError } from '../domain/errors.js';

const CURSOR_PATTERN = /^seq:(\d{1,19})$/;

/** Cursors are opaque to clients so the pagination key can change without breaking the API. */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(`seq:${seq.toString()}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): bigint {
  const match = CURSOR_PATTERN.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match?.[1]) {
    throw new DomainError('INVALID_CURSOR', 'Cursor is malformed');
  }
  return BigInt(match[1]);
}
