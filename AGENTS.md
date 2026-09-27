# Working rules

Read ../webhook-delivery-notes/agent-start.md before working; update it before ending a session. It is private and must stay outside this repository.

- Local commits only. Push, repository creation, PRs, deployment and publishing require Akash's explicit request in the current message.
- End commits with the writing agent's Co-Authored-By trailer.
- Strict TypeScript; Zod is the API contract source. Run lint, typecheck, PostgreSQL tests, build, schema freshness and the container smoke test before claiming they pass.
- Mutations and audit/attempt records commit atomically. Network I/O never runs inside a database transaction.
- Preserve SSRF resolution/pinning, bounded I/O, no redirects, lease fencing, scoped API keys and encrypted signing secrets.
- Fictional sample data only. No unverifiable claims, estimated test counts or premature release/completion badges.
- LF line endings. No secrets, generated build output or private notes in Git.
