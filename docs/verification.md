# Verification record

This file records checks that ran, not planned badges or deployment claims.

Initial local checks on 27 September 2026 (Windows 11, PowerShell, Node 26.3.0, pnpm 10.17.1, Docker Engine 29.8.0, PostgreSQL 17 container):

- 67 Vitest tests passed: 47 signature/destination/HTTP utility tests and 20 PostgreSQL/API/worker integration tests. Use `pnpm test` to obtain the current count; this is not a coverage percentage.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm openapi:check` passed after fixing initial lint/build errors.
- `pnpm audit --prod` reported no known vulnerabilities at that check; this is time-dependent and not a security certification.
- The Node 22 amd64 Docker image built, applied migrations and served the API against PostgreSQL. `pnpm smoke` passed for health, readiness, schema, Swagger assets and unauthenticated-request rejection. The process ran as UID 1000.
- The full 67-test suite also passed inside Linux on Node 22.23.3 with PostgreSQL 17.11 using the Dockerfile's test target. A rebuilt final image passed the smoke test again. SIGTERM via Docker stop completed with exit code 0.

Integration coverage includes simultaneous idempotent publishes, conflicting keys, subscription fan-out, disabled endpoint retention, separate consumer claims with SKIP LOCKED, one in-flight job per endpoint, lease recovery with stale-token rejection, retry exhaustion, replay history, pause/resume, successful failure-streak reset, rollback when an audit write fails, a real receiver accepting overlapping secrets and graceful worker shutdown with an in-flight request.

Not yet verified: Node 24, arm64 execution, actual GitHub Actions execution, published multi-arch manifests/release assets, hosted demo, real public DNS/TLS receiver integration, performance under load, and visual Swagger rendering/screenshot. The session had no connected browser, although HTTP checks confirmed the Swagger page/assets and generated schema are served. [Next tasks](tasks.md) separates review, remaining verification and release work. See the private handoff for the latest session state.
