// ── SqliteDriver — the runtime seam ───────────────────────────────────────────
// capture-store's logic is written against this tiny interface so the SAME store
// runs under two SQLite engines: bun:sqlite (the sidecar reader/writer) and
// node:sqlite (the Electron desktop writer). Both produce identical SQLite files,
// so the desktop writes and the sidecar reads the same db with WAL concurrency —
// no HTTP ingest route, no opencode-server changes.

export interface SqliteDriver {
  exec(sql: string): void
  run(sql: string, params?: unknown[]): void
  all<T>(sql: string, params?: unknown[]): T[]
  get<T>(sql: string, params?: unknown[]): T | undefined
  close(): void
}
