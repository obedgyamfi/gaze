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
