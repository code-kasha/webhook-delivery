# Verification record

This file records checks that ran, not planned badges or deployment claims.

Initial local checks on 27 September 2026 (Windows 11, PowerShell, Node 26.3.0, pnpm 10.17.1, Docker Engine 29.8.0, PostgreSQL 17 container):

- 67 Vitest tests passed: 47 signature/destination/HTTP utility tests and 20 PostgreSQL/API/worker integration tests. Use `pnpm test` to obtain the current count; this is not a coverage percentage.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm openapi:check` passed after fixing initial lint/build errors.
- `pnpm audit --prod` reported no known vulnerabilities at that check; this is time-dependent and not a security certification.
- The Node 22 amd64 Docker image built, applied migrations and served the API against PostgreSQL. `pnpm smoke` passed for health, readiness, schema, Swagger assets and unauthenticated-request rejection. The process ran as UID 1000.
- The full 67-test suite also passed inside Linux on Node 22.23.3 with PostgreSQL 17.11 using the Dockerfile's test target. A rebuilt final image passed the smoke test again. SIGTERM via Docker stop completed with exit code 0.

Integration coverage includes simultaneous idempotent publishes, conflicting keys, subscription fan-out, disabled endpoint retention, separate consumer claims with SKIP LOCKED, one in-flight job per endpoint, lease recovery with stale-token rejection, retry exhaustion, replay history, pause/resume, successful failure-streak reset, rollback when an audit write fails, a real receiver accepting overlapping secrets and graceful worker shutdown with an in-flight request.

## Correctness and security review — 27 September 2026

Task 1 review of the queue, transactions, sender, destination policy, signing and encryption. Findings fixed, each with a regression test that fails against the previous code unless noted:

- **Live lease takeover (duplicate delivery).** A claimer whose endpoint-selection snapshot predated a competing committed claim treated that live lease as expired. A stress run of 10 concurrent claimers over 150 deliveries on the previous code marked 89 live attempts `unknown` and re-sent them. Claims now re-read the in-flight row after locking the endpoint and back off from a live lease. The regression test runs 8 claimers over 180 deliveries and requires zero `unknown` attempts; it is a concurrency test, so on old code it fails by likelihood rather than determinism.
- **Process crash on a lost connection inside a transaction.** A checked-out `pg` client emitted an unhandled `error`, and a failing `ROLLBACK` replaced the original error. The test terminates the transaction's backend with `pg_terminate_backend`; the previous code produced two uncaught exceptions and the masked error.
- **Known outcome lost during a brief database outage.** Recording now retries with backoff within the lease. Test: a TCP proxy between the worker and PostgreSQL drops every connection while the receiver answers and restores it after 1.5 s; the delivery finishes `succeeded` with no `unknown` attempt. The previous code left it in flight.
- **IPv6 outside `2000::/3` accepted.** `ipaddr.js` labels `::a00:1` (IPv4-compatible hex form of 10.0.0.1) and unallocated `4000::1` as unicast.
- **Final-claim expiry** did not audit the resulting failure.
- Hardening without a failing-before test: rotation overlap uses the database clock; AES-GCM requires a 16-byte tag (Node 26 already rejects short tags; Node 22 only warns).

Added coverage that already passed on the previous code: competing replays (exactly one succeeds, one 409), in-flight result recorded after disable, response excerpts with invalid and split multibyte UTF-8 staying ≤ 2048 bytes, slow-drip body and never-answering DNS bounded by the total deadline, a real `SIGKILL` of a separate worker process mid-request followed by lease recovery (only the 60-second lease wait is shortened in SQL), and real HTTPS with per-run generated certificates: untrusted issuer and hostname mismatch refused, SNI and Host carry the original hostname while connecting to the pinned address.

Reviewed without changes: lock order (endpoint then delivery) in claim, finish and replay; publish idempotency under concurrency; subscription snapshot; redirect refusal; header/body caps; HMAC construction and verification; API key hashing and scope checks.

Checks after the fixes:

- Windows 11, Node 26.3.0, pnpm 10.17.1, PostgreSQL 17.11 container: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm openapi:check` passed; `pnpm test` 85 passed (56 security/HTTP, 2 HTTPS run from Git Bash with OpenSSL on `PATH`, 27 integration).
- Linux `test` image, Node 22.23.3, OpenSSL 3.0.22, PostgreSQL 17.11: 85 passed, none skipped. The test stage now installs the OpenSSL CLI.
- Rebuilt amd64 runtime image: migrations applied, `scripts/smoke.mjs` passed, UID 1000, `docker stop` exit code 0, no error-level log lines.

At the end of task 1, Node 24, arm64 and browser verification were outstanding. They were subsequently checked below, followed by GitHub Actions and hosted deployment. Release publication and load performance remain unverified.

## Runtime matrix and reviewer walkthrough — 27 September 2026

Tasks 2 and 3 ran locally; nothing was pushed, published or deployed.

| Environment                                               | Actual result                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Linux amd64, Node 24.21.0, pnpm 10.17.1, PostgreSQL 17.11 | All 85 tests passed (56 security/HTTP, 2 HTTPS, 27 integration), no skips; lint, typecheck, build and OpenAPI freshness passed          |
| Windows, Node 26.3.0                                      | Frozen-lockfile install, lint, typecheck, build and schema freshness passed; native CLI/API/receiver walkthrough passed                 |
| Linux arm64, Node 22.23.3                                 | Built and executed with Docker Desktop emulation on an amd64 host; migration, runtime smoke and UID 1000 verified; graceful stop exit 0 |
| Linux amd64, Node 22.23.3, PostgreSQL 17.11               | Fresh Compose build/start/migration/key creation, runtime smoke and receiver walkthrough passed                                         |

The Dockerfile accepts `--build-arg NODE_VERSION=24`; the default runtime remains Node 22. The arm64 result is emulated execution, not a physical ARM benchmark or a published multi-architecture manifest. Commands used for the matrix:

```sh
docker build --build-arg NODE_VERSION=24 --target test -t webhook-delivery:test24 .
docker run --rm --network webhook-verification_default -e TEST_DATABASE_URL=postgresql://webhook:webhook@db:5432/webhook webhook-delivery:test24 sh -c 'pnpm typecheck && pnpm test && pnpm build && pnpm openapi:check'
docker run --rm webhook-delivery:test24 pnpm lint
docker buildx build --platform linux/arm64 --load -t webhook-delivery:arm64 .
```

The arm64 runtime was run with `--platform linux/arm64`, a generated encryption key, the local PostgreSQL network and host port 3001. `SMOKE_URL=http://127.0.0.1:3001 node scripts/smoke.mjs` passed; `process.arch` reported `arm64`. The final Compose amd64 service at port 3000 passed the same smoke script.

### Clean quick starts and operator sequence

Native: generated a fresh `.env` from `.env.example`, used a newly created `webhook_native_verify` database, ran the README frozen install, env-file migration/key commands, build and native Node server. The existing PostgreSQL server for this native application check was the local PostgreSQL 17 container, not a hosted provider. Compose: generated another fresh `.env` and encryption key, ran `docker compose -p webhook-verification up --build -d` with a newly created project volume, then the documented container CLI key command. The project name isolated this run from the earlier development data; no service configuration override was needed.

Both paths used the bundled receiver (native loopback; Docker Desktop via `host.docker.internal` with `RECEIVER_HOST=0.0.0.0`). Both produced real signed HTTP deliveries acknowledged with 204. An isolated HTTP harness then exercised the [documented operator sequence](walkthrough.md):

- Register, publish, inspect the succeeded attempt and its response code.
- Disable, publish a retained event, restart the native process or run Compose `down`/`up` without deleting the volume. The original API key, event/attempt history, encrypted signing secret and queued event survived; re-enabling delivered the queued event.
- Rotate and verify the raw payload independently against both old and new secrets during overlap.
- Return real HTTP 503 responses from a controlled local receiver; observe automatic pause at five attempts, re-enable, wait through real backoff to failure at eight, then restore 204 and replay. Both runs preserved event/delivery IDs and nine lifetime attempt records with one attempt in the new cycle. No SQL timestamps or counters were changed to accelerate this sequence.

### Controlled database TLS

A separate PostgreSQL 17 container used an OpenSSL-generated, short-lived self-signed CA/server certificate with DNS SAN `tls-db`. The application `createPool` used `sslmode=verify-full&sslrootcert=/certs/server.crt` against that network alias. Migration and a query of `pg_stat_ssl` succeeded with `ssl=true`, `version=TLSv1.3`. Removing the trusted CA failed with `DEPTH_ZERO_SELF_SIGNED_CERT`; connecting through a different hostname failed with `ERR_TLS_CERT_ALTNAME_INVALID`; connecting to the plaintext development server with verification required failed with “The server does not support SSL connections”. No certificate verification was disabled. Certificates/keys stayed out of Git. [Deployment](deployment.md#database-tls) records the URL and mount configuration; actual Neon verification is recorded below.

### Swagger and documentation

Connected Brave rendered `/docs` with the local CSS/JS, route groups, authorization dialog and request forms. Live readiness showed 200 with `{"ok":true}`; an unauthenticated delivery query showed 401. The real 1905×854 overview screenshot is [swagger.png](images/swagger.png), referenced in the README without credentials. Added explicit fictional Zod examples after observing random regex-generated sample text in Swagger. Generated OpenAPI remains the contract source's output.

Reviewed README/API/design/deployment/receiver/release docs for at-least-once semantics, no ordering guarantee, eight-attempt budget versus five-failure pause, separate replay/resume and sleeping-worker behavior. Credits remain byte-for-byte unchanged. Local Markdown file links were checked. No live demo URL, release badge or published-image claim was added.

## Public repository and GitHub CI — 27 September 2026

At Akash's request to perform task 4, created public [code-kasha/webhook-delivery](https://github.com/code-kasha/webhook-delivery), configured `origin` and pushed `main` at `961b3da7f9a451da9c2ffabd2625a84e400373d4`. Only the main branch was pushed; local tool checkpoint refs and ignored test artifacts were not published.

[CI run 36322054815](https://github.com/code-kasha/webhook-delivery/actions/runs/36322054815) completed successfully:

- Node 22.23.2 and 24.21.0 on Ubuntu 24.04, PostgreSQL 17.11 service containers: each passed lint, strict typecheck, all 85 tests (no skips), build and OpenAPI freshness.
- The Node 22 job built the Docker runtime, applied migrations and passed liveness, readiness, Swagger assets, OpenAPI and unauthenticated-request rejection smoke checks.
- Image publication and release jobs were skipped as intended for a branch push. No tag, image release or hosted service was published.
- GitHub emitted a non-failing annotation about `pnpm/action-setup@v4` targeting the deprecated Node 20 action runtime and being forced onto Node 24. The action and all checks succeeded; the workflow was not changed.

Reviewed tracked paths and credential patterns in Git history before pushing; no private artifacts, environment files or live credential matches were found. Repository Actions default permissions are read-only and pull-request approval is disabled; workflow checks also use `contents: read`. Only tag-gated publishing jobs request package/release write permissions. The repository's Actions secret list is empty. Fixed credentials in Compose/CI are disposable development fixtures, not a deployed admin key. This is a targeted review, not a formal secret-scanner certification.

The main-branch badge endpoint returned HTTP 200 and reports passing. Akash separately authorized the follow-up badge/documentation push at `74bfac0`. [CI run 36322213120](https://github.com/code-kasha/webhook-delivery/actions/runs/36322213120) passed the same checks, including all 85 tests on each Node version and the Node 22 container smoke; publication jobs remained skipped.

## Hosted demo — 28 September 2026 (IST)

Task 5 used authenticated Neon CLI 6.2.3 and Render CLI 2.28.0 with Akash's deployment authorization. Dedicated free resources were created; unrelated account resources were not modified. Both Render services deployed commit `74bfac0` in Singapore with automatic deployment disabled. No application source changes were required.

- Dedicated Neon PostgreSQL 17 database: migrations and admin/publish-only key creation succeeded. The application's `createPool` with `sslmode=verify-full` reported an encrypted, authorized TLS 1.3 client socket. The proxy-terminated backend's `pg_stat_ssl` was false; it is not proof of the client connection's TLS state. The deployed API uses the same verified URL.
- [Public API](https://webhook-delivery-demo.onrender.com/docs): `SMOKE_URL` targeting the hosted API with `node scripts/smoke.mjs` passed liveness, readiness, Swagger assets, OpenAPI and unauthenticated-request rejection.
- Published a fictional `demo.lead_created` event to the controlled HTTPS receiver. It succeeded on its first attempt with HTTP 204. Reusing the idempotency key returned the same event with `duplicate: true`.
- A publish-only key was refused endpoint administration (403); registration of `http://127.0.0.1:4000` was refused (400), with private destinations disabled. Unsigned and invalid-signature receiver requests returned 401.
- Disabled the endpoint, published another event and verified a pending job with zero attempts. Issued a real Render API restart. Provider logs showed a replacement instance listening and the old instance draining. The original API keys, event and attempt history remained valid and unchanged; the queued delivery retained its ID. Re-enabling the endpoint delivered it with HTTP 204, also verifying that the encrypted signing secret survived the restart.

Both provider deployments reported live. Credentials and detailed test evidence remain outside the repository. This is controlled functional verification, not a load test, backup restore test or observation of a full idle sleep/wake cycle. Sleep behavior and free-tier limitations follow the [provider documentation](https://render.com/docs/free). The receiver has only demo-level in-memory deduplication. Planned manual retirement is 28 December 2026; no release date has been claimed.
