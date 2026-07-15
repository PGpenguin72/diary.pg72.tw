# AGENT.md

Instructions for coding agents working in this repository.

## Start here

1. Read `README.md` before planning or editing.
2. Treat `README.md` as the product and architecture source of truth.
3. Inspect the current code, tests, migrations, and git status before making changes.
4. Keep changes scoped to the requested phase. Do not build later roadmap items unless required by the current task.
5. When an implementation decision changes the architecture, data model, privacy model, import behavior, or user workflow, update `README.md` in the same change.

The project is under active development. The target interface language is Traditional Chinese (`zh-TW`), while code identifiers, database names, API fields, and concise technical comments should use English.

## Repository commands

```bash
pnpm install
pnpm run db:migrate:local
pnpm run db:seed:local
pnpm dev
pnpm run check
pnpm test
pnpm run test:e2e
pnpm build
```

`pnpm run typecheck` regenerates `worker-configuration.d.ts` with `wrangler types` before TypeScript runs. Do not hand-write the `Env` interface. Browser tests use synthetic local data and must not leave new entries in the persistent local D1 state.

Remote reads and writes require a validated PG72 ID (`sso.pg72.tw`) OIDC session whose `sub` matches the configured owner allowlist. Do not weaken this to a client-provided email, a spoofable header, or a hostname-only production allow rule. The only hostname exemption is the explicit localhost development bypass (`localhost` / `127.0.0.1` / `[::1]`).

## Non-negotiable architecture

- Deploy the full-stack app on Cloudflare Workers with Static Assets.
- Store structured journal data in D1.
- Store photos, videos, audio, drawings, thumbnails, and raw import artifacts in a private R2 bucket.
- Git stores application code, migrations, documentation, and synthetic fixtures only.
- Creating or importing a journal entry must never require a Git commit or deployment.
- Use GitHub-triggered Workers Builds for code deployment.
- Keep local, preview, and production D1/R2 resources separate. Never bind preview code to production journal data.

Do not move media into D1, the frontend bundle, Pages/Workers static assets, or Git LFS. Do not make the R2 bucket public to simplify media rendering.

## Privacy and security

This application handles highly sensitive personal data. Privacy is a correctness requirement, not a later hardening task.

- Protect every app and API route with the chosen authentication boundary. For the single-user MVP, this is PG72 ID (self-hosted OIDC at `sso.pg72.tw`) with an exact owner `sub` allowlist and a server-side RP session in D1.
- Validate the OIDC assertion server-side (Authorization Code + PKCE, EdDSA ID token signature against the issuer JWKS, nonce, single-use transaction). Never trust a client-provided email, a bearer value in localStorage, or a hidden UI state as authorization.
- Keep R2 private. Use an authenticated Worker read or a short-lived, object-scoped presigned URL.
- Restrict upload authorization by object key, method, MIME type, expected size, expiry, and allowed CORS origin.
- Treat presigned URLs as secrets. Do not log or persist them.
- Never log entry text, titles, raw filenames, transcripts, coordinates, media bytes, auth headers, cookies, ZIP contents, or decrypted content.
- Use opaque IDs and content hashes in operational logs. Error messages shown to users may identify an item locally but must not leak it to remote telemetry.
- Do not commit real Apple Journal exports or user media. Tests must use synthetic fixtures with no personal metadata.
- Validate uploaded content by signature/sniffing as well as extension and declared MIME type.
- Protect state-changing endpoints against cross-origin requests and replay where applicable.
- Do not describe Cloudflare-managed encryption at rest as end-to-end encryption. If client-side encryption is introduced, document the key lifecycle, recovery model, leaked metadata, and disabled server-side features first.
- Any sharing feature is out of scope until it has a separate threat model and explicit user approval.

## Apple Journal importer

Apple does not publish a guaranteed stable schema for `AppleJournalEntries` ZIP files. The importer must be fixture-driven, tolerant of known format variants, and conservative with unknown data.

Required behavior:

- Parse archives incrementally. Never buffer the entire ZIP or a large media file in browser or Worker memory.
- Large media uploads go directly to R2. Use multipart upload when appropriate.
- Make imports resumable and idempotent.
- Prefer a stable source ID from Apple. When unavailable, derive a deterministic SHA-256 from canonical source fields.
- Enforce uniqueness for source entries and media hashes.
- Commit each normalized entry independently so one bad attachment does not roll back the whole import.
- Preserve unknown source fields in a versioned raw metadata object when safe, so a future parser can recover data without re-exporting.
- Produce a reconciliation report with source entries, source attachments, inserted, duplicate, skipped, warning, and failed counts.
- A partially imported entry must have an explicit state; it must never look silently complete.

Archive defenses are mandatory: reject path traversal, absolute paths, symlink surprises, unsupported encryption, suspicious compression ratios, unbounded entry counts, excessive uncompressed size, invalid MIME signatures, duplicate conflicting paths, and malformed timestamps.

Every supported Apple export variant needs a synthetic fixture and regression test. If a real export reveals a new variant, reduce it to the smallest non-private fixture before adding it to the repository.

## Data model rules

- Store timestamps in UTC and preserve the entry's original IANA time zone and local calendar date.
- Compute streaks and total journal days from local dates, never UTC dates.
- Keep ordered content in `entry_blocks`; do not serialize an arbitrarily large whole entry into one D1 row.
- Media metadata lives in D1; media bytes live in R2.
- Use content-addressed media hashes for deduplication, but do not expose hashes as public authorization.
- Add indexes for every production list/filter/join path. Check query plans for timeline, calendar, search, tags, locations, and import deduplication.
- Keep derived fields such as word count and daily statistics rebuildable from canonical entries.
- FTS5 is a derived search index. Backups must be able to recreate it because D1 exports do not export virtual tables.
- Use forward-only, reviewed migrations. A migration that transforms or deletes user content must have a tested backup and recovery path.
- Soft deletion and final R2 cleanup must be explicit. Do not orphan objects or delete shared deduplicated media while references remain.

## API and upload rules

- Validate every request and response boundary with a schema.
- Use bounded pagination; never return the full journal in a normal list endpoint.
- Avoid N+1 D1 queries and unindexed full-table scans.
- Use transactions or D1 batches where atomicity matters, while respecting D1 statement and parameter limits.
- Return stable machine-readable error codes plus user-safe messages.
- Make retryable operations idempotent with operation/import IDs.
- Stream large request and response bodies. A Worker isolate has limited memory.
- Do not proxy large browser uploads through the Worker when direct private R2 upload is available.
- Generate thumbnails/preview metadata without overwriting originals. Original media is immutable after successful import unless the user explicitly replaces it.

## Frontend and interaction rules

- The first authenticated screen is the actual Overview/Timeline, not a landing page.
- The product should feel like a private journal, not an admin dashboard or generic SaaS template.
- Preserve chronological and semantic reading order even when using masonry/editorial layouts.
- Dynamic layouts must be deterministic. Persist a layout seed or preset so refreshes do not rearrange memories.
- Reserve large type for entry titles or meaningful date transitions. Keep controls and statistics compact and scannable.
- Use fixed dimensions, aspect ratios, and placeholders for media to prevent layout shifts.
- Provide explicit loading, empty, offline, upload, processing, partial failure, retry, and completed states.
- Upload UI must show per-file and overall progress, allow cancellation, and explain which items failed.
- Use familiar icons with tooltips for icon-only controls. Maintain keyboard access and visible focus.
- Test narrow iPhone and desktop viewports. Text, controls, media, and overlays must not overlap.
- Respect reduced motion. Animation may communicate time and continuity but must not block reading or input.
- Do not expose private media through public image optimization URLs or third-party analytics.

## Statistics definitions

Keep definitions centralized and covered by tests.

- `total_entries`: non-deleted, non-draft entries unless the UI explicitly says otherwise.
- `total_days`: distinct entry local dates.
- `current_streak`: consecutive local dates ending today, or yesterday when today has no entry yet.
- `longest_streak`: longest consecutive sequence of entry local dates.
- `word_count`: locale-aware segmentation using the project's single canonical implementation.
- Media counts: count logical media records referenced by entries; storage totals count unique R2 objects.

Imported and newly written entries must use the same counting code. A rebuild must reproduce stored aggregate values.

## Testing expectations

Scale tests with risk, but do not skip tests for privacy, import, or destructive data changes.

Minimum coverage:

- Unit tests for normalization, canonical hashes, date/time-zone handling, word counts, streaks, layout selection, and archive safety checks.
- Import regression tests for every synthetic Apple Journal fixture and malformed archive case.
- D1 integration tests for migrations, indexes, idempotent imports, media reference counting, FTS synchronization, pagination, and soft/final deletion.
- R2 integration tests for authorized upload, invalid MIME/size, multipart retry, private reads, and cleanup.
- End-to-end tests for login boundary, import/resume/re-import, entry editing, online media upload, search, overview statistics, export, and deletion recovery.
- Playwright screenshots at representative iPhone and desktop sizes for Overview, Timeline, entry detail, editor, and import progress/failure states.
- Performance fixture with at least 10,000 entries and enough media metadata to reveal unbounded queries or unstable layout.

Tests and snapshots must never contain production data.

## Work sequence

For each implementation task:

1. Confirm the requested roadmap phase and acceptance criteria in `README.md`.
2. Inspect relevant code, schemas, migrations, tests, and current uncommitted changes.
3. State assumptions that affect data compatibility, privacy, cost, or user-visible behavior.
4. Implement the smallest coherent change using existing repository patterns.
5. Add or update tests proportional to risk.
6. Run formatting, type checks, focused tests, full tests when shared behavior changes, and a production build.
7. For UI work, run the local app and visually verify iPhone and desktop states with Playwright.
8. Review the diff for secrets, personal data, accidental public R2 access, migration hazards, and unrelated churn.
9. Update `README.md` when behavior or decisions changed.

Do not silently work around a failing migration, parser mismatch, lost attachment, authorization uncertainty, or production-data risk. Stop the affected operation, preserve diagnostic identifiers without content, and surface the problem clearly.

## Definition of done

A change is done only when:

- The requested workflow works end to end, including failure and retry states.
- Privacy boundaries remain intact.
- Data mutations are idempotent or have explicit conflict behavior.
- Relevant tests pass and the app builds.
- User-facing UI has been checked at mobile and desktop sizes when applicable.
- No real diary data or secrets appear in source, fixtures, logs, screenshots, or build output.
- Documentation reflects any new constraint or architectural decision.
