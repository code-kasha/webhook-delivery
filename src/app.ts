import Fastify, { type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import swaggerUi from 'swagger-ui-dist';
import { z } from 'zod';
import { hash } from './crypto.js';
import { audit, transaction, type Pool } from './db.js';
import type { Config } from './config.js';
import { ApiError, Service, createKey, endpointColumns } from './service.js';
import {
  routes,
  openapi,
  eventInput,
  endpointInput,
  endpointPatch,
  filters,
  logFilters,
  pagination,
  keyInput,
  publishHeaders,
} from './contract.js';

export function createApp(pool: Pool, config: Config) {
  const app = Fastify({
    bodyLimit: 262144,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.split('?')[0],
        }),
      },
    },
  });
  const service = new Service(pool, config);
  let draining = false;
  app.addHook('onClose', async () => {
    draining = true;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Invalid request' });
    if (error instanceof ApiError)
      return reply.code(error.status).send({ error: error.message });
    const code =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status =
      typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    if (status === 500) app.log.error('Request failed');
    return reply.code(status).send({
      error: status === 500 ? 'Internal server error' : 'Invalid request',
    });
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_req, reply) => {
    try {
      if (draining) throw new Error('Draining');
      await pool
        .query('SELECT version FROM migrations WHERE version=1')
        .then((r) => {
          if (!r.rowCount) throw new Error('Missing migration');
        });
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get('/', async (_req, reply) => reply.redirect('/docs'));
  app.get('/openapi.json', async () => openapi());
  app.get('/docs', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Webhook Delivery API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>',
      ),
  );
  app.get('/docs/init.js', async (_req, reply) =>
    reply
      .type('application/javascript')
      .send(
        'SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",persistAuthorization:false});',
      ),
  );
  for (const [file, type] of [
    ['swagger-ui.css', 'text/css'],
    ['swagger-ui-bundle.js', 'application/javascript'],
  ] as const)
    app.get(`/docs/${file}`, async (_req, reply) =>
      reply
        .type(type)
        .send(await readFile(path.join(swaggerUi.getAbsoluteFSPath(), file))),
    );
  async function authorize(req: FastifyRequest, scope: string) {
    const auth = req.headers.authorization;
    if (!auth || !/^Bearer whk_[a-f0-9]{64}$/.test(auth))
      throw new ApiError(401, 'Invalid API key');
    const key = (
      await pool.query(
        'SELECT id,scope FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL',
        [hash(auth.slice(7))],
      )
    ).rows[0] as { id: string; scope: string } | undefined;
    if (!key) throw new ApiError(401, 'Invalid API key');
    if (scope === 'admin' && key.scope !== 'admin')
      throw new ApiError(403, 'Admin scope required');
    return key.id;
  }
  for (const spec of routes)
    app.route({
      method: spec.method.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: spec.path.replace('{id}', ':id'),
      handler: async (req, reply) => {
        const actor = await authorize(req, spec.scope);
        spec.body?.parse(req.body);
        spec.query?.parse(req.query);
        const id = spec.params?.parse(req.params).id;
        let result: unknown;
        switch (spec.id) {
          case 'endpointCreate':
            result = await service.createEndpoint(
              endpointInput.parse(req.body),
              actor,
            );
            break;
          case 'endpointUpdate':
            result = await service.updateEndpoint(
              id!,
              endpointPatch.parse(req.body),
              actor,
            );
            break;
          case 'endpointRotate':
            result = await service.rotate(id!, actor);
            break;
          case 'endpointGet':
            result = (
              await pool.query(
                `SELECT ${endpointColumns} FROM endpoints WHERE id=$1`,
                [id],
              )
            ).rows[0];
            if (!result) throw new ApiError(404, 'Endpoint not found');
            break;
          case 'endpointList': {
            const q = pagination.parse(req.query);
            result = (
              await pool.query(
                `SELECT ${endpointColumns} FROM endpoints ORDER BY created_at,id LIMIT $1 OFFSET $2`,
                [q.limit, q.offset],
              )
            ).rows;
            break;
          }
          case 'eventPublish':
            result = await service.publish(
              publishHeaders.parse(req.headers)['idempotency-key'],
              eventInput.parse(req.body),
              actor,
            );
            break;
          case 'eventGet': {
            const row = (
              await pool.query('SELECT body FROM events WHERE id=$1', [id])
            ).rows[0];
            if (!row) throw new ApiError(404, 'Event not found');
            result = JSON.parse(row.body);
            break;
          }
          case 'deliveryList': {
            const q = filters.parse(req.query);
            result = (
              await pool.query(
                'SELECT id,event_id,endpoint_id,status,attempt_count,cycle_attempts,next_attempt_at,created_at FROM deliveries WHERE ($1::uuid IS NULL OR endpoint_id=$1) AND ($2::uuid IS NULL OR event_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY created_at,id LIMIT $4 OFFSET $5',
                [q.endpoint_id, q.event_id, q.status, q.limit, q.offset],
              )
            ).rows;
            break;
          }
          case 'attemptList': {
            const q = logFilters.parse(req.query);
            result = (
              await pool.query(
                'SELECT a.* FROM attempts a JOIN deliveries d ON d.id=a.delivery_id WHERE ($1::uuid IS NULL OR d.endpoint_id=$1) AND ($2::uuid IS NULL OR d.event_id=$2) ORDER BY a.started_at,a.id LIMIT $3 OFFSET $4',
                [q.endpoint_id, q.event_id, q.limit, q.offset],
              )
            ).rows;
            break;
          }
          case 'deliveryReplay': {
            const row = await service.replay(id!, actor);
            const publicRow = { ...row };
            delete publicRow.lease_token;
            delete publicRow.lease_until;
            result = publicRow;
            break;
          }
          case 'keyCreate': {
            const input = keyInput.parse(req.body);
            result = await createKey(pool, input.name, input.scope, actor);
            break;
          }
          case 'keyList': {
            const q = pagination.parse(req.query);
            result = (
              await pool.query(
                'SELECT id,name,scope,created_at,revoked_at FROM api_keys ORDER BY created_at,id LIMIT $1 OFFSET $2',
                [q.limit, q.offset],
              )
            ).rows;
            break;
          }
          case 'keyRevoke':
            result = await transaction(pool, async (c) => {
              const updated = await c.query(
                'UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id',
                [id],
              );
              if (!updated.rowCount) throw new ApiError(404, 'Key not found');
              await audit(c, 'key.revoked', id!, actor);
              return { ok: true };
            });
            break;
        }
        return reply.code(spec.code ?? 200).send(result);
      },
    });
  return {
    app,
    drain: () => {
      draining = true;
    },
  };
}
