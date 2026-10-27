import { describe, expect, it } from 'vitest';

import { expectDomainError } from '../support/assertions.js';
import { convertAmount, formatFxRate, parseFxRate } from '../../src/domain/fxRate.js';

describe('parseFxRate', () => {
  it('parses decimal strings exactly', () => {
    expect(parseFxRate('0.92')).toEqual({ numerator: 92n, scale: 2 });
    expect(parseFxRate('3')).toEqual({ numerator: 3n, scale: 0 });
  });

  it('normalises trailing zeros so equal rates compare equal', () => {
    expect(parseFxRate('1.50')).toEqual(parseFxRate('1.5'));
    expect(formatFxRate(parseFxRate('1.500'))).toBe('1.5');
    expect(formatFxRate(parseFxRate('0.0035'))).toBe('0.0035');
  });

  it.each(['0', '0.000', '-1', '1e3', '1.', '.5', 'abc', '1.1234567890123'])('rejects "%s"', (value) => {
    expectDomainError(() => parseFxRate(value), 'INVALID_FX_RATE');
  });
});

describe('convertAmount', () => {
  it('multiplies by the rate', () => {
    expect(convertAmount(10_000n, parseFxRate('0.92'))).toBe(9_200n);
  });

  it('rounds half up to the nearest minor unit', () => {
    expect(convertAmount(1n, parseFxRate('0.5'))).toBe(1n);
    expect(convertAmount(1n, parseFxRate('0.49'))).toBe(0n);
    expect(convertAmount(333n, parseFxRate('1.005'))).toBe(335n);
  });

  it('stays exact for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    expect(convertAmount(9_007_199_254_740_993n, parseFxRate('2'))).toBe(18_014_398_509_481_986n);
  });
});
