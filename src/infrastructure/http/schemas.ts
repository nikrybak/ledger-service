import { z } from 'zod';

/**
 * Amounts are integer minor units. Strings are the canonical form because JSON numbers lose
 * precision above 2^53 in most clients; small safe integers are accepted for convenience.
 */
const amountSchema = z
  .union([
    z.string().regex(/^\d{1,19}$/, 'Must be a string of digits (minor units)'),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => BigInt(value));

export const createAccountBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code such as "USD"'),
    allowNegativeBalance: z.boolean().default(false),
  })
  .strict();

export const transferBody = z
  .object({
    sourceAccountId: z.string().uuid(),
    destinationAccountId: z.string().uuid(),
    amount: amountSchema,
    fxRate: z.string().max(32).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const idempotencyKeyHeader = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .trim()
  .min(1, 'Idempotency-Key header is required')
  .max(255);

export const accountParams = z.object({ id: z.string().uuid() });

export const entriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
