import { DomainError } from './errors.js';

/**
 * Exchange rate as an exact decimal: `numerator / 10^scale`.
 * Parsed from a string so that no binary floating point is ever involved in money math.
 */
export interface FxRate {
  readonly numerator: bigint;
  readonly scale: number;
}

const RATE_PATTERN = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

export function parseFxRate(value: string): FxRate {
  const match = RATE_PATTERN.exec(value);
  if (!match) {
    throw new DomainError(
      'INVALID_FX_RATE',
      'fxRate must be a positive decimal string with up to 12 fractional digits',
    );
  }
  const integerPart = match[1] ?? '0';
  // Trailing zeros are dropped so that "1.50" and "1.5" are the same rate (matters for idempotency hashing).
  const fractionPart = (match[2] ?? '').replace(/0+$/, '');
  const numerator = BigInt(integerPart + fractionPart);
  if (numerator === 0n) {
    throw new DomainError('INVALID_FX_RATE', 'fxRate must be greater than zero');
  }
  return { numerator, scale: fractionPart.length };
}

export function formatFxRate(rate: FxRate): string {
  const digits = rate.numerator.toString().padStart(rate.scale + 1, '0');
  if (rate.scale === 0) return digits;
  return `${digits.slice(0, -rate.scale)}.${digits.slice(-rate.scale)}`;
}

/** Converts a positive amount, rounding half up to the nearest minor unit. */
export function convertAmount(amount: bigint, rate: FxRate): bigint {
  const denominator = 10n ** BigInt(rate.scale);
  return (amount * rate.numerator * 2n + denominator) / (2n * denominator);
}
