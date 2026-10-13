# Database-wide clear command handoff

The database-wide `clear` command was removed from the v0.41.0 candidate. It is
an administrative destructive operation, has no mobile UX acceptance
criterion, and needs its own maintenance proposal and review.

The implementation that was reviewed during PR #40 is visible in commit
`b471e3c` in `server/admin.mjs`, `server/durable-store.mjs`, and
`server/admin.test.mjs`; it is not part of the current v0.41.0 working-tree
changes. Do not run it against a development or household database. Any future
reintroduction must use isolated temporary SQLite fixtures and separately
verify lock behavior, backup failure atomicity, WAL/integrity handling,
restore, and deletion scope before an authorized maintenance PR.

No database clearing command was executed as part of this review.
