import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createPool, migrate, transaction, type Pool } from '../src/db.js';
import { readConfig, policy } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createKey, Service } from '../src/service.js';
import { claim, finish, Worker, type Job } from '../src/worker.js';
import { verify } from '../src/verify.js';
import { decrypt } from '../src/crypto.js';

const schema = `test_${randomUUID().replaceAll('-', '')}`;
const base =
  process.env.TEST_DATABASE_URL ??
  'postgresql://webhook:webhook@localhost:55432/webhook';
let root: Pool;
let pool: Pool;
let app: ReturnType<typeof createApp>['app'];
let service: Service;
let admin: string;
let actor: string;
let publisher: string;
const config = readConfig({
  DATABASE_URL: base,
  SECRET_ENCRYPTION_KEY: 'ab'.repeat(32),
  ALLOW_PRIVATE_DESTINATIONS: 'true',
  LOG_LEVEL: 'silent',
});
beforeAll(async () => {
  root = createPool(base);
  await root.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  pool = createPool(url.toString());
  await migrate(pool);
  await migrate(pool);
  app = createApp(pool, config).app;
  service = new Service(pool, config);
  await app.ready();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE attempts,deliveries,events,endpoints,api_keys,audit_log RESTART IDENTITY CASCADE',
  );
  const key = await createKey(pool, 'Fictional administrator', 'admin');
  admin = key.token;
  actor = key.id;
  publisher = (await createKey(pool, 'Fictional CRM', 'publish')).token;
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (root) {
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
  }
});
const headers = (token = admin) => ({ authorization: `Bearer ${token}` });
const endpoint = () =>
  service.createEndpoint(
    { url: 'http://127.0.0.1:4000', event_types: ['lead.created'] },
    actor,
  );
const publish = (key: string = randomUUID()) =>
  service.publish(
    key,
    { type: 'lead.created', data: { name: 'Fictional customer' } },
    actor,
  );
const failure = {
  ok: false,
  code: 503,
  duration: 12,
  body: 'unavailable',
  error: 'http_status',
};
const success = { ok: true, code: 204, duration: 5, body: '', error: null };
async function getJob() {
  const job = await claim(pool);
  expect(job).not.toBeNull();
  return job!;
}
async function due() {
  await pool.query(
    "UPDATE deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
  );
}

describe('authenticated API contract', () => {
  it('checks liveness, readiness, docs and committed contract route', async () => {
    for (const path of [
      '/health',
      '/ready',
      '/docs',
      '/openapi.json',
      '/docs/swagger-ui.css',
    ])
      expect((await app.inject({ url: path })).statusCode).toBe(200);
  });
  it('rejects missing keys, limits publish keys and revokes immediately', async () => {
    expect((await app.inject({ url: '/api/v1/endpoints' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url: '/api/v1/endpoints',
          headers: headers(publisher),
        })
      ).statusCode,
    ).toBe(403);
    const key = await createKey(pool, 'Temporary fictional key', 'publish');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/keys/${key.id}`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/events',
          headers: { ...headers(key.token), 'idempotency-key': 'a' },
          payload: { type: 'lead.created', data: {} },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('requires an idempotency key, validates strict bodies and bounds requests', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/events',
          headers: headers(),
          payload: { type: 'lead.created', data: {} },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/endpoints',
          headers: headers(),
          payload: {
            url: 'https://example.com',
            event_types: ['x'],
            secret: 'injected',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/events',
          headers: { ...headers(), 'idempotency-key': 'large' },
          payload: { type: 'x', data: { text: 'x'.repeat(300000) } },
        })
      ).statusCode,
    ).toBe(413);
  });
  it('never returns signing ciphertext, key hashes or lease tokens in list APIs', async () => {
    const ep = await endpoint();
    await publish();
    await getJob();
    const endpoints = (
      await app.inject({ url: '/api/v1/endpoints', headers: headers() })
    ).json();
    expect(endpoints[0].id).toBe(ep.id);
    expect(endpoints[0]).not.toHaveProperty('secret');
    expect(
      (await app.inject({ url: '/api/v1/keys', headers: headers() })).body,
    ).not.toContain('key_hash');
    expect(
      (await app.inject({ url: '/api/v1/deliveries', headers: headers() }))
        .body,
    ).not.toContain('lease_token');
  });
  it('records endpoint changes and returns a one-time secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/endpoints',
      headers: headers(),
      payload: {
        url: 'http://127.0.0.1:4000/hook',
        event_types: ['lead.created'],
      },
    });
    expect(response.statusCode).toBe(201);
    const ep = response.json();
    expect(ep.secret).toHaveLength(64);
    const encrypted = (
      await pool.query('SELECT secret FROM endpoints WHERE id=$1', [ep.id])
    ).rows[0].secret;
    expect(encrypted).not.toBe(ep.secret);
    expect(decrypt(encrypted, config.SECRET_ENCRYPTION_KEY)).toBe(ep.secret);
    expect(
      (
        await pool.query(
          "SELECT * FROM audit_log WHERE action='endpoint.created' AND target_id=$1",
          [ep.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('queries attempts per event and endpoint', async () => {
    const ep = await endpoint();
    const ev = await publish();
    await finish(pool, await getJob(), failure);
    const response = await app.inject({
      url: `/api/v1/attempts?event_id=${ev.id}&endpoint_id=${ep.id}`,
      headers: headers(),
    });
    expect(response.json()).toMatchObject([
      {
        status: 'failed',
        response_code: 503,
        duration_ms: 12,
        response_body: 'unavailable',
      },
    ]);
    expect(
      (
        await app.inject({
          url: `/api/v1/attempts?event_id=${randomUUID()}`,
          headers: headers(),
        })
      ).json(),
    ).toEqual([]);
  });
});
describe('transactional fan-out and idempotency', () => {
  it('stores concurrent retries once and rejects conflicting payloads', async () => {
    await endpoint();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => publish('same-key')),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((await pool.query('SELECT * FROM deliveries')).rowCount).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT * FROM audit_log WHERE action='event.published'",
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      service.publish(
        'same-key',
        { type: 'lead.created', data: { different: true } },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('ignores JSON object key ordering for a retried publish', async () => {
    await service.publish('same', { type: 'x', data: { a: 1, b: 2 } }, actor);
    expect(
      (
        await service.publish(
          'same',
          { type: 'x', data: { b: 2, a: 1 } },
          actor,
        )
      ).duplicate,
    ).toBe(true);
  });
  it('fans out to matching subscriptions including disabled ones', async () => {
    const first = await endpoint();
    const second = await endpoint();
    await service.updateEndpoint(second.id, { enabled: false }, actor);
    await service.createEndpoint(
      { url: 'http://127.0.0.1:4000', event_types: ['other'] },
      actor,
    );
    await publish();
    const deliveries = (await pool.query('SELECT endpoint_id FROM deliveries'))
      .rows;
    expect(deliveries.map((d) => d.endpoint_id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
  it('rolls back the event and deliveries when the audit write fails', async () => {
    await endpoint();
    await pool.query(
      "ALTER TABLE audit_log ADD CONSTRAINT reject_publish CHECK (action <> 'event.published')",
    );
    try {
      await expect(publish()).rejects.toThrow();
      expect((await pool.query('SELECT * FROM events')).rowCount).toBe(0);
      expect((await pool.query('SELECT * FROM deliveries')).rowCount).toBe(0);
    } finally {
      await pool.query('ALTER TABLE audit_log DROP CONSTRAINT reject_publish');
    }
  });
});
describe('PostgreSQL queue ownership and recovery', () => {
  it('allows one claim per endpoint while other endpoints progress', async () => {
    const ep1 = await endpoint();
    const ep2 = await endpoint();
    await publish();
    await publish();
    const jobs = (
      await Promise.all(Array.from({ length: 8 }, () => claim(pool)))
    ).filter((j): j is Job => j !== null);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.endpoint_id))).toEqual(
      new Set([ep1.id, ep2.id]),
    );
    expect((await pool.query('SELECT * FROM attempts')).rowCount).toBe(2);
  });
  it('skips a locked endpoint instead of blocking another consumer', async () => {
    const ep1 = await endpoint();
    await endpoint();
    await publish();
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM endpoints WHERE id=$1 FOR UPDATE', [
      ep1.id,
    ]);
    try {
      const job = await getJob();
      expect(job.endpoint_id).not.toBe(ep1.id);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('recovers expired claims and fences late completion', async () => {
    await endpoint();
    await publish();
    const old = await getJob();
    await pool.query(
      "UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    const fresh = await getJob();
    expect(fresh.id).toBe(old.id);
    expect(fresh.lease_token).not.toBe(old.lease_token);
    expect(await finish(pool, old, success)).toBe(false);
    expect(await finish(pool, fresh, success)).toBe(true);
    expect(
      (await pool.query('SELECT status FROM attempts ORDER BY number')).rows,
    ).toEqual([{ status: 'unknown' }, { status: 'succeeded' }]);
  });
  it('pauses after consecutive failures and retains new events until re-enabled', async () => {
    const ep = await endpoint();
    await publish();
    for (let i = 0; i < policy.pauseAfter; i++) {
      await due();
      await finish(pool, await getJob(), failure);
    }
    expect(
      (await pool.query('SELECT paused FROM endpoints WHERE id=$1', [ep.id]))
        .rows[0].paused,
    ).toBe(true);
    await publish();
    expect(await claim(pool)).toBeNull();
    expect((await pool.query('SELECT * FROM deliveries')).rowCount).toBe(2);
    await service.updateEndpoint(ep.id, { enabled: true }, actor);
    await due();
    expect(await claim(pool)).not.toBeNull();
  });
  it('resets consecutive failures after a successful delivery', async () => {
    const ep = await endpoint();
    await publish();
    await finish(pool, await getJob(), failure);
    await due();
    await finish(pool, await getJob(), success);
    expect(
      (
        await pool.query(
          'SELECT consecutive_failures FROM endpoints WHERE id=$1',
          [ep.id],
        )
      ).rows[0].consecutive_failures,
    ).toBe(0);
  });
  it('exhausts the retry budget and replays with history preserved', async () => {
    const ep = await endpoint();
    await publish();
    let id = '';
    for (let i = 0; i < policy.maxAttempts; i++) {
      await service.updateEndpoint(ep.id, { enabled: true }, actor);
      await due();
      const job = await getJob();
      id = job.id;
      await finish(pool, job, failure);
    }
    expect(
      (await pool.query('SELECT status FROM deliveries WHERE id=$1', [id]))
        .rows[0].status,
    ).toBe('failed');
    await service.replay(id, actor);
    const job = await getJob();
    expect(job.attempt_count).toBe(9);
    expect(job.cycle_attempts).toBe(1);
    await finish(pool, job, success);
    expect((await pool.query('SELECT * FROM attempts')).rowCount).toBe(9);
    await expect(service.replay(id, actor)).rejects.toMatchObject({
      status: 409,
    });
  });
  it('rolls back completion and its log together when audit fails', async () => {
    await endpoint();
    await publish();
    const job = await getJob();
    await pool.query(
      "ALTER TABLE audit_log ADD CONSTRAINT reject_finish CHECK (action <> 'delivery.succeeded')",
    );
    try {
      await expect(finish(pool, job, success)).rejects.toThrow();
      expect(
        (await pool.query('SELECT status FROM deliveries')).rows[0].status,
      ).toBe('in_flight');
      expect(
        (await pool.query('SELECT status FROM attempts')).rows[0].status,
      ).toBe('started');
    } finally {
      await pool.query('ALTER TABLE audit_log DROP CONSTRAINT reject_finish');
    }
  });
});
describe('rotation and actual receiver delivery', () => {
  it('signs with both secrets during overlap and only the new secret after expiry', async () => {
    const ep = await endpoint();
    const rotated = await service.rotate(ep.id, actor);
    expect(
      new Date(rotated.previous_expires_at).getTime() - Date.now(),
    ).toBeGreaterThan(86300000);
    await expect(service.rotate(ep.id, actor)).rejects.toMatchObject({
      status: 409,
    });
    const signatures: { timestamp: string; signature: string; body: Buffer }[] =
      [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      signatures.push({
        body: Buffer.concat(chunks),
        timestamp: String(req.headers['webhook-timestamp']),
        signature: String(req.headers['webhook-signature']),
      });
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Missing port');
    try {
      await service.updateEndpoint(
        ep.id,
        { url: `http://127.0.0.1:${addr.port}` },
        actor,
      );
      const worker = new Worker(pool, config, app.log);
      await publish();
      expect(await worker.once()).toBe(true);
      const first = signatures[0]!;
      expect(
        verify(first.body, first.timestamp, first.signature, [ep.secret]),
      ).toBe(true);
      expect(
        verify(first.body, first.timestamp, first.signature, [rotated.secret]),
      ).toBe(true);
      await pool.query(
        "UPDATE endpoints SET previous_expires_at=now()-interval '1 second' WHERE id=$1",
        [ep.id],
      );
      await publish();
      await worker.once();
      const second = signatures[1]!;
      expect(
        verify(second.body, second.timestamp, second.signature, [ep.secret]),
      ).toBe(false);
      expect(
        verify(second.body, second.timestamp, second.signature, [
          rotated.secret,
        ]),
      ).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it('does not lose the in-flight result during graceful worker shutdown', async () => {
    let received!: () => void;
    const arrived = new Promise<void>((r) => {
      received = r;
    });
    let release!: () => void;
    const server = createServer((_req, res) => {
      release = () => res.writeHead(204).end();
      received();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Missing port');
    const ep = await endpoint();
    await service.updateEndpoint(
      ep.id,
      { url: `http://127.0.0.1:${addr.port}` },
      actor,
    );
    await publish();
    const worker = new Worker(pool, config, app.log);
    worker.start(1);
    await arrived;
    const stopping = worker.stop();
    release();
    await stopping;
    expect(
      (await pool.query('SELECT status FROM deliveries')).rows[0].status,
    ).toBe('succeeded');
    await new Promise<void>((r) => server.close(() => r()));
  });
});
it('transaction helper rolls back arbitrary state changes', async () => {
  await expect(
    transaction(pool, async (c) => {
      await c.query("UPDATE api_keys SET name='changed'");
      throw new Error('Abort');
    }),
  ).rejects.toThrow('Abort');
  expect(
    (await pool.query("SELECT * FROM api_keys WHERE name='changed'")).rowCount,
  ).toBe(0);
});
