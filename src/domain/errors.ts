export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_FX_RATE'
  | 'INVALID_ACCOUNT'
  | 'CURRENCY_MISMATCH'
  | 'SAME_ACCOUNT_TRANSFER'
  | 'INSUFFICIENT_FUNDS'
  | 'UNBALANCED_ENTRY'
  | 'ACCOUNT_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'INVALID_CURSOR';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
