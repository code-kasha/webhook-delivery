import { readConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { Worker } from './worker.js';

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const { app, drain } = createApp(pool, config);
pool.on('error', () => app.log.error('Idle database connection failed'));
const worker = new Worker(pool, config, app.log);
await pool.query('SELECT version FROM migrations WHERE version=1').then((r) => {
  if (!r.rowCount) throw new Error('Run migrations first');
});
await app.listen({ port: config.PORT, host: config.HOST });
worker.start();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  drain();
  app.log.info('Draining API and delivery worker');
  await Promise.all([app.close(), worker.stop()]);
  await pool.end();
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
