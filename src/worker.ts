import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { audit, transaction, type Pool } from './db.js';
import { policy, type Config } from './config.js';
import { decrypt } from './crypto.js';
import { sign } from './verify.js';
import { send, type SendResult } from './send.js';
import type { FastifyBaseLogger } from 'fastify';

export interface Job {
  id: string;
  endpoint_id: string;
  event_id: string;
  lease_token: string;
  attempt_count: number;
  cycle_attempts: number;
  url: string;
  body: string;
  secret: string;
  previous_secret: string | null;
  previous_expires_at: Date | null;
}
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.floor(
    Math.min(policy.maxRetryMs, policy.baseRetryMs * 2 ** (attempt - 1)) *
      (0.5 + random() * 0.5),
  );
export async function claim(pool: Pool): Promise<Job | null> {
  return transaction(pool, async (c) => {
    const endpoint = (
      await c.query(`SELECT e.* FROM endpoints e WHERE e.enabled AND NOT e.paused
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.endpoint_id=e.id AND d.status='in_flight' AND d.lease_until > now())
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.endpoint_id=e.id AND ((d.status='pending' AND d.next_attempt_at<=now()) OR (d.status='in_flight' AND d.lease_until<=now())))
      ORDER BY (SELECT min(CASE WHEN d.status='in_flight' THEN d.lease_until ELSE d.next_attempt_at END)
        FROM deliveries d WHERE d.endpoint_id=e.id AND d.status IN ('pending','in_flight')), e.id
      LIMIT 1 FOR UPDATE OF e SKIP LOCKED`)
    ).rows[0];
    if (!endpoint) return null;
    // The selection snapshot can predate a competing claim that committed before this lock was taken.
    const inFlight = (
      await c.query(
        "SELECT *, lease_until<=now() AS expired FROM deliveries WHERE endpoint_id=$1 AND status='in_flight' FOR UPDATE",
        [endpoint.id],
      )
    ).rows[0];
    if (inFlight && !inFlight.expired) return null;
    if (inFlight) {
      const status =
        inFlight.cycle_attempts >= policy.maxAttempts ? 'failed' : 'pending';
      await c.query(
        "UPDATE attempts SET status='unknown',error='lease_expired',finished_at=now() WHERE delivery_id=$1 AND number=$2 AND status='started'",
        [inFlight.id, inFlight.attempt_count],
      );
      await c.query(
        'UPDATE deliveries SET status=$2,lease_token=NULL,lease_until=NULL,next_attempt_at=now() WHERE id=$1',
        [inFlight.id, status],
      );
      await audit(c, 'delivery.lease_expired', inFlight.id);
      if (status === 'failed') await audit(c, 'delivery.failed', inFlight.id);
    }
    const selected = (
      await c.query(
        "SELECT d.*,v.body FROM deliveries d JOIN events v ON v.id=d.event_id WHERE d.endpoint_id=$1 AND d.status='pending' AND d.next_attempt_at<=now() ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1 FOR UPDATE OF d",
        [endpoint.id],
      )
    ).rows[0];
    if (!selected) return null;
    const token = randomUUID();
    const updated = (
      await c.query(
        "UPDATE deliveries SET status='in_flight',lease_token=$2,lease_until=now()+$3*interval '1 millisecond',attempt_count=attempt_count+1,cycle_attempts=cycle_attempts+1 WHERE id=$1 RETURNING *",
        [selected.id, token, policy.leaseMs],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO attempts (id,delivery_id,number,status) VALUES ($1,$2,$3,'started')",
      [randomUUID(), selected.id, updated.attempt_count],
    );
    await audit(c, 'delivery.claimed', selected.id);
    return {
      ...updated,
      body: selected.body,
      url: endpoint.url,
      secret: endpoint.secret,
      previous_secret: endpoint.previous_secret,
      previous_expires_at: endpoint.previous_expires_at,
    } as Job;
  });
}
export async function finish(
  pool: Pool,
  job: Job,
  result: SendResult,
): Promise<boolean> {
  return transaction(pool, async (c) => {
    await c.query('SELECT id FROM endpoints WHERE id=$1 FOR UPDATE', [
      job.endpoint_id,
    ]);
    const delivery = (
      await c.query(
        "SELECT * FROM deliveries WHERE id=$1 AND lease_token=$2 AND status='in_flight' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!delivery) return false; // Fencing: a stale worker cannot overwrite a recovered attempt.
    const status = result.ok
      ? 'succeeded'
      : delivery.cycle_attempts >= policy.maxAttempts
        ? 'failed'
        : 'pending';
    await c.query(
      'UPDATE attempts SET status=$3,response_code=$4,duration_ms=$5,response_body=$6,error=$7,finished_at=now() WHERE delivery_id=$1 AND number=$2',
      [
        job.id,
        job.attempt_count,
        result.ok ? 'succeeded' : 'failed',
        result.code,
        result.duration,
        result.body,
        result.error,
      ],
    );
    await c.query(
      "UPDATE deliveries SET status=$2,lease_token=NULL,lease_until=NULL,next_attempt_at=now()+$3*interval '1 millisecond' WHERE id=$1",
      [job.id, status, result.ok ? 0 : retryDelay(delivery.cycle_attempts)],
    );
    const endpoint = (
      await c.query(
        'UPDATE endpoints SET consecutive_failures=CASE WHEN $2 THEN 0 ELSE consecutive_failures+1 END, paused=paused OR (NOT $2 AND consecutive_failures+1 >= $3) WHERE id=$1 RETURNING paused',
        [job.endpoint_id, result.ok, policy.pauseAfter],
      )
    ).rows[0];
    await audit(c, `delivery.${status}`, job.id);
    if (endpoint.paused && !result.ok)
      await audit(c, 'endpoint.auto_paused', job.endpoint_id);
    return true;
  });
}
export class Worker {
  private stopping = false;
  private loops: Promise<void>[] = [];
  constructor(
    private pool: Pool,
    private config: Config,
    private logger: FastifyBaseLogger,
  ) {}
  start(concurrency = 4) {
    this.loops = Array.from({ length: concurrency }, () => this.loop());
  }
  async stop() {
    this.stopping = true;
    await Promise.all(this.loops);
  }
  async once(): Promise<boolean> {
    const job = await claim(this.pool);
    if (!job) return false;
    const claimed = Date.now();
    const timestamp = String(Math.floor(Date.now() / 1000));
    let result: SendResult;
    try {
      const secrets = [decrypt(job.secret, this.config.SECRET_ENCRYPTION_KEY)];
      if (
        job.previous_secret &&
        job.previous_expires_at &&
        job.previous_expires_at.getTime() > Date.now()
      )
        secrets.push(
          decrypt(job.previous_secret, this.config.SECRET_ENCRYPTION_KEY),
        );
      result = await send(
        job.url,
        job.body,
        {
          'webhook-id': job.event_id,
          'webhook-delivery-id': job.id,
          'webhook-timestamp': timestamp,
          'webhook-signature': sign(job.body, timestamp, secrets),
        },
        this.config.allowPrivate,
      );
    } catch {
      result = {
        ok: false,
        code: null,
        duration: 0,
        body: '',
        error: 'signing_error',
      };
    }
    const recorded = await this.record(job, result, claimed);
    this.logger.info(
      {
        deliveryId: job.id,
        eventId: job.event_id,
        code: result.code,
        ok: result.ok,
        recorded,
      },
      'Delivery completed',
    );
    return true;
  }
  /** Retries a brief database outage within the lease; fencing makes a repeated finish harmless. */
  private async record(job: Job, result: SendResult, claimed: number) {
    for (let wait = 250; ; wait = Math.min(wait * 2, 4000)) {
      try {
        return await finish(this.pool, job, result);
      } catch (error) {
        if (Date.now() + wait >= claimed + policy.leaseMs) throw error;
        this.logger.warn(
          { deliveryId: job.id },
          'Recording delivery outcome failed; retrying',
        );
        await delay(wait);
      }
    }
  }
  private async loop() {
    while (!this.stopping) {
      try {
        if (!(await this.once())) await delay(250);
      } catch {
        this.logger.error(
          'Worker operation failed; leased work remains recoverable',
        );
        await delay(1000);
      }
    }
  }
}
