# Next tasks toward v1.0.0

Updated 28 September 2026. These are small handoff units, suitable for separate threads/models. Read `AGENTS.md` and the private `../webhook-delivery-notes/agent-start.md` before starting. Work locally; remote actions need an explicit request in that message.

## Completed baseline

- [x] Confirm name, full scope and PostgreSQL test strategy with Akash.
- [x] Implement endpoints, rotation, scoped keys, idempotent publishing and durable fan-out.
- [x] Implement signed delivery, retry budget/jitter, leases, failed queue/replay, auto-pause and retained backlog.
- [x] Implement attempt/audit transactions, outbound guards, receiver helper/example and operational probes/shutdown.
- [x] Add generated OpenAPI, Swagger assets, documentation, MIT license and CI/release workflow definitions.
- [x] Run 67 tests on Windows/Node 26 and Linux/Node 22 with real PostgreSQL 17.11.
- [x] Pass lint, type-check, build, schema freshness and amd64 running-container smoke; observe clean container shutdown (exit 0).

“Implemented” does not mean independently reviewed or released. Version remains `0.1.0`; the target is v1.0.0.

## 1. Review delivery correctness and security

- [x] Review `src/worker.ts`, `src/service.ts`, `src/send.ts`, `src/destination.ts` and `src/verify.ts` against the original scope and design document.
- [x] Add focused coverage for uncovered boundaries: expiry of the final allowed claim, competing replays, response-body truncation with invalid/multibyte UTF-8, DNS deadline and slow-drip responses, and real HTTPS hostname/certificate behavior.
- [x] Exercise an actual killed worker and temporary database failure, not only forced lease expiry in SQL.
- [x] Review lock ordering, pause/disable during in-flight work, subscription snapshot semantics and SQL row typing. Fix concrete findings without expanding v1 scope.

Completed 27 September 2026; findings, fixes and check results are in [verification.md](verification.md). Remaining known limitation: SQL rows are untyped `pg` results cast at the boundary (documented trade-off in design.md); no row-typing defect was found.

## 2. Verify the supported runtime and container matrix

- [x] Run the full suite under Node 24 (22 and local 26 have already run).
- [x] Build and smoke test a Linux arm64 image locally; verified under Docker Desktop emulation, not physical ARM hardware.
- [x] Re-run the README native and Compose quick starts from clean configuration, including key creation, real receiver delivery and persistence across restart.
- [x] Check database TLS with a controlled configuration and document any provider-specific setup.

Completed locally on 27 September 2026. Runtime versions, commands and limits are recorded in [verification](verification.md); provider deployment remains task 5.

## 3. Finish API presentation and reviewer documentation

- [x] Connect a browser, visually check Swagger UI, and capture a real screenshot under `docs/images/` for the README.
- [x] Walk through register → publish → inspect attempt → rotate → pause/resume → replay and document the commands.
- [x] Review the README and docs for consistency, especially at-least-once delivery, eight attempts versus five-failure pause, and the free demo's sleeping worker.

Completed locally on 27 September 2026 using connected Brave and native/Compose HTTP walkthroughs. See [walkthrough](walkthrough.md) and [verification](verification.md). The Credits paragraph is unchanged.

## 4. Create the public repository and verify CI — only when requested

- [x] Create public `code-kasha/webhook-delivery`, add the remote and push the reviewed local commit with authorization for that push.
- [x] Inspect actual GitHub Actions results (Node 22/24, PostgreSQL, container smoke, OpenAPI check); fix failures locally and request authorization for any additional push.
- [x] Add the working CI badge. Review permissions and secrets; no public admin key.

The [public repository](https://github.com/code-kasha/webhook-delivery) and [successful CI run](https://github.com/code-kasha/webhook-delivery/actions/runs/36322054815) were verified on 27 September 2026 for commit `961b3da`. Both Node versions passed all 85 tests; no fixes were needed. Akash separately authorized the badge/documentation push at `74bfac0`; its [CI run](https://github.com/code-kasha/webhook-delivery/actions/runs/36322213120) also passed.

## 5. Set up the controlled live demo — only when requested

- [x] Deploy on Render with a dedicated Neon database; verify TLS, migrations, readiness, restart recovery and a controlled fictional receiver.
- [x] Keep admin credentials private and avoid turning the demo into an unrestricted outbound-request service.
- [x] State the verified demo URL, sleeping-worker limitation and exact planned end date. Reconcile that date with the actual release in task 6.

Completed 28 September 2026 (IST), following deployment authorization. [Live Swagger](https://webhook-delivery-demo.onrender.com/docs), [configuration](deployment.md#render--neon-demo) and [observed results](verification.md#hosted-demo--28-september-2026-ist). Planned manual retirement is 28 December 2026; v1.0.0 has not been released.

## 6. Prepare and publish v1.0.0 — publication only when requested

- [ ] Complete tasks 1–5 and `docs/release.md`.
- [ ] Set version to `1.0.0` consistently in package, OpenAPI and sender user-agent; regenerate the schema and date the changelog.
- [ ] Run final checks, commit locally with the agent co-author trailer, then push/tag only on explicit request.
- [ ] Verify the actual amd64/arm64 GHCR manifests, package visibility, release notes and downloadable SHA256SUMS.
- [ ] Add real release/image links and the requested completed/not-actively-maintained status only after shipping.

**Done when:** all release artifacts can be downloaded and verified by a reviewer.

## 7. Update portfolio, profile and repository metadata — only when requested

- [ ] Read the portfolio's `agent-start.md`; update branch `v2` project data, 16:10 image, 2:1 cover and résumé highlights; run `pnpm resume` and check the two-project résumé selection.
- [ ] Update `../code-kasha` Featured Projects/write-up link and Latest Releases row.
- [ ] Set repository homepage/topics and upload the social preview through GitHub's web UI.

**Done when:** each separately authorized destination reflects the actual release and demo.

At the end of every task: record decisions, changed files, commands/results, commit hash, next task and blockers in the private handoff. Do not infer push/deployment authorization from earlier sessions.
