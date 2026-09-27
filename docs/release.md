# Release checklist

This is a public, unreleased project. Remote actions require Akash's explicit request in the current message; permission for one push does not cover a later push.

## Before v1.0.0

- Run lint, type-check, all tests on PostgreSQL, build, OpenAPI freshness and the running-container smoke test.
- Review crash/lease recovery, duplicate processing, DNS/IP checks, receiver verification and transaction boundaries. See [verification](verification.md) for what has actually run.
- Capture and inspect a real Swagger screenshot, add it to `docs/images/`, then reference it below the README links line.
- Set the package and OpenAPI version to `1.0.0`, update the sender user-agent, refresh the schema, and replace the Unreleased changelog heading with the actual release date. Do not fabricate release history.
- Confirm the repository remains MIT licensed and the final Credits paragraph is intact.
- When authorized, create the public `code-kasha/webhook-delivery` repository, push the reviewed commit, and inspect the actual GitHub Actions results. Add working CI/release/image badges only when the targets exist.
- On separate explicit authorization as needed, publish the version tag, verify both architectures' image manifests and release assets/checksums, and make the GHCR package public.
- Deploy and verify the controlled fictional Render/Neon demo when asked; disclose sleeping-worker limits and its actual end date, roughly three months after release. Add the working demo URL to the README.
- After the release is complete, set the README status to “complete as of v1.0.0 and not actively maintained” as requested by Akash.

## Akash's post-shipping tasks — do only when asked

1. **Portfolio:** read `../akash-damle-portfolio/agent-start.md`, use branch `v2`, add an entry to `lib/projects.ts` with problem, constraint, approach, outcome, stack, highlights, repository/demo URLs, a 16:10 image, a 2:1 cover and `resumeHighlights`; run `pnpm resume`. `ONE_PAGE_PROJECTS` in `scripts/build-resumes.mjs` selects the first two projects for the one-page résumé.
2. **GitHub profile:** update `../code-kasha` Featured Projects, include its write-up link, and add the release to the Latest Releases row.
3. **Repository settings:** set the demo homepage, add topics, and upload the 2:1 social preview cover through the GitHub web UI.

Keep `../webhook-delivery-notes/agent-start.md` current before ending a session. Do not copy that private handoff into this public repository.
