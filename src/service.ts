import { randomUUID } from 'node:crypto';
import { audit, transaction, type Pool, type Client } from './db.js';
import { canonical, encrypt, hash, newSecret } from './crypto.js';
import { resolveDestination } from './destination.js';
import { policy, type Config } from './config.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const endpointColumns =
  'id, url, event_types, enabled, paused, consecutive_failures, previous_expires_at, created_at';
async function validateDestination(url: string, allowPrivate: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      resolveDestination(url, allowPrivate),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), 5000);
      }),
    ]);
  } catch {
    throw new ApiError(400, 'Destination refused or DNS lookup failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function createKey(
  pool: Pool,
  name: string,
  scope: 'admin' | 'publish',
  actor: string | null = null,
) {
  const id = randomUUID();
  const token = `whk_${newSecret()}`;
  await transaction(pool, async (c) => {
    await c.query(
      'INSERT INTO api_keys (id,name,scope,key_hash) VALUES ($1,$2,$3,$4)',
      [id, name, scope, hash(token)],
    );
    await audit(c, 'key.created', id, actor);
  });
  return { id, name, scope, token };
}
export async function lockEndpoint(c: Client, id: string) {
  const result = await c.query(
    'SELECT * FROM endpoints WHERE id=$1 FOR UPDATE',
    [id],
  );
  if (!result.rowCount) throw new ApiError(404, 'Endpoint not found');
  return result.rows[0] as {
    id: string;
    secret: string;
    previous_expires_at: Date | null;
  };
}
export class Service {
  constructor(
    public pool: Pool,
    public config: Config,
  ) {}
  async createEndpoint(
    input: { url: string; event_types: string[] },
    actor: string,
  ) {
    await validateDestination(input.url, this.config.allowPrivate);
    const secret = newSecret();
    const id = randomUUID();
    return transaction(this.pool, async (c) => {
      const result = await c.query(
        `INSERT INTO endpoints (id,url,event_types,secret) VALUES ($1,$2,$3,$4) RETURNING ${endpointColumns}`,
        [
          id,
          input.url,
          input.event_types,
          encrypt(secret, this.config.SECRET_ENCRYPTION_KEY),
        ],
      );
      await audit(c, 'endpoint.created', id, actor);
      return { ...result.rows[0], secret };
    });
  }
  async updateEndpoint(
    id: string,
    input: { url?: string; event_types?: string[]; enabled?: boolean },
    actor: string,
  ) {
    if (input.url)
      await validateDestination(input.url, this.config.allowPrivate);
    return transaction(this.pool, async (c) => {
      await lockEndpoint(c, id);
      const result = await c.query(
        `UPDATE endpoints SET url=coalesce($2,url), event_types=coalesce($3,event_types), enabled=coalesce($4,enabled), paused=CASE WHEN $4=true THEN false ELSE paused END, consecutive_failures=CASE WHEN $4=true THEN 0 ELSE consecutive_failures END WHERE id=$1 RETURNING ${endpointColumns}`,
        [id, input.url, input.event_types, input.enabled],
      );
      await audit(c, 'endpoint.updated', id, actor);
      return result.rows[0];
    });
  }
  async rotate(id: string, actor: string) {
    return transaction(this.pool, async (c) => {
      const endpoint = await lockEndpoint(c, id);
      if (
        endpoint.previous_expires_at &&
        endpoint.previous_expires_at.getTime() > Date.now()
      )
        throw new ApiError(409, 'A secret rotation overlap is already active');
      const secret = newSecret();
      const result = await c.query(
        "UPDATE endpoints SET previous_secret=secret, previous_expires_at=now()+$2*interval '1 second', secret=$3 WHERE id=$1 RETURNING previous_expires_at",
        [
          id,
          policy.rotationSeconds,
          encrypt(secret, this.config.SECRET_ENCRYPTION_KEY),
        ],
      );
      await audit(c, 'endpoint.secret_rotated', id, actor);
      return {
        secret,
        previous_expires_at: result.rows[0].previous_expires_at,
      };
    });
  }
  async publish(
    key: string,
    input: { type: string; data: Record<string, unknown> },
    actor: string,
  ) {
    const fingerprint = hash(canonical(input));
    const id = randomUUID();
    const body = JSON.stringify({
      id,
      type: input.type,
      created_at: new Date().toISOString(),
      data: input.data,
    });
    return transaction(this.pool, async (c) => {
      const inserted = await c.query(
        'INSERT INTO events (id,type,idempotency_key,request_hash,body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id',
        [id, input.type, key, fingerprint, body],
      );
      if (!inserted.rowCount) {
        const existing = (
          await c.query(
            'SELECT id,request_hash FROM events WHERE idempotency_key=$1',
            [key],
          )
        ).rows[0];
        if (existing.request_hash !== fingerprint)
          throw new ApiError(
            409,
            'Idempotency key was used with a different event',
          );
        return { id: existing.id as string, duplicate: true };
      }
      // A single statement takes the subscription snapshot, including paused/disabled endpoints.
      await c.query(
        'INSERT INTO deliveries (id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM endpoints WHERE $2=ANY(event_types)',
        [id, input.type],
      );
      await audit(c, 'event.published', id, actor);
      return { id, duplicate: false };
    });
  }
  async replay(id: string, actor: string) {
    return transaction(this.pool, async (c) => {
      const found = (
        await c.query('SELECT endpoint_id FROM deliveries WHERE id=$1', [id])
      ).rows[0];
      if (!found) throw new ApiError(404, 'Delivery not found');
      await lockEndpoint(c, found.endpoint_id);
      const result = await c.query(
        "UPDATE deliveries SET status='pending',cycle_attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='failed' RETURNING *",
        [id],
      );
      if (!result.rowCount)
        throw new ApiError(409, 'Only failed deliveries can be replayed');
      await audit(c, 'delivery.replayed', id, actor);
      return result.rows[0];
    });
  }
}
