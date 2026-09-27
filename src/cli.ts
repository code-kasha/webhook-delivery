import { z } from 'zod';
import { createPool, migrate } from './db.js';
import { createKey } from './service.js';
const pool = createPool(z.string().min(1).parse(process.env.DATABASE_URL));
try {
  if (process.argv[2] === 'migrate') {
    await migrate(pool);
    console.log('Migrations applied');
  } else if (process.argv[2] === 'key') {
    const scope = z
      .enum(['admin', 'publish'])
      .parse(process.argv[3] ?? 'admin');
    console.log(
      JSON.stringify(await createKey(pool, 'CLI bootstrap', scope), null, 2),
    );
  } else throw new Error('Usage: cli migrate | key [admin|publish]');
} finally {
  await pool.end();
}
