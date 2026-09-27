import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { send } from '../src/send.js';

// Throwaway certificates are generated per run; no key material is committed.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const canSetCa = typeof tls.setDefaultCACertificates === 'function';
const dir = mkdtempSync(path.join(tmpdir(), 'webhook-tls-'));
const file = (name: string) => path.join(dir, name);
const openssl = (...args: string[]) =>
  execFileSync('openssl', args, { stdio: 'ignore' });
let server: Server;
let port: number;
let received: { servername: string | false | null; host?: string }[] = [];
const defaults = canSetCa ? tls.getCACertificates('default') : [];

describe.skipIf(!hasOpenssl || !canSetCa)('real HTTPS delivery', () => {
  beforeAll(async () => {
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
    // prettier-ignore
    openssl(
      'req', '-x509', ...ec, '-nodes', '-days', '1',
      '-keyout', file('ca.key'), '-out', file('ca.crt'),
      '-subj', '/CN=Fictional Test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign',
    );
    // prettier-ignore
    openssl(
      'req', ...ec, '-nodes', '-keyout', file('leaf.key'),
      '-out', file('leaf.csr'), '-subj', '/CN=webhook.test',
    );
    writeFileSync(file('leaf.ext'), 'subjectAltName=DNS:webhook.test\n');
    // prettier-ignore
    openssl(
      'x509', '-req', '-in', file('leaf.csr'), '-days', '1',
      '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial',
      '-extfile', file('leaf.ext'), '-out', file('leaf.crt'),
    );
    server = createServer(
      {
        key: readFileSync(file('leaf.key')),
        cert: readFileSync(file('leaf.crt')),
      },
      (req, res) => {
        received.push({
          servername: (req.socket as tls.TLSSocket).servername,
          host: req.headers.host,
        });
        res.writeHead(204).end();
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    tls.setDefaultCACertificates(defaults);
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const deliver = (host: string) =>
    send(`https://${host}:${port}/hook`, '{}', {}, true, 2000, async () => [
      { address: '127.0.0.1', family: 4 },
    ]);

  it('refuses a certificate from an untrusted issuer', async () => {
    received = [];
    expect(await deliver('webhook.test')).toMatchObject({
      ok: false,
      error: 'connection_error',
    });
    expect(received).toEqual([]);
  });
  it('verifies the original hostname while connecting to the pinned address', async () => {
    tls.setDefaultCACertificates([
      ...defaults,
      readFileSync(file('ca.crt'), 'utf8'),
    ]);
    received = [];
    expect(await deliver('webhook.test')).toMatchObject({
      ok: true,
      code: 204,
    });
    expect(received).toEqual([
      { servername: 'webhook.test', host: `webhook.test:${port}` },
    ]);
    expect(await deliver('other.test')).toMatchObject({
      ok: false,
      error: 'connection_error',
    });
    expect(received).toHaveLength(1);
  });
});
