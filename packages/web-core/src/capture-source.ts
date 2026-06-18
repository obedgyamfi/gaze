// ── CaptureSource — the seam between the toolset and host capture data ────────
// web-core is host-agnostic, so it owns the canonical capture contract and never
// imports a host's types. Each host (opencode desktop main, a test fixture, the
// MCP server) implements CaptureSource to feed real records in. This is also the
// boundary that resolves the sidecar↔Electron-main process split: whoever holds
// the captures implements this; web-core just consumes it.

export type HttpSide = "request" | "response"
export type CaptureRecordSource = "browser" | "repeater"

export interface HeaderPair {
  name: string
  value: string
}

export interface RequestInitiator {
  type: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

export interface BodyMeta {
  present: boolean
  size: number
  contentType?: string
  truncated?: boolean
}

export interface BodyData {
  base64: string
  size: number
  contentType?: string
  text?: string
  truncated?: boolean
}

/** Mirrors opencode's CaptureRecord (packages/app/src/web/capture-types.ts). Owned
 *  here so web-core stays host-agnostic; host adapters map their record → this. */
export interface CaptureRecord {
  id: string
  seq: number
  source: CaptureRecordSource
  tsRequest: number
  method: string
  url: string
  host: string
  path: string
  query?: string
  scheme: string
  initiatorUrl?: string
  initiator?: RequestInitiator
  resourceType?: string
  requestHeaders: HeaderPair[]
  requestBody?: BodyMeta
  tsResponse?: number
  status?: number
  statusText?: string
  httpVersion?: string
  remoteIp?: string
  remotePort?: number
  responseHeaders?: HeaderPair[]
  responseBody?: BodyMeta
  durationMs?: number
  starred?: boolean
  comment?: string
}

export interface NavRecord {
  ts: number
  url: string
  frameId?: string
  initiatorUrl?: string
}

export interface FormRecord {
  ts: number
  pageUrl: string
  action: string
  method: string
  inputs: string[]
}

export interface CaptureFilter {
  hosts?: string[]
  methods?: string[]
  statusClasses?: string[]
  sources?: CaptureRecordSource[]
  q?: string
  starred?: boolean
  limit?: number
}

/** What web-core needs from a host to build graphs and serve evidence. */
export interface CaptureSource {
  list(filter?: CaptureFilter): Promise<CaptureRecord[]>
  getBody(id: string, side: HttpSide): Promise<BodyData | null>
  navs?(): Promise<NavRecord[]>
  forms?(): Promise<FormRecord[]>
  /** Monotonic version/watermark so the store can cache and detect staleness. */
  version?(): Promise<number>
}

/** The write side — lets the firing capability persist replay/repeater results as
 *  captures. SqliteCaptureStore implements both CaptureSource and CaptureSink. */
export interface CaptureSink {
  putRecord(r: CaptureRecord): void
  putBody(id: string, side: HttpSide, bytes: Uint8Array, contentType?: string): void
}

/** Lowercase a HeaderPair[] into a single-valued map for heuristics. */
export function headerMap(pairs: HeaderPair[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) out[p.name.toLowerCase()] = p.value
  return out
}
