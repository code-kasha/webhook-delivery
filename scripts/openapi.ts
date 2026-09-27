import { readFile, writeFile } from 'node:fs/promises';
import { openapi } from '../src/contract.js';
const file = new URL('../openapi.json', import.meta.url);
const generated = JSON.stringify(openapi(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8')) !== generated)
    throw new Error('openapi.json is stale; run pnpm openapi');
} else await writeFile(file, generated);
