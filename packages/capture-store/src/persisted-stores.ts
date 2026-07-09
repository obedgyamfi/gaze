// ── SQLite-backed evidence / finding / note stores ───────────────────────────
// Durable counterpart to web-core's in-memory createInMemoryStores. Records are
// JSON blobs keyed by id (small, structured) in the same engagement db as the
// captures, so findings/evidence survive restarts alongside proxy/repeater data.

import { observationId, summarizeCanvas, type CanvasRecord, type Finding, type Note, type Observation, type OracleEvidence, type Stores } from "@morgana/web-core"
import type { SqliteDriver } from "./driver.js"

export function createSqliteStores(db: SqliteDriver): Stores {
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, nodeId TEXT, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, json TEXT NOT NULL, updatedAt INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY, hosts TEXT NOT NULL)`)

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
    observations: {
      // Content-addressed id ⇒ INSERT OR REPLACE is idempotent (re-emit ≠ duplicate row).
      put: (o) => db.run(`INSERT OR REPLACE INTO observations (id, kind, json) VALUES (?, ?, ?)`, [observationId(o), o.kind, JSON.stringify(o)]),
      list: () => db.all<{ json: string }>(`SELECT json FROM observations`).map((r) => JSON.parse(r.json) as Observation),
    },
    scope: {
      // Single-row (id=1) host allow-list. Written by the desktop (node driver), read
      // LIVE by the mcp-web ScopeGuard (bun driver) on the same WAL file — so a scope
      // change in the UI reaches the discovery tools without restarting the MCP server.
      get: () => {
        const row = db.get<{ hosts: string }>(`SELECT hosts FROM scope WHERE id = 1`)
        if (!row) return []
        try {
          const parsed = JSON.parse(row.hosts)
          return Array.isArray(parsed) ? (parsed as string[]) : []
        } catch {
          return []
        }
      },
      set: (hosts) => {
        const clean = [...new Set(hosts.map((s) => s.trim()).filter(Boolean))]
        db.run(`INSERT OR REPLACE INTO scope (id, hosts) VALUES (1, ?)`, [JSON.stringify(clean)])
      },
    },
  }
}
