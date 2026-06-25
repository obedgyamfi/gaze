// ── SQLite-backed evidence / finding / note stores ───────────────────────────
// Durable counterpart to web-core's in-memory createInMemoryStores. Records are
// JSON blobs keyed by id (small, structured) in the same engagement db as the
// captures, so findings/evidence survive restarts alongside proxy/repeater data.

import { summarizeCanvas, type CanvasRecord, type Finding, type Note, type OracleEvidence, type Stores } from "@morgana/web-core"
import type { SqliteDriver } from "./driver.js"

export function createSqliteStores(db: SqliteDriver): Stores {
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, nodeId TEXT, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, json TEXT NOT NULL, updatedAt INTEGER NOT NULL)`)

  return {
    evidence: {
      put: (e) => db.run(`INSERT OR REPLACE INTO evidence (id, json) VALUES (?, ?)`, [e.id, JSON.stringify(e)]),
      get: (id) => {
        const row = db.get<{ json: string }>(`SELECT json FROM evidence WHERE id = ?`, [id])
        return row ? (JSON.parse(row.json) as OracleEvidence) : undefined
      },
      list: () => db.all<{ json: string }>(`SELECT json FROM evidence`).map((r) => JSON.parse(r.json) as OracleEvidence),
    },
    findings: {
      put: (f) => db.run(`INSERT OR REPLACE INTO findings (id, json) VALUES (?, ?)`, [f.id, JSON.stringify(f)]),
      get: (id) => {
        const row = db.get<{ json: string }>(`SELECT json FROM findings WHERE id = ?`, [id])
        return row ? (JSON.parse(row.json) as Finding) : undefined
      },
      list: () => db.all<{ json: string }>(`SELECT json FROM findings`).map((r) => JSON.parse(r.json) as Finding),
    },
    notes: {
      put: (n) => db.run(`INSERT OR REPLACE INTO notes (id, nodeId, json) VALUES (?, ?, ?)`, [n.id, n.nodeId ?? null, JSON.stringify(n)]),
      list: (nodeId) =>
        db
          .all<{ json: string }>(nodeId ? `SELECT json FROM notes WHERE nodeId = ?` : `SELECT json FROM notes`, nodeId ? [nodeId] : [])
          .map((r) => JSON.parse(r.json) as Note),
    },
    canvases: {
      put: (r) => db.run(`INSERT OR REPLACE INTO canvases (id, json, updatedAt) VALUES (?, ?, ?)`, [r.id, JSON.stringify(r), r.updatedAt]),
      get: (id) => {
        const row = db.get<{ json: string }>(`SELECT json FROM canvases WHERE id = ?`, [id])
        return row ? (JSON.parse(row.json) as CanvasRecord) : undefined
      },
      list: () => db.all<{ json: string }>(`SELECT json FROM canvases ORDER BY updatedAt DESC`).map((r) => summarizeCanvas(JSON.parse(r.json) as CanvasRecord)),
      remove: (id) => db.run(`DELETE FROM canvases WHERE id = ?`, [id]),
    },
  }
}
