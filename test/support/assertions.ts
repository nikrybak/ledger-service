import { expect } from 'vitest';

import { DomainError, type DomainErrorCode } from '../../src/domain/errors.js';

export function expectDomainError(action: () => unknown, code: DomainErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

export async function expectDomainErrorAsync(
  promise: Promise<unknown>,
  code: DomainErrorCode,
): Promise<void> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}
