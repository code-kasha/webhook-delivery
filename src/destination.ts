import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublic(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export function destination(raw: string, allowPrivate: boolean): URL {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      'Destination must be HTTP(S), without credentials or fragment',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !allowPrivate &&
    (host === 'localhost' ||
      host.endsWith('.localhost') ||
      (isIP(host) && !isPublic(host)))
  )
    throw new Error('Private destination refused');
  return url;
}
export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;
export const resolveHost: Resolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });
export async function resolveDestination(
  raw: string,
  allowPrivate: boolean,
  resolver: Resolver = resolveHost,
) {
  const url = destination(raw, allowPrivate);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname);
  if (
    !records.length ||
    records.some(
      (r) => !isIP(r.address) || (!allowPrivate && !isPublic(r.address)),
    )
  )
    throw new Error('DNS resolved to a forbidden destination');
  return { url, record: records[0]! };
}
