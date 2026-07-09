// node:sqlite driver — for the Electron desktop main (the capture WRITER).
// Electron 42 ships Node 24 with node:sqlite built in (verified: works, no flag).
// It's part of Node core, so it's always compiled against Electron's V8 — unlike
// native modules (better-sqlite3) which can't keep up with Electron's bleeding-edge
// V8. Produces standard SQLite files the bun:sqlite reader (mcp server) consumes.
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { SqliteCaptureStore } from "./store.js"
import { createSqliteStores } from "./persisted-stores.js"
import type { SqliteDriver } from "./driver.js"
import type { Stores } from "@morgana/web-core"

export function makeNodeDriver(dbPath: string): SqliteDriver {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  // Guard the raw connection before any statement runs (see bun.ts): the desktop writer
  // and the sidecar share this WAL file, so a startup statement racing a concurrent write
  // must wait out the lock rather than throw SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000")
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => void db.prepare(sql).run(...(params as never[])),
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: unknown[] = []) => (db.prepare(sql).get(...(params as never[])) ?? undefined) as T | undefined,
    close: () => db.close(),
  }
}

export function openNodeCaptureStore(dbPath: string): SqliteCaptureStore {
  return new SqliteCaptureStore(makeNodeDriver(dbPath), join(dirname(dbPath), "bodies"))
}

export function openNodeStores(dbPath: string): Stores {
  return createSqliteStores(makeNodeDriver(dbPath))
}
