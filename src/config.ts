import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url().refine((s) => /^postgres(ql)?:/.test(s)),
  SECRET_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  ALLOW_PRIVATE_DESTINATIONS: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug'])
    .default('info'),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return {
    ...parsed.data,
    allowPrivate: parsed.data.ALLOW_PRIVATE_DESTINATIONS === 'true',
  };
}
export type Config = ReturnType<typeof readConfig>;
export const policy = {
  maxAttempts: 8,
  pauseAfter: 5,
  timeoutMs: 10000,
  leaseMs: 60000,
  baseRetryMs: 1000,
  maxRetryMs: 3600000,
  responseCap: 65536,
  logBodyCap: 2048,
  rotationSeconds: 86400,
};
