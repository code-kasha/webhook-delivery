# Contributing

Use Node.js 22.14+ and pnpm 10.17.1. PostgreSQL 17 is the development/CI baseline. Read [design](docs/design.md) before changing the queue, protocol or security boundaries.

1. Install with `pnpm install --frozen-lockfile`.
2. Start an isolated PostgreSQL database (the README's Compose setup is suitable).
3. Set `TEST_DATABASE_URL` if not using `postgresql://webhook:webhook@localhost:55432/webhook`.
4. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm openapi:check`.
5. For contract changes, run `pnpm openapi` and commit `openapi.json` alongside the Zod changes.
6. Build and smoke test the image following [deployment](docs/deployment.md).

Integration tests create/drop their own randomly named schema; never point them at a production database. Tests use real PostgreSQL locks and local HTTP receivers. Add behavioural coverage for changed failure handling and transaction boundaries; avoid tests that merely repeat implementation statements.

Use fictional data. Keep secrets in ignored environment files. Use LF line endings; `.gitattributes` enforces them. Do not alter applied migrations: add a new version and update the migration runner when evolving the schema. Never claim throughput, test totals or deployment results without a reproducible measurement.

This checkout is pre-release. Maintenance status will be stated when v1.0.0 ships. Contributions use the MIT license.
