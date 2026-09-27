// Runs one real delivery worker process so a test can terminate it with SIGKILL.
import type { FastifyBaseLogger } from 'fastify';
import { readConfig } from '../../src/config.js';
import { createPool } from '../../src/db.js';
import { Worker } from '../../src/worker.js';

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => {});
const quiet = () => {};
const logger = { info: quiet, warn: quiet, error: quiet };
new Worker(pool, config, logger as unknown as FastifyBaseLogger).start(1);
