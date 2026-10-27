import { DomainError } from './errors.js';

/** ISO 4217 alphabetic code. Branded so a raw string cannot be passed where a validated currency is expected. */
export type Currency = string & { readonly __brand: 'Currency' };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Upper bound of a PostgreSQL `bigint`, so every amount accepted here is storable. */
export const MAX_AMOUNT = 2n ** 63n - 1n;

export function parseCurrency(value: string): Currency {
  if (!CURRENCY_PATTERN.test(value)) {
    throw new DomainError('INVALID_CURRENCY', `Currency must be a 3-letter ISO 4217 code, got "${value}"`);
  }
  return value as Currency;
}

export function assertValidAmount(amount: bigint): void {
  if (amount <= 0n) {
    throw new DomainError('INVALID_AMOUNT', 'Amount must be a positive integer number of minor units');
  }
  if (amount > MAX_AMOUNT) {
    throw new DomainError('INVALID_AMOUNT', 'Amount exceeds the supported maximum');
  }
}
