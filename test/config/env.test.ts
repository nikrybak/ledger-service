import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('defaults to in-memory storage', () => {
    expect(loadConfig({})).toMatchObject({ port: 3000, storage: { kind: 'memory' } });
  });

  it('requires DATABASE_URL for postgres storage', () => {
    expect(() => loadConfig({ STORAGE: 'postgres' })).toThrow(/DATABASE_URL/);
  });

  it('parses postgres settings', () => {
    const config = loadConfig({
      STORAGE: 'postgres',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DATABASE_POOL_SIZE: '4',
      PORT: '8080',
    });
    expect(config.storage).toEqual({
      kind: 'postgres',
      url: 'postgres://u:p@localhost:5432/db',
      poolSize: 4,
    });
    expect(config.port).toBe(8080);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
  });
});
