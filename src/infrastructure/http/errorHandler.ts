import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { isDomainError, type DomainErrorCode } from '../../domain/errors.js';

/** The single place where domain failures become HTTP statuses. `Record` makes the mapping exhaustive. */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  INVALID_AMOUNT: 422,
  INVALID_CURRENCY: 422,
  INVALID_FX_RATE: 422,
  INVALID_ACCOUNT: 422,
  CURRENCY_MISMATCH: 422,
  SAME_ACCOUNT_TRANSFER: 422,
  INSUFFICIENT_FUNDS: 422,
  ACCOUNT_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  INVALID_CURSOR: 400,
  // Only reachable through a programming error: the use cases never build unbalanced entries.
  UNBALANCED_ENTRY: 500,
};

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof ZodError) {
    return reply.code(400).send(body('VALIDATION_ERROR', 'Request validation failed', issues(error)));
  }

  if (isDomainError(error)) {
    const status = STATUS_BY_CODE[error.code];
    if (status >= 500) request.log.error({ err: error }, 'domain invariant violated');
    return reply.code(status).send(body(error.code, error.message, error.details));
  }

  if (isClientFastifyError(error)) {
    return reply.code(error.statusCode).send(body(error.code, error.message));
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send(body('INTERNAL_ERROR', 'Internal server error'));
}

function isClientFastifyError(error: unknown): error is FastifyError & { statusCode: number } {
  const statusCode = (error as Partial<FastifyError> | null)?.statusCode;
  return error instanceof Error && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

function issues(error: ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}
