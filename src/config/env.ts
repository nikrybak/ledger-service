import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    STORAGE: z.enum(['memory', 'postgres']).default('memory'),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE === 'postgres' && !env.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'Required when STORAGE=postgres',
      });
    }
  });

export type StorageConfig =
  | { readonly kind: 'memory' }
  | { readonly kind: 'postgres'; readonly url: string; readonly poolSize: number };

export interface Config {
  readonly env: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly storage: StorageConfig;
  readonly shutdownTimeoutMs: number;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    storage:
      env.STORAGE === 'postgres' && env.DATABASE_URL
        ? { kind: 'postgres', url: env.DATABASE_URL, poolSize: env.DATABASE_POOL_SIZE }
        : { kind: 'memory' },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
