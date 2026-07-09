// bun:sqlite driver — for the opencode sidecar (the plugin's in-process reader/writer).
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { SqliteCaptureStore } from "./store.js"
import { createSqliteStores } from "./persisted-stores.js"
import type { SqliteDriver } from "./driver.js"
import type { Stores } from "@morgana/web-core"

export function makeBunDriver(dbPath: string): SqliteDriver {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  // Set the busy timeout on the RAW connection before any other statement runs. The
  // desktop (node:sqlite) and the sidecar (two bun:sqlite handles) all write this same
  // WAL file; without this, a startup CREATE TABLE that races a concurrent write throws
  // SQLITE_BUSY immediately — which, from `void main()`, becomes an opaque process exit
  // and the MCP client reports "-32000: Connection closed". Wait out the lock instead.
  db.run("PRAGMA busy_timeout = 5000")
  return {
    exec: (sql) => db.run(sql),
    run: (sql, params = []) => void db.query(sql).run(...(params as never[])),
    all: <T>(sql: string, params: unknown[] = []) => db.query(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: unknown[] = []) => (db.query(sql).get(...(params as never[])) ?? undefined) as T | undefined,
    close: () => db.close(),
  }
}

export function openBunCaptureStore(dbPath: string): SqliteCaptureStore {
  return new SqliteCaptureStore(makeBunDriver(dbPath), join(dirname(dbPath), "bodies"))
}

export function openBunStores(dbPath: string): Stores {
  return createSqliteStores(makeBunDriver(dbPath))
}
