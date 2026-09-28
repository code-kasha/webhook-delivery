import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { policy } from './config.js';
import { resolveDestination, type Resolver } from './destination.js';

export interface SendResult {
  ok: boolean;
  code: number | null;
  duration: number;
  body: string;
  error: string | null;
}
export async function send(
  url: string,
  body: string,
  headers: Record<string, string>,
  allowPrivate: boolean,
  timeoutMs = policy.timeoutMs,
  resolver?: Resolver,
): Promise<SendResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let request: http.ClientRequest | undefined;
    let done = false;
    let code: number | null = null;
    let received = 0;
    let retained = 0;
    const chunks: Buffer[] = [];
    const finish = (ok: boolean, error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let excerpt = Buffer.concat(chunks)
        .toString('utf8')
        .replaceAll('\u0000', '');
      // Invalid or split UTF-8 can expand to replacement characters; cap stored bytes too.
      while (Buffer.byteLength(excerpt) > policy.logBodyCap)
        excerpt = excerpt.slice(0, -1);
      resolve({
        ok,
        code,
        duration: Math.round(performance.now() - started),
        body: excerpt,
        error,
      });
      request?.destroy();
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    void resolveDestination(url, allowPrivate, resolver)
      .then(({ url: target, record }) => {
        if (done) return;
        // Connect directly to the checked address; retain hostname for Host and TLS certificate verification.
        request = (target.protocol === 'https:' ? https : http).request(
          target,
          {
            method: 'POST',
            agent: false,
            maxHeaderSize: 16384,
            lookup: (_host, _options, callback) =>
              callback(null, record.address, record.family),
            family: record.family,
            headers: {
              ...headers,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              'user-agent': 'webhook-delivery/1.0.0',
            },
          },
          (response) => {
            code = response.statusCode ?? null;
            response.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (retained < policy.logBodyCap) {
                const part = chunk.subarray(0, policy.logBodyCap - retained);
                chunks.push(part);
                retained += part.length;
              }
              if (received > policy.responseCap) {
                finish(false, 'response_too_large');
                response.destroy();
              }
            });
            response.on('end', () =>
              finish(
                code !== null && code >= 200 && code < 300,
                code !== null && code >= 200 && code < 300
                  ? null
                  : 'http_status',
              ),
            );
            response.on('error', () => finish(false, 'response_error'));
            response.on('aborted', () => finish(false, 'response_aborted'));
          },
        );
        request.on('error', () => finish(false, 'connection_error'));
        request.end(body);
      })
      .catch(() => finish(false, 'destination_refused_or_dns_error'));
  });
}
