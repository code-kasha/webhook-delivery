import { createServer } from 'node:http';
import { verify } from '../src/verify.js';
const secret = process.env.WEBHOOK_SECRET;
if (!secret)
  throw new Error('Set WEBHOOK_SECRET to the endpoint signing secret');
// Demo deduplication only. Real applications must atomically store event IDs and business changes in their database.
const seen = new Set<string>();
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 262144) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const timestamp = req.headers['webhook-timestamp'];
  const signature = req.headers['webhook-signature'];
  if (
    typeof timestamp !== 'string' ||
    typeof signature !== 'string' ||
    !verify(body, timestamp, signature, [secret])
  ) {
    res.writeHead(401).end();
    return;
  }
  try {
    const event = JSON.parse(body.toString()) as { id: string; type: string };
    if (typeof event.id !== 'string') throw new Error('Invalid event');
    if (!seen.has(event.id)) {
      seen.add(event.id);
      console.log({ id: event.id, type: event.type });
    }
    res.writeHead(204).end();
  } catch {
    res.writeHead(400).end();
  }
}).listen(4000, '127.0.0.1', () =>
  console.log('Fictional receiver listening on http://127.0.0.1:4000'),
);
