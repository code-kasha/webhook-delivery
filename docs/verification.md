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

Not yet verified: Node 24, arm64 execution, actual GitHub Actions execution, published multi-arch manifests/release assets, hosted demo, public DNS/TLS receivers (HTTPS is verified only against a local generated CA), performance under load, and visual Swagger rendering/screenshot. The session had no connected browser, although HTTP checks confirmed the Swagger page/assets and generated schema are served. [Next tasks](tasks.md) separates review, remaining verification and release work. See the private handoff for the latest session state.
