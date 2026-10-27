import { randomUUID } from 'node:crypto';

import type { Clock, IdGenerator } from '../application/ports.js';

export const systemClock: Clock = { now: () => new Date() };

export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
