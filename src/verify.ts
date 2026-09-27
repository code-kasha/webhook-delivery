import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(
  body: Buffer | string,
  timestamp: string,
  secrets: readonly string[],
): string {
  return secrets
    .map(
      (secret) =>
        `v1=${createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex')}`,
    )
    .join(',');
}
/** Pass the raw HTTP body bytes, before JSON parsing. Timestamp tolerance is not deduplication. */
export function verify(
  body: Buffer | string,
  timestamp: string,
  signature: string,
  secrets: readonly string[],
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (
    !/^\d{1,12}$/.test(timestamp) ||
    !Number.isFinite(nowSeconds) ||
    toleranceSeconds < 0 ||
    !Number.isFinite(toleranceSeconds)
  )
    return false;
  if (
    Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds ||
    signature.length > 1024
  )
    return false;
  const candidates = signature
    .split(',')
    .filter((v) => /^v1=[a-f0-9]{64}$/.test(v))
    .map((v) => Buffer.from(v.slice(3), 'hex'));
  return secrets.some((secret) => {
    const expected = Buffer.from(
      sign(body, timestamp, [secret]).slice(3),
      'hex',
    );
    return candidates.some((candidate) => timingSafeEqual(candidate, expected));
  });
}
