// ── SqliteCaptureStore — durable capture persistence over a SqliteDriver ──────
// Runtime-agnostic: the driver is bun:sqlite (sidecar) or node:sqlite (desktop).
// The attack-surface graph is derived from these rows, so this is the single
// durable source for proxy/repeater/graph request data. See ./driver for the why.
//
// Bodies are hybrid-stored by content hash: inline BLOB when small, spilled to a
// file when large (SQLite is faster <~100KB; the filesystem for larger). `q` is
// LIKE for v1 (FTS5 is a drop-in upgrade).

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  BodyData,
  CaptureFilter,
  CaptureRecord,
  CaptureSource,
  FormRecord,
  HeaderPair,
  HttpSide,
  NavRecord,
  RequestInitiator,
} from "@morgana/web-core"
import type { SqliteDriver } from "./driver.js"

const INLINE_BODY_MAX = 128 * 1024
const MAX_TEXT_BYTES = 5 * 1024 * 1024

interface CaptureRow {
  id: string
  seq: number
  source: string
  tsRequest: number
  method: string
  url: string
  host: string
  path: string
  query: string | null
  scheme: string
  initiatorUrl: string | null
  initiator: string | null
  resourceType: string | null
  requestHeaders: string
  requestBody: string | null
  tsResponse: number | null
  status: number | null
  statusText: string | null
  httpVersion: string | null
  remoteIp: string | null
  remotePort: number | null
  responseHeaders: string | null
  responseBody: string | null
  durationMs: number | null
  starred: number
  comment: string | null
}

export class SqliteCaptureStore implements CaptureSource {
  constructor(
    private readonly db: SqliteDriver,
    private readonly bodiesDir: string,
  ) {
    mkdirSync(this.bodiesDir, { recursive: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA page_size = 8192")
    this.db.exec("PRAGMA busy_timeout = 5000") // desktop writer + sidecar writer share this file
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, source TEXT NOT NULL,
      tsRequest INTEGER NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL,
      host TEXT NOT NULL, path TEXT NOT NULL, query TEXT, scheme TEXT NOT NULL,
      initiatorUrl TEXT, initiator TEXT, resourceType TEXT,
      requestHeaders TEXT NOT NULL, requestBody TEXT,
      tsResponse INTEGER, status INTEGER, statusText TEXT, httpVersion TEXT,
      remoteIp TEXT, remotePort INTEGER, responseHeaders TEXT, responseBody TEXT,
      durationMs INTEGER, starred INTEGER NOT NULL DEFAULT 0, comment TEXT
    )`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS captures_seq ON captures(seq)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS captures_host ON captures(host)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS captures_status ON captures(status)`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS bodies (
      id TEXT NOT NULL, side TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
      contentType TEXT, bytes BLOB, spill TEXT, PRIMARY KEY (id, side)
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS navs (ts INTEGER NOT NULL, url TEXT NOT NULL, frameId TEXT, initiatorUrl TEXT)`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS forms (ts INTEGER NOT NULL, pageUrl TEXT NOT NULL, action TEXT NOT NULL, method TEXT NOT NULL, inputs TEXT NOT NULL)`)
  }

  // ── ingest (write) ──────────────────────────────────────────────────────────
  putRecord(r: CaptureRecord): void {
    this.db.run(
      `INSERT INTO captures (id, seq, source, tsRequest, method, url, host, path, query, scheme, initiatorUrl, initiator, resourceType, requestHeaders, requestBody, tsResponse, status, statusText, httpVersion, remoteIp, remotePort, responseHeaders, responseBody, durationMs, starred, comment)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         tsResponse=excluded.tsResponse, status=excluded.status, statusText=excluded.statusText,
         httpVersion=excluded.httpVersion, remoteIp=excluded.remoteIp, remotePort=excluded.remotePort,
         responseHeaders=excluded.responseHeaders, responseBody=excluded.responseBody,
         durationMs=excluded.durationMs, requestHeaders=excluded.requestHeaders,
         requestBody=excluded.requestBody, starred=excluded.starred, comment=excluded.comment`,
      [
        r.id, r.seq, r.source, r.tsRequest, r.method, r.url, r.host, r.path, r.query ?? null, r.scheme,
        r.initiatorUrl ?? null, r.initiator ? JSON.stringify(r.initiator) : null, r.resourceType ?? null,
        JSON.stringify(r.requestHeaders), r.requestBody ? JSON.stringify(r.requestBody) : null,
        r.tsResponse ?? null, r.status ?? null, r.statusText ?? null, r.httpVersion ?? null,
        r.remoteIp ?? null, r.remotePort ?? null, r.responseHeaders ? JSON.stringify(r.responseHeaders) : null,
        r.responseBody ? JSON.stringify(r.responseBody) : null, r.durationMs ?? null, r.starred ? 1 : 0, r.comment ?? null,
      ],
    )
  }

  putBody(id: string, side: HttpSide, bytes: Uint8Array, contentType?: string): void {
    const hash = createHash("sha256").update(bytes).digest("hex")
    const size = bytes.length
    if (size > INLINE_BODY_MAX) {
      const file = join(this.bodiesDir, `${hash}.bin`)
      if (!existsSync(file)) writeFileSync(file, bytes)
      this.db.run(`INSERT OR REPLACE INTO bodies (id, side, hash, size, contentType, bytes, spill) VALUES (?,?,?,?,?,NULL,?)`, [id, side, hash, size, contentType ?? null, `${hash}.bin`])
    } else {
      this.db.run(`INSERT OR REPLACE INTO bodies (id, side, hash, size, contentType, bytes, spill) VALUES (?,?,?,?,?,?,NULL)`, [id, side, hash, size, contentType ?? null, bytes])
    }
  }

  putNav(n: NavRecord): void {
    this.db.run(`INSERT INTO navs (ts, url, frameId, initiatorUrl) VALUES (?,?,?,?)`, [n.ts, n.url, n.frameId ?? null, n.initiatorUrl ?? null])
  }
  putForm(f: FormRecord): void {
    this.db.run(`INSERT INTO forms (ts, pageUrl, action, method, inputs) VALUES (?,?,?,?,?)`, [f.ts, f.pageUrl, f.action, f.method, JSON.stringify(f.inputs)])
  }

  clear(): void {
    this.db.exec("DELETE FROM captures")
    this.db.exec("DELETE FROM bodies")
    this.db.exec("DELETE FROM navs")
    this.db.exec("DELETE FROM forms")
    rmSync(this.bodiesDir, { recursive: true, force: true })
    mkdirSync(this.bodiesDir, { recursive: true })
  }

  close(): void {
    this.db.close()
  }

  // ── CaptureSource (read) ──────────────────────────────────────────────────────
  async list(filter: CaptureFilter = {}): Promise<CaptureRecord[]> {
    const rows = this.db.all<CaptureRow>(`SELECT * FROM captures ORDER BY seq DESC`)
    const q = filter.q?.trim().toLowerCase()
    let out = rows.map(rowToRecord).filter((r) => {
      if (filter.hosts?.length && !filter.hosts.includes(r.host)) return false
      if (filter.methods?.length && !filter.methods.includes(r.method)) return false
      if (filter.sources?.length && !filter.sources.includes(r.source)) return false
      if (filter.starred && !r.starred) return false
      if (filter.statusClasses?.length) {
        const cls = r.status ? `${Math.floor(r.status / 100)}xx` : ""
        if (!filter.statusClasses.includes(cls)) return false
      }
      if (q && !`${r.method} ${r.url} ${r.status ?? ""}`.toLowerCase().includes(q)) return false
      return true
    })
    if (filter.limit) out = out.slice(0, filter.limit)
    return out
  }

  async getBody(id: string, side: HttpSide): Promise<BodyData | null> {
    const row = this.db.get<{ size: number; contentType: string | null; bytes: Uint8Array | null; spill: string | null }>(
      `SELECT size, contentType, bytes, spill FROM bodies WHERE id = ? AND side = ?`,
      [id, side],
    )
    if (!row) return null
    const buf = row.spill ? readFileSync(join(this.bodiesDir, row.spill)) : Buffer.from(row.bytes ?? new Uint8Array())
    const truncated = buf.length > MAX_TEXT_BYTES
    const slice = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf
    const ct = row.contentType ?? undefined
    return {
      base64: Buffer.from(slice).toString("base64"),
      size: row.size,
      contentType: ct,
      text: isTexty(ct) ? Buffer.from(slice).toString("utf8") : undefined,
      truncated: truncated || undefined,
    }
  }

  async navs(): Promise<NavRecord[]> {
    return this.db
      .all<{ ts: number; url: string; frameId: string | null; initiatorUrl: string | null }>(`SELECT ts, url, frameId, initiatorUrl FROM navs ORDER BY ts ASC`)
      .map((n) => ({ ts: n.ts, url: n.url, frameId: n.frameId ?? undefined, initiatorUrl: n.initiatorUrl ?? undefined }))
  }
  async forms(): Promise<FormRecord[]> {
    return this.db
      .all<{ ts: number; pageUrl: string; action: string; method: string; inputs: string }>(`SELECT ts, pageUrl, action, method, inputs FROM forms ORDER BY ts ASC`)
      .map((f) => ({ ts: f.ts, pageUrl: f.pageUrl, action: f.action, method: f.method, inputs: JSON.parse(f.inputs) as string[] }))
  }
  async version(): Promise<number> {
    return this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM captures`)?.c ?? 0
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function parseJson<T>(s: string | null): T | undefined {
  if (s == null) return undefined
  try {
    return JSON.parse(s) as T
  } catch {
    return undefined
  }
}

function rowToRecord(r: CaptureRow): CaptureRecord {
  return {
    id: r.id,
    seq: Number(r.seq),
    source: r.source as CaptureRecord["source"],
    tsRequest: Number(r.tsRequest),
    method: r.method,
    url: r.url,
    host: r.host,
    path: r.path,
    query: r.query ?? undefined,
    scheme: r.scheme,
    initiatorUrl: r.initiatorUrl ?? undefined,
    initiator: parseJson<RequestInitiator>(r.initiator),
    resourceType: r.resourceType ?? undefined,
    requestHeaders: parseJson<HeaderPair[]>(r.requestHeaders) ?? [],
    requestBody: parseJson(r.requestBody),
    tsResponse: r.tsResponse == null ? undefined : Number(r.tsResponse),
    status: r.status == null ? undefined : Number(r.status),
    statusText: r.statusText ?? undefined,
    httpVersion: r.httpVersion ?? undefined,
    remoteIp: r.remoteIp ?? undefined,
    remotePort: r.remotePort == null ? undefined : Number(r.remotePort),
    responseHeaders: parseJson<HeaderPair[]>(r.responseHeaders),
    responseBody: parseJson(r.responseBody),
    durationMs: r.durationMs == null ? undefined : Number(r.durationMs),
    starred: Number(r.starred) === 1,
    comment: r.comment ?? undefined,
  }
}

function isTexty(contentType?: string): boolean {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  return ct.includes("json") || ct.includes("text") || ct.includes("xml") || ct.includes("javascript") || ct.includes("html") || ct.includes("urlencoded")
}
