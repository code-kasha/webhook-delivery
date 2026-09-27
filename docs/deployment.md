# Deployment

The image runs the API and four worker loops in one Node process as user `node` (UID 1000). PostgreSQL is external and holds all durable state. Use an HTTPS reverse proxy and leave `ALLOW_PRIVATE_DESTINATIONS=false` unless private destinations are deliberately required.

## Configuration

| Variable                     | Default / purpose                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`               | Required PostgreSQL URL; role needs schema/table permissions for migrations         |
| `SECRET_ENCRYPTION_KEY`      | Required 64 hex characters; encrypts signing secrets using AES-256-GCM              |
| `HOST`                       | `127.0.0.1` natively; `0.0.0.0` in the image                                        |
| `PORT`                       | `3000`; hosts may override it                                                       |
| `ALLOW_PRIVATE_DESTINATIONS` | Literal `false`; explicit `true` permits private/loopback/link-local destinations   |
| `LOG_LEVEL`                  | `info`; `silent`, `fatal`, `error`, `warn`, `info`, `debug` supported               |
| `TEST_DATABASE_URL`          | Tests only; defaults to the local Compose database                                  |
| `WEBHOOK_SECRET`             | Example receiver only; endpoint's signing secret                                    |
| `RECEIVER_HOST`              | Example receiver only; `127.0.0.1`, explicitly set a reachable interface for Docker |

Retry/timeout/rotation limits are named constants in `src/config.ts`; they are intentionally fixed for v1 and documented in [design](design.md). API keys are created through the CLI and stored hashed in PostgreSQL, not in environment variables. Do not print or collect key-command output in shared CI logs.

## Build and run

```sh
docker build -t webhook-delivery:local .
docker run --rm --env-file .env webhook-delivery:local node dist/cli.js migrate
docker run --rm --env-file .env webhook-delivery:local node dist/cli.js key admin
docker run -d --name webhook-delivery --restart unless-stopped --stop-timeout 40 --env-file .env -p 127.0.0.1:3000:3000 webhook-delivery:local
pnpm smoke
```

The database URL must be reachable **from the container**. `localhost` there means the container itself; use a Docker network database hostname or a hosted database URL. With the bundled Compose setup, networking and the migration job are already configured. Docker Desktop supports `host.docker.internal` for host services; native Linux requires an explicit reachable host/network configuration.

Migrations are a separate deployment step and serialize with a PostgreSQL advisory transaction lock. The server refuses to start before migration 1 is applied. Startup does not create an admin key automatically. Never run a destructive demo reset against a real database; this service has no reset-on-boot behavior.

Probe `GET /health` for process liveness and `GET /ready` for database/migration readiness. Use `pnpm smoke` after startup (`SMOKE_URL` can override the base URL). It checks both probes, Swagger assets, the schema and rejection of an unauthenticated protected request.

The image supports local Linux tests too:

```sh
docker build --target test -t webhook-delivery:test .
docker run --rm --network webhook-delivery_default -e TEST_DATABASE_URL=postgresql://webhook:webhook@db:5432/webhook webhook-delivery:test
```

## HTTPS, credentials and network boundaries

### Database TLS

`createPool` passes `DATABASE_URL` to node-postgres without overriding its TLS options. Use `sslmode=verify-full` to verify both the certificate chain and database hostname:

```text
postgresql://APP_USER:URL_ENCODED_PASSWORD@db.example:5432/APP_DB?sslmode=verify-full
```

For a private/provider CA, append `&sslrootcert=/run/certs/database-ca.pem`. Mount the PEM file read-only into both the migration and API containers at that path, readable by UID 1000. Native Windows paths can use forward slashes, such as `C:/certs/database-ca.pem`; URL-encode spaces and other reserved characters. Use the certificate's DNS hostname, not its resolved IP. Do not use `sslmode=no-verify`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or a permissive compatibility mode.

The locked driver's `require` mode currently aliases full verification but warns that future major versions change its semantics. Explicit `verify-full` avoids that ambiguity. The service configures TLS through the URL only; node-postgres warns that URL TLS options overwrite a separately supplied `ssl` object. See [node-postgres TLS](https://node-postgres.com/features/ssl) and its [connection-string options](https://github.com/brianc/node-postgres/blob/master/packages/pg-connection-string/README.md).

For Neon, use the actual database hostname/credentials and explicitly choose `sslmode=verify-full` for this TCP `pg` driver. Use the provider's current CA guidance if a custom trust file is required; do not copy psql-specific trust shortcuts into this Node application. Neon discusses hostname/CA verification in its [TLS guidance](https://neon.com/blog/avoid-mitm-attacks-with-psql-postgres-16). The demo connection was verified through the application's `createPool`: the client socket reported encrypted, authorized TLS 1.3. Neon's proxy terminates client TLS; the backend `pg_stat_ssl` row reported false and was not used as evidence of client encryption.

A controlled PostgreSQL 17 instance was tested locally with a generated certificate: migrations and queries used TLS 1.3; untrusted CA, hostname mismatch and a non-TLS server were all rejected. This verifies the configuration path, not a hosted provider. The bundled development Compose database uses plaintext on its local network; its hardcoded URL is not a production TLS example.

### API edge and credentials

Terminate HTTPS at Caddy/nginx or a platform edge, publish the API only behind it, and configure database TLS according to the database provider's documented CA settings. Do not disable certificate verification. This service does not trust forwarded client IP headers or implement per-user proxy rate limits; configure request-rate, connection and network access limits at the edge.

Public `/docs` and `/openapi.json` disclose the contract, not customer data. Protect admin keys separately from publish-only application keys. Never put a key in a URL, source control or a public screenshot. Rotate compromised API keys by issuing a replacement and revoking the old key. Bootstrap another admin key with the CLI if you revoke the last one.

## Backups, updates and recovery

- Back up PostgreSQL with your provider or `pg_dump`, and separately preserve the encryption key in your secret store. Restore-test both before relying on backups.
- Before updating, take a backup; run migrations once, then replace the image. Migrations are forward-only. Roll back by restoring the matched database backup and previous image together.
- Use SIGTERM/`docker stop --time 40`. The API drains, the worker stops claiming and waits for current requests and finalization, then closes the pool. A forced kill recovers after the 60-second lease expires. Delivery may duplicate; it is never declared successful solely because it was sent.
- Inspect failed jobs, endpoint pauses and attempt errors. Re-enable only after addressing the problem; replay failed jobs separately. SQL audit history is retained with state transitions.
- There is no automatic data retention. Monitor event, delivery and attempt table sizes and PostgreSQL disk capacity. Removing events also changes the idempotency guarantee, so define your retention policy before adding cleanup.
- Keep clocks synchronized for receiver timestamp verification.

## Render + Neon demo

Deployed and verified on 28 September 2026 (IST), from commit `74bfac0`:

- [API / Swagger UI](https://webhook-delivery-demo.onrender.com/docs): Render Free Docker web service in Singapore, `HOST=0.0.0.0`, `PORT=10000`, `/ready` health check and `ALLOW_PRIVATE_DESTINATIONS=false`.
- Dedicated Neon Free PostgreSQL 17 project in AWS Singapore, fixed 0.25 CU, with a `sslmode=verify-full` connection URL. Migrations and private admin/publish-only keys were created locally using the documented CLI before API startup.
- [Controlled receiver](https://webhook-delivery-receiver.onrender.com): separate Render Free Node 22.23.2 service from the same commit. Build: `pnpm install --frozen-lockfile --prod=false`; start: `pnpm receiver`. Set `RECEIVER_HOST=0.0.0.0`, `PORT=4000`, `NODE_VERSION=22.23.2`, and the registered endpoint's signing secret as private `WEBHOOK_SECRET`. Use TCP health checks because unsigned HTTP requests correctly return 401. Its deduplication is in memory and it performs no business actions.

Both services have automatic deployment disabled. Database credentials, the encryption key, API keys and signing secret are private; no public publishing key is offered. The operator registered only the controlled receiver and sent fictional `demo.lead_created` events. Readiness, Swagger assets, authentication/scope rejection, private-destination rejection, idempotency, signed HTTPS delivery and retained state across an actual Render API restart passed; see [verification](verification.md#hosted-demo--28-september-2026-ist).

Render's [free web services](https://render.com/docs/free) spin down after 15 minutes without inbound traffic. While this process sleeps, its delivery worker also stops; persisted jobs resume when the service wakes. Therefore a free demo cannot demonstrate continuously scheduled retry timing during idle periods. Use always-on compute for installations needing timely background delivery.

The receiver can also sleep, so a cold start can delay a delivery or cause a bounded attempt to time out. No keepalive automation is configured. Render's 750 free instance hours are shared across the workspace, including other services; bandwidth/build allowances also apply. Free services do not support the requested custom shutdown delay, so this demo uses Render's default; restart logs showed the old process draining and a replacement starting.

Planned retirement is **28 December 2026**, three months after this deployment. No release date is implied; reconcile the date with the actual v1.0.0 release during task 6. Retirement is manual, not a scheduled deletion: remove the two dedicated demo services and dedicated Neon project, then update these links. Do not remove unrelated workspace resources.

## Publishing

The workflow runs checks for every push/PR. An authorized `v*` tag matching `package.json` triggers a multi-architecture GHCR image (amd64/arm64), then a GitHub Release containing the schema, receiver source, algorithm documentation and SHA-256 checksums. Release notes come from the matching dated changelog heading. The workflow does not deploy a hosted service automatically.

Only push a release tag after the [release checklist](release.md) is complete. A first GHCR package may need its visibility changed to public after publication. No workflow run, remote publication or deployment has been performed merely by adding this file.
