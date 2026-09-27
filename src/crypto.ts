import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
export const newSecret = () => randomBytes(32).toString('hex');
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return [iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]
    .map((b) => b.toString('hex'))
    .join('.');
}
export function decrypt(value: string, key: string) {
  const parts = value.split('.').map((p) => Buffer.from(p, 'hex'));
  if (parts.length !== 4) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    parts[0]!,
  );
  decipher.setAuthTag(parts[3]!);
  return Buffer.concat([
    decipher.update(parts[1]!),
    decipher.update(parts[2]!),
    decipher.final(),
  ]).toString('utf8');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
