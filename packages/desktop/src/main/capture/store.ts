// In-memory authoritative capture store (Phase 1; SQLite persistence is a marked
// follow-on). Holds full records plus raw body bytes kept separately so the
// streamed record stays light and bodies are fetched on demand. No redaction.

import type {
  BodyData,
  BodyMeta,
  CaptureFilter,
  CaptureRecord,
  CaptureStreamEvent,
  HeaderPair,
  HttpSide,
} from "./types"

const MAX_TEXT_BYTES = 5 * 1024 * 1024

interface BodyBytes {
  request?: Buffer
  response?: Buffer
}

export interface RequestInput {
  id: string
  source: CaptureRecord["source"]
  tsRequest: number
  method: string
  url: string
  initiatorUrl?: string
  resourceType?: string
  requestHeaders: HeaderPair[]
  requestBodyBytes?: Buffer
}

export interface ResponseInput {
  tsResponse: number
  status?: number
  statusText?: string
  httpVersion?: string
  remoteIp?: string
  remotePort?: number
  responseHeaders?: HeaderPair[]
  responseBodyBytes?: Buffer
}

export class CaptureStore {
  private records = new Map<string, CaptureRecord>()
  private bodies = new Map<string, BodyBytes>()
  private seq = 0

  constructor(private readonly emit: (event: CaptureStreamEvent) => void) {}

  /** Inserts the request side of a capture and streams it. Returns the record. */
  insertRequest(input: RequestInput): CaptureRecord {
    const parts = splitUrl(input.url)
    const record: CaptureRecord = {
      id: input.id,
      seq: this.seq++,
      source: input.source,
      tsRequest: input.tsRequest,
      method: input.method,
      url: input.url,
      host: parts.host,
      path: parts.path,
      query: parts.query,
      scheme: parts.scheme,
      initiatorUrl: input.initiatorUrl,
      resourceType: input.resourceType,
      requestHeaders: input.requestHeaders,
      requestBody: meta(input.requestBodyBytes, contentTypeOf(input.requestHeaders)),
    }
    this.records.set(record.id, record)
    if (input.requestBodyBytes) this.bytes(record.id).request = input.requestBodyBytes
    this.emit({ type: "record", record })
    return record
  }

  /** Fills the response side of an existing capture and re-streams it. */
  finalizeResponse(id: string, input: ResponseInput): void {
    const record = this.records.get(id)
    if (!record) return
    record.tsResponse = input.tsResponse
    record.status = input.status
    record.statusText = input.statusText
    record.httpVersion = input.httpVersion
    record.remoteIp = input.remoteIp
    record.remotePort = input.remotePort
    record.responseHeaders = input.responseHeaders
    record.responseBody = meta(input.responseBodyBytes, contentTypeOf(input.responseHeaders))
    record.durationMs = input.tsResponse >= record.tsRequest ? input.tsResponse - record.tsRequest : undefined
    if (input.responseBodyBytes) this.bytes(id).response = input.responseBodyBytes
    this.emit({ type: "record", record })
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  getRecord(id: string): CaptureRecord | undefined {
    return this.records.get(id)
  }

  /** Full body bytes (base64) + decoded text when texty. */
  getBody(id: string, side: HttpSide): BodyData | undefined {
    const buf = side === "request" ? this.bytes(id).request : this.bytes(id).response
    if (!buf) return undefined
    const record = this.records.get(id)
    const ct = contentTypeOf(side === "request" ? record?.requestHeaders : record?.responseHeaders)
    const truncated = buf.length > MAX_TEXT_BYTES
    const slice = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf
    return {
      base64: slice.toString("base64"),
      size: buf.length,
      contentType: ct,
      text: isTexty(ct) ? slice.toString("utf8") : undefined,
      truncated: truncated || undefined,
    }
  }

  list(filter: CaptureFilter = {}): CaptureRecord[] {
    const q = filter.q?.trim().toLowerCase()
    let rows = [...this.records.values()]
    rows = rows.filter((r) => {
      if (filter.hosts?.length && !filter.hosts.includes(r.host)) return false
      if (filter.methods?.length && !filter.methods.includes(r.method)) return false
      if (filter.sources?.length && !filter.sources.includes(r.source)) return false
      if (filter.starred && !r.starred) return false
      if (filter.statusClasses?.length) {
        const cls = r.status ? `${Math.floor(r.status / 100)}xx` : ""
        if (!filter.statusClasses.includes(cls)) return false
      }
      if (q) {
        const hay = `${r.method} ${r.url} ${r.status ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    rows.sort((a, b) => b.seq - a.seq)
    return filter.limit ? rows.slice(0, filter.limit) : rows
  }

  star(id: string, on: boolean): void {
    const record = this.records.get(id)
    if (!record) return
    record.starred = on
    this.emit({ type: "record", record })
  }

  comment(id: string, text?: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.comment = text
    this.emit({ type: "record", record })
  }

  clear(): void {
    this.records.clear()
    this.bodies.clear()
    this.seq = 0
    this.emit({ type: "clear" })
  }

  private bytes(id: string): BodyBytes {
    let b = this.bodies.get(id)
    if (!b) {
      b = {}
      this.bodies.set(id, b)
    }
    return b
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function meta(bytes: Buffer | undefined, contentType?: string): BodyMeta | undefined {
  if (!bytes || bytes.length === 0) return undefined
  return { present: true, size: bytes.length, contentType }
}

export function splitUrl(raw: string): { host: string; path: string; query?: string; scheme: string } {
  try {
    const u = new URL(raw)
    return {
      host: u.host,
      path: u.pathname,
      query: u.search ? u.search.slice(1) : undefined,
      scheme: u.protocol.replace(/:$/, ""),
    }
  } catch {
    return { host: "", path: raw, scheme: "" }
  }
}

export function contentTypeOf(headers?: HeaderPair[]): string | undefined {
  if (!headers) return undefined
  const h = headers.find((p) => p.name.toLowerCase() === "content-type")
  return h?.value.split(";")[0]?.trim() || undefined
}

export function isTexty(contentType?: string): boolean {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  return (
    ct.includes("json") ||
    ct.includes("text") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("html") ||
    ct.includes("urlencoded")
  )
}
