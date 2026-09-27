# Deployment

The image runs the API and four worker loops in one Node process as user `node` (UID 1000). PostgreSQL is external and holds all durable state. Use an HTTPS reverse proxy and leave `ALLOW_PRIVATE_DESTINATIONS=false` unless private destinations are deliberately required.

## Configuration

| Variable                     | Default / purpose                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`               | Required PostgreSQL URL; role needs schema/table permissions for migrations       |
| `SECRET_ENCRYPTION_KEY`      | Required 64 hex characters; encrypts signing secrets using AES-256-GCM            |
| `HOST`                       | `127.0.0.1` natively; `0.0.0.0` in the image                                      |
| `PORT`                       | `3000`; hosts may override it                                                     |
| `ALLOW_PRIVATE_DESTINATIONS` | Literal `false`; explicit `true` permits private/loopback/link-local destinations |
| `LOG_LEVEL`                  | `info`; `silent`, `fatal`, `error`, `warn`, `info`, `debug` supported             |
| `TEST_DATABASE_URL`          | Tests only; defaults to the local Compose database                                |
| `WEBHOOK_SECRET`             | Example receiver only; endpoint's signing secret                                  |

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

Terminate HTTPS at Caddy/nginx or a platform edge, publish the API only behind it, and configure database TLS according to the database provider's documented CA settings. Do not disable certificate verification. This service does not trust forwarded client IP headers or implement per-user proxy rate limits; configure request-rate, connection and network access limits at the edge.

Public `/docs` and `/openapi.json` disclose the contract, not customer data. Protect admin keys separately from publish-only application keys. Never put a key in a URL, source control or a public screenshot. Rotate compromised API keys by issuing a replacement and revoking the old key. Bootstrap another admin key with the CLI if you revoke the last one.

## Backups, updates and recovery

- Back up PostgreSQL with your provider or `pg_dump`, and separately preserve the encryption key in your secret store. Restore-test both before relying on backups.
- Before updating, take a backup; run migrations once, then replace the image. Migrations are forward-only. Roll back by restoring the matched database backup and previous image together.
- Use SIGTERM/`docker stop --time 40`. The API drains, the worker stops claiming and waits for current requests and finalization, then closes the pool. A forced kill recovers after the 60-second lease expires. Delivery may duplicate; it is never declared successful solely because it was sent.
- Inspect failed jobs, endpoint pauses and attempt errors. Re-enable only after addressing the problem; replay failed jobs separately. SQL audit history is retained with state transitions.
- There is no automatic data retention. Monitor event, delivery and attempt table sizes and PostgreSQL disk capacity. Removing events also changes the idempotency guarantee, so define your retention policy before adding cleanup.
- Keep clocks synchronized for receiver timestamp verification.

## Planned Render + Neon demo

No hosted demo exists yet. After an explicit deployment request, create a Render Docker web service and a dedicated Neon PostgreSQL database. Set the encrypted-secret key, database URL and `HOST=0.0.0.0`, apply migrations, create private admin and publish-only credentials, and use `/ready` as the health check. Test database TLS with the actual provider configuration before claiming it works.

Render's [free web services](https://render.com/docs/free) spin down after 15 minutes without inbound traffic. While this process sleeps, its delivery worker also stops; persisted jobs resume when the service wakes. Therefore a free demo cannot demonstrate continuously scheduled retry timing during idle periods. Use always-on compute for installations needing timely background delivery.

The public demo should show docs and controlled fictional traffic, with private admin credentials and a controlled receiver. Do not expose an unrestricted public publishing or admin key. State the exact end date in the README, approximately three months after the actual release date; do not invent a release date now. This setup and its spending/free-tier limits must be verified when deployment is requested.

## Publishing

The workflow runs checks for every push/PR. An authorized `v*` tag matching `package.json` triggers a multi-architecture GHCR image (amd64/arm64), then a GitHub Release containing the schema, receiver source, algorithm documentation and SHA-256 checksums. Release notes come from the matching dated changelog heading. The workflow does not deploy a hosted service automatically.

Only push a release tag after the [release checklist](release.md) is complete. A first GHCR package may need its visibility changed to public after publication. No workflow run, remote publication or deployment has been performed merely by adding this file.
