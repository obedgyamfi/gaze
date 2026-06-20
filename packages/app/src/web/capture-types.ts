// Shared web-capture wire types — the single source of truth for the shapes that
// cross the Electron main ↔ renderer boundary. The desktop main capture code and
// the renderer's platform capability both import from here, so the contract never
// drifts. No redaction: full request/response headers and bodies are represented.

export type HttpSide = "request" | "response"

export type CaptureSource = "browser" | "repeater"

export interface HeaderPair {
  name: string
  value: string
}

/** A single JS call frame from a request's initiator stack. */
export interface InitiatorFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

/** Where a request came from (CDP Network.Initiator), kept verbatim for analysis. */
export interface RequestInitiator {
  /** parser | script | preload | preflight | SignedExchange | other */
  type: string
  /** Document / script URL that initiated the request (parser & script types). */
  url?: string
  lineNumber?: number
  columnNumber?: number
  /** Top JS call frames for script-initiated requests. */
  stack?: InitiatorFrame[]
}

/** Body metadata carried on the streamed record; bytes are fetched on demand. */
export interface BodyMeta {
  present: boolean
  size: number
  contentType?: string
  truncated?: boolean
}

/** Full body payload returned by capture.getBody. */
export interface BodyData {
  base64: string
  size: number
  contentType?: string
  text?: string
  truncated?: boolean
}

export interface CaptureRecord {
  id: string
  seq: number
  source: CaptureSource

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

export type CaptureStreamEvent =
  | { type: "record"; record: CaptureRecord }
  | { type: "nav"; nav: NavRecord }
  | { type: "form"; form: FormRecord }
  | { type: "clear" }

export interface CaptureFilter {
  hosts?: string[]
  methods?: string[]
  statusClasses?: string[]
  sources?: CaptureSource[]
  q?: string
  starred?: boolean
  limit?: number
}

export interface RepeaterRequest {
  method: string
  url: string
  headers: HeaderPair[]
  body?: string
}

/** Desktop-only platform capability for driving capture + repeater. All operations
 *  are scoped to a workspace (project directory) — each has its own browser + db. */
export interface CapturePlatform {
  /** Stream live capture events, each tagged with the workspace it belongs to. */
  subscribe(cb: (projectDir: string, event: CaptureStreamEvent) => void): () => void
  list(projectDir: string, filter?: CaptureFilter): Promise<CaptureRecord[]>
  /** Load a workspace's persisted captures (restores graph/proxy state on open). */
  load(projectDir: string): Promise<{ records: CaptureRecord[]; navs: NavRecord[]; forms: FormRecord[] }>
  getBody(id: string, side: HttpSide, projectDir: string): Promise<BodyData | null>
  clear(projectDir: string): Promise<void>
  star(projectDir: string, id: string, on: boolean): Promise<void>
  comment(projectDir: string, id: string, text?: string): Promise<void>
  repeaterSend(projectDir: string, req: RepeaterRequest): Promise<CaptureRecord>
}
