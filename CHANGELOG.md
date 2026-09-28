# Changelog

## 1.0.0 — 2026-09-28

First release:

- Endpoint subscriptions, pause/resume and overlapping signing-secret rotation.
- Scoped API keys, idempotent event publishing and transactional fan-out.
- PostgreSQL delivery leases, retry jitter, failed queue and replay.
- Timestamped HMAC signatures, receiver helper and example.
- URL/DNS restrictions, pinned connections, response limits and deadlines.
- Attempt history, JSON logging, probes and graceful shutdown.
- Generated OpenAPI, Swagger UI, PostgreSQL tests and container/release workflows.

Review fixes before release:

- A claim could take over another worker's live lease when the claims raced, sending the delivery twice and recording it as `unknown`. Claims now re-check the lease after locking the endpoint.
- A database connection lost during a transaction could crash the process and hide the original error; broken connections are now discarded.
- Recording an outcome now retries through a brief database outage within the lease instead of falling back to crash recovery.
- IPv6 destinations must be in global unicast `2000::/3`; unallocated and IPv4-compatible hex forms such as `::a00:1` were accepted.
- Expiry of the final allowed claim now audits the resulting failure; the rotation overlap uses the database clock; AES-GCM tags must be 16 bytes.

Verified before release: 85 tests on Node 22 and 24 with PostgreSQL, container smoke checks, emulated arm64 execution, and controlled Render/Neon signed delivery and restart recovery. See `docs/verification.md` for evidence and limits.
