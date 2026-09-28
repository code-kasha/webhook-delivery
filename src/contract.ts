import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
extendZodWithOpenApi(z);
const uuid = z.uuid();
const date = z.string().datetime();
const types = z
  .array(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/))
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'Event types must be unique');
export const endpointInput = z.strictObject({
  url: z.url().max(2048).openapi({ example: 'https://receiver.example/hooks' }),
  event_types: types.openapi({ example: ['lead.created'] }),
});
export const endpointPatch = endpointInput
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export const eventInput = z.strictObject({
  type: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .openapi({ example: 'lead.created' }),
  data: z
    .record(z.string(), z.unknown())
    .openapi({ example: { name: 'Fictional Customer' } }),
});
export const keyInput = z.strictObject({
  name: z.string().min(1).max(100),
  scope: z.enum(['admin', 'publish']),
});
const endpoint = z.object({
  id: uuid,
  url: z.string(),
  event_types: z.array(z.string()),
  enabled: z.boolean(),
  paused: z.boolean(),
  consecutive_failures: z.number().int(),
  previous_expires_at: date.nullable(),
  created_at: date,
});
const delivery = z.object({
  id: uuid,
  endpoint_id: uuid,
  event_id: uuid,
  status: z.enum(['pending', 'in_flight', 'succeeded', 'failed']),
  attempt_count: z.number().int(),
  cycle_attempts: z.number().int(),
  next_attempt_at: date,
  created_at: date,
});
const attempt = z.object({
  id: uuid,
  delivery_id: uuid,
  number: z.number().int(),
  status: z.enum(['started', 'succeeded', 'failed', 'unknown']),
  response_code: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  response_body: z.string().nullable(),
  error: z.string().nullable(),
  started_at: date,
  finished_at: date.nullable(),
});
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export const filters = pagination.extend({
  endpoint_id: uuid.optional(),
  event_id: uuid.optional(),
  status: z.enum(['pending', 'in_flight', 'succeeded', 'failed']).optional(),
});
export const logFilters = pagination.extend({
  endpoint_id: uuid.optional(),
  event_id: uuid.optional(),
});
const params = z.object({ id: uuid });
export const publishHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/)
    .openapi({ example: 'fictional-lead-001' }),
});
const ok = z.object({ ok: z.boolean() });
export interface RouteSpec {
  id: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  summary: string;
  scope: 'admin' | 'publish';
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodObject<{ id: z.ZodUUID }>;
  response: z.ZodType;
  code?: number;
}
export const routes: RouteSpec[] = [
  {
    id: 'endpointList',
    method: 'get',
    path: '/api/v1/endpoints',
    summary: 'List endpoints',
    scope: 'admin',
    query: pagination,
    response: z.array(endpoint),
  },
  {
    id: 'endpointCreate',
    method: 'post',
    path: '/api/v1/endpoints',
    summary: 'Register an endpoint; secret returned once',
    scope: 'admin',
    body: endpointInput,
    response: endpoint.extend({ secret: z.string() }),
    code: 201,
  },
  {
    id: 'endpointGet',
    method: 'get',
    path: '/api/v1/endpoints/{id}',
    summary: 'Get endpoint',
    scope: 'admin',
    params,
    response: endpoint,
  },
  {
    id: 'endpointUpdate',
    method: 'patch',
    path: '/api/v1/endpoints/{id}',
    summary: 'Update or re-enable endpoint; resume retained deliveries',
    scope: 'admin',
    params,
    body: endpointPatch,
    response: endpoint,
  },
  {
    id: 'endpointRotate',
    method: 'post',
    path: '/api/v1/endpoints/{id}/rotate-secret',
    summary: 'Rotate secret with a 24-hour dual-signature overlap',
    scope: 'admin',
    params,
    response: z.object({ secret: z.string(), previous_expires_at: date }),
  },
  {
    id: 'eventPublish',
    method: 'post',
    path: '/api/v1/events',
    summary: 'Publish idempotently; 202 for both new and duplicate events',
    scope: 'publish',
    body: eventInput,
    response: z.object({ id: uuid, duplicate: z.boolean() }),
    code: 202,
  },
  {
    id: 'eventGet',
    method: 'get',
    path: '/api/v1/events/{id}',
    summary: 'Get the immutable event envelope',
    scope: 'admin',
    params,
    response: z.object({
      id: uuid,
      type: z.string(),
      created_at: date,
      data: z.record(z.string(), z.unknown()),
    }),
  },
  {
    id: 'deliveryList',
    method: 'get',
    path: '/api/v1/deliveries',
    summary: 'List deliveries; status=failed selects the failed queue',
    scope: 'admin',
    query: filters,
    response: z.array(delivery),
  },
  {
    id: 'deliveryReplay',
    method: 'post',
    path: '/api/v1/deliveries/{id}/replay',
    summary: 'Replay a failed delivery with a fresh retry budget',
    scope: 'admin',
    params,
    response: delivery,
  },
  {
    id: 'attemptList',
    method: 'get',
    path: '/api/v1/attempts',
    summary: 'Query attempt logs by endpoint or event',
    scope: 'admin',
    query: logFilters,
    response: z.array(attempt),
  },
  {
    id: 'keyCreate',
    method: 'post',
    path: '/api/v1/keys',
    summary: 'Create an API key; token returned once',
    scope: 'admin',
    body: keyInput,
    response: z.object({
      id: uuid,
      name: z.string(),
      scope: z.enum(['admin', 'publish']),
      token: z.string(),
    }),
    code: 201,
  },
  {
    id: 'keyList',
    method: 'get',
    path: '/api/v1/keys',
    summary: 'List API key metadata',
    scope: 'admin',
    query: pagination,
    response: z.array(
      z.object({
        id: uuid,
        name: z.string(),
        scope: z.enum(['admin', 'publish']),
        created_at: date,
        revoked_at: date.nullable(),
      }),
    ),
  },
  {
    id: 'keyRevoke',
    method: 'delete',
    path: '/api/v1/keys/{id}',
    summary: 'Revoke a key, including the caller key if selected',
    scope: 'admin',
    params,
    response: ok,
  },
];
export function openapi(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'ApiKey', {
    type: 'http',
    scheme: 'bearer',
    description:
      'API key. Admin can use every operation; publish can only POST events.',
  });
  const error = z.object({ error: z.string() });
  for (const r of routes)
    registry.registerPath({
      method: r.method,
      path: r.path,
      operationId: r.id,
      summary: r.summary,
      tags: [r.path.split('/')[3]!],
      security: [{ ApiKey: [] }],
      request: {
        ...(r.body
          ? {
              body: {
                required: true,
                content: { 'application/json': { schema: r.body } },
              },
            }
          : {}),
        ...(r.query ? { query: r.query as z.ZodObject } : {}),
        ...(r.params ? { params: r.params } : {}),
        ...(r.id === 'eventPublish' ? { headers: publishHeaders } : {}),
      },
      responses: {
        [r.code ?? 200]: {
          description: 'Success',
          content: { 'application/json': { schema: r.response } },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 413, 500].map((code) => [
            code,
            {
              description: 'Error',
              content: { 'application/json': { schema: error } },
            },
          ]),
        ),
      },
    });
  for (const path of ['/health', '/ready'])
    registry.registerPath({
      method: 'get',
      path,
      summary:
        path === '/health'
          ? 'Process liveness'
          : 'Database and migration readiness',
      responses: {
        200: {
          description: 'Healthy',
          content: { 'application/json': { schema: ok } },
        },
        503: {
          description: 'Unavailable',
          content: { 'application/json': { schema: ok } },
        },
      },
    });
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Webhook Delivery',
      version: '1.0.0',
      description:
        'One organisation per install. At-least-once HTTP(S) delivery; no ordering guarantee. Fictional examples only.',
    },
  });
}
