import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { createHmac } from 'node:crypto';
import { sign, verify } from '../src/verify.js';
import { canonical, decrypt, encrypt } from '../src/crypto.js';
import {
  destination,
  isPublic,
  resolveDestination,
} from '../src/destination.js';
import { send } from '../src/send.js';
import { retryDelay } from '../src/worker.js';
import { readConfig } from '../src/config.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
describe('signature protocol', () => {
  const body = Buffer.from('{"message":"fictional नमस्ते"}');
  const timestamp = '1000';
  it('matches an independently calculated HMAC and accepts raw UTF-8', () => {
    const expected = createHmac('sha256', 'secret')
      .update(Buffer.concat([Buffer.from('1000.'), body]))
      .digest('hex');
    expect(sign(body, timestamp, ['secret'])).toBe(`v1=${expected}`);
    expect(verify(body, timestamp, `v1=${expected}`, ['secret'], 1001)).toBe(
      true,
    );
  });
  it('rejects altered body, wrong key and timestamp manipulation', () => {
    const sig = sign(body, timestamp, ['secret']);
    expect(
      verify(
        Buffer.concat([body, Buffer.from(' ')]),
        timestamp,
        sig,
        ['secret'],
        1000,
      ),
    ).toBe(false);
    expect(verify(body, timestamp, sig, ['wrong'], 1000)).toBe(false);
    expect(verify(body, '1001', sig, ['secret'], 1000)).toBe(false);
  });
  it('rejects old and future timestamps, accepts tolerance boundary', () => {
    const sig = sign(body, timestamp, ['secret']);
    expect(verify(body, timestamp, sig, ['secret'], 1300)).toBe(true);
    expect(verify(body, timestamp, sig, ['secret'], 1301)).toBe(false);
    expect(verify(body, timestamp, sig, ['secret'], 699)).toBe(false);
  });
  it.each(['', 'abc', '1e3', '-1000', '1000.0'])(
    'rejects malformed timestamp %s',
    (ts) =>
      expect(
        verify(body, ts, sign(body, ts, ['secret']), ['secret'], 1000),
      ).toBe(false),
  );
  it('accepts either rotation secret without accepting malformed signatures', () => {
    const sig = sign(body, timestamp, ['new', 'old']);
    expect(verify(body, timestamp, sig, ['old'], 1000)).toBe(true);
    expect(verify(body, timestamp, sig, ['new'], 1000)).toBe(true);
    expect(verify(body, timestamp, 'v1=ff', ['new'], 1000)).toBe(false);
  });
});
describe('SSRF destination guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('refuses %s', (address) => expect(isPublic(address)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public %s',
    (address) => expect(isPublic(address)).toBe(true),
  );
  it.each([
    'file:///tmp/a',
    'ftp://example.com',
    'http://user:pass@example.com',
    'http://example.com/#x',
    'http://2130706433',
    'http://0x7f000001',
    'http://localhost',
    'http://x.localhost',
  ])('refuses unsafe URL %s', (url) =>
    expect(() => destination(url, false)).toThrow(),
  );
  it('refuses a mixed public/private DNS answer', async () => {
    await expect(
      resolveDestination('https://example.com', false, async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow();
  });
  it('rechecks DNS for each delivery resolution', async () => {
    let n = 0;
    const resolver = async () => [
      { address: n++ === 0 ? '8.8.8.8' : '127.0.0.1', family: 4 },
    ];
    await expect(
      resolveDestination('https://example.com', false, resolver),
    ).resolves.toMatchObject({ record: { address: '8.8.8.8' } });
    await expect(
      resolveDestination('https://example.com', false, resolver),
    ).rejects.toThrow();
  });
  it('allows private addresses only with explicit override', async () => {
    await expect(
      resolveDestination('http://127.0.0.1', true),
    ).resolves.toMatchObject({ record: { address: '127.0.0.1' } });
  });
});
describe('bounded HTTP sender', () => {
  it('sends exact bytes and records success', async () => {
    const url = await listen(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      expect(body).toBe('{"fictional":true}');
      res.end('accepted');
    });
    expect(await send(url, '{"fictional":true}', {}, true)).toMatchObject({
      ok: true,
      code: 200,
      body: 'accepted',
    });
  });
  it('pins resolved hostname while preserving Host', async () => {
    const url = await listen((req, res) => {
      res.end(req.headers.host);
    });
    const target = url.replace('127.0.0.1', 'fictional.example');
    let resolutions = 0;
    const result = await send(target, '{}', {}, true, 1000, async () => {
      resolutions++;
      return [{ address: '127.0.0.1', family: 4 }];
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain('fictional.example:');
    expect(resolutions).toBe(1);
  });
  it('never follows redirects', async () => {
    let followed = false;
    const target = await listen((_req, res) => {
      followed = true;
      res.end();
    });
    const source = await listen((_req, res) =>
      res.writeHead(302, { location: target }).end(),
    );
    expect(await send(source, '{}', {}, true)).toMatchObject({
      ok: false,
      code: 302,
    });
    expect(followed).toBe(false);
  });
  it('caps response bytes and truncates logged bodies', async () => {
    const url = await listen((_req, res) => res.end('a'.repeat(100000)));
    const result = await send(url, '{}', {}, true);
    expect(result.error).toBe('response_too_large');
    expect(Buffer.byteLength(result.body)).toBe(2048);
  });
  it('has a total deadline even with a silent receiver', async () => {
    const url = await listen(() => {});
    expect(await send(url, '{}', {}, true, 30)).toMatchObject({
      ok: false,
      error: 'timeout',
    });
  });
  it('blocks loopback before connecting by default', async () => {
    const url = await listen(() => {
      throw new Error('Must not connect');
    });
    expect(await send(url, '{}', {}, false)).toMatchObject({
      ok: false,
      error: 'destination_refused_or_dns_error',
    });
  });
});
it('encrypts secrets with authenticated encryption', () => {
  const key = 'ab'.repeat(32);
  const encrypted = encrypt('secret', key);
  expect(encrypted).not.toContain('secret');
  expect(decrypt(encrypted, key)).toBe('secret');
  expect(() => decrypt(encrypted, 'cd'.repeat(32))).toThrow();
});
it('normalizes object keys recursively, preserving array order', () => {
  expect(canonical({ b: 2, a: { y: 1, x: 0 } })).toBe(
    canonical({ a: { x: 0, y: 1 }, b: 2 }),
  );
  expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
});
it('keeps retry jitter within capped exponential bounds', () => {
  expect(retryDelay(1, () => 0)).toBe(500);
  expect(retryDelay(2, () => 1)).toBe(2000);
  expect(retryDelay(99, () => 1)).toBe(3600000);
});
it('rejects malformed encryption settings without exposing their values', () => {
  expect(() =>
    readConfig({
      DATABASE_URL: 'postgres://localhost/a',
      SECRET_ENCRYPTION_KEY: 'private-value',
    }),
  ).toThrow('SECRET_ENCRYPTION_KEY');
});
