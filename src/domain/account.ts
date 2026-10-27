import { DomainError } from './errors.js';
import { parseCurrency, type Currency } from './money.js';

export type AccountId = string;

/**
 * `fx_clearing` accounts are internal: one per currency, they absorb both legs of a
 * cross-currency transfer so that every journal entry still balances within each currency.
 */
export type SystemRole = 'fx_clearing';

export interface Account {
  readonly id: AccountId;
  readonly name: string;
  readonly currency: Currency;
  readonly allowNegativeBalance: boolean;
  readonly systemRole: SystemRole | null;
  readonly createdAt: Date;
}

export interface NewAccountProps {
  readonly id: AccountId;
  readonly name: string;
  readonly currency: string;
  readonly allowNegativeBalance?: boolean;
  readonly createdAt: Date;
}

const MAX_NAME_LENGTH = 200;

export function openAccount(props: NewAccountProps): Account {
  const name = props.name.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new DomainError('INVALID_ACCOUNT', `Account name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return {
    id: props.id,
    name,
    currency: parseCurrency(props.currency),
    allowNegativeBalance: props.allowNegativeBalance ?? false,
    systemRole: null,
    createdAt: props.createdAt,
  };
}

export function openFxClearingAccount(id: AccountId, currency: Currency, createdAt: Date): Account {
  return {
    id,
    name: `FX clearing ${currency}`,
    currency,
    allowNegativeBalance: true,
    systemRole: 'fx_clearing',
    createdAt,
  };
}
