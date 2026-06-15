// Capture client — attaches to the operator's Chromium over CDP (flatten-mode
// auto-attach covers every tab/subframe), translates Network + Page events into
// CaptureRecords, and feeds the store. Mirrors the gaze capture logic; redesigned
// for Electron/TS with no tab polling and no redaction.

import zlib from "node:zlib"
import { CdpConnection } from "./cdp"
import { CaptureStore } from "./store"
import type { CaptureStreamEvent, HeaderPair, RequestInitiator } from "./types"

const FORM_SCAN_JS = `
Array.from(document.querySelectorAll('form')).map(f => ({
  action: f.getAttribute('action') || '',
  method: (f.getAttribute('method') || 'GET').toUpperCase(),
  inputs: Array.from(f.querySelectorAll('input,select,textarea'))
    .map(i => i.getAttribute('name') || i.getAttribute('id') || '')
    .filter(Boolean),
}))
`

interface ResponseMeta {
  status?: number
  statusText?: string
  httpVersion?: string
  remoteIp?: string
  remotePort?: number
  headers?: HeaderPair[]
}

interface SessionState {
  currentUrl?: string
  /** Set once a real page load begins; before that we ignore new-tab/blank noise. */
  armed: boolean
  /** requestId → current record id (advances across redirects). */
  recordIds: Map<string, string>
  /** requestId → redirect leg index. */
  legs: Map<string, number>
  /** requestId → response metadata awaiting loadingFinished. */
  responses: Map<string, ResponseMeta>
  // The complete on-the-wire headers (Cookie, Authorization, …) arrive separately
  // via *ExtraInfo, in no guaranteed order relative to requestWillBeSent and once
  // per redirect leg (legs share a requestId). Queue both directions so a leg's
  // extra-info is paired with the right record whichever arrives first.
  /** requestId → wire request headers buffered until their request leg appears. */
  reqExtra: Map<string, HeaderPair[][]>
  /** requestId → record ids whose request leg is awaiting its wire headers. */
  reqAwait: Map<string, string[]>
  /** requestId → raw response headers per leg, applied at finalize. */
  respExtra: Map<string, HeaderPair[][]>
}

export class CaptureClient {
  private connection: CdpConnection | undefined
  private sessions = new Map<string, SessionState>()
  private abort = new AbortController()
  private stopped = false
  private navigateTo: string | undefined
  private navigated = false

  constructor(
    private readonly store: CaptureStore,
    private readonly emit: (event: CaptureStreamEvent) => void,
  ) {}

  async start(port: number, navigateTo?: string): Promise<void> {
    this.navigateTo = navigateTo
    const connection = await CdpConnection.connect(port, this.abort.signal)
    if (this.stopped) {
      connection.close()
      return
    }
    this.connection = connection

    connection.on("Target.attachedToTarget", (params, _sessionId) => {
      void this.onAttached(params)
    })
    connection.on("Target.detachedFromTarget", (params) => {
      const sid = params.sessionId as string | undefined
      if (sid) this.sessions.delete(sid)
    })
    connection.on("Network.requestWillBeSent", (params, sid) => this.onRequest(params, sid))
    connection.on("Network.requestWillBeSentExtraInfo", (params, sid) => this.onRequestExtra(params, sid))
    connection.on("Network.responseReceived", (params, sid) => this.onResponse(params, sid))
    connection.on("Network.responseReceivedExtraInfo", (params, sid) => this.onResponseExtra(params, sid))
    connection.on("Network.loadingFinished", (params, sid) => void this.onFinished(params, sid))
    connection.on("Network.loadingFailed", (params, sid) => this.onFailed(params, sid))
    connection.on("Page.frameNavigated", (params, sid) => void this.onNavigated(params, sid))

    // Flatten auto-attach: every existing and future page/worker target attaches
    // to this one connection and reports a sessionId on its events.
    await connection.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
  }

  stop(): void {
    this.stopped = true
    this.abort.abort()
    this.connection?.close()
    this.connection = undefined
    this.sessions.clear()
  }

  // ── target lifecycle ─────────────────────────────────────────────────────────

  private async onAttached(params: any): Promise<void> {
    const sessionId: string | undefined = params.sessionId
    const type: string | undefined = params.targetInfo?.type
    if (!sessionId || !this.connection) return
    if (type !== "page" && type !== "iframe") return

    this.sessions.set(sessionId, {
      currentUrl: params.targetInfo?.url || undefined,
      armed: false,
      recordIds: new Map(),
      legs: new Map(),
      responses: new Map(),
      reqExtra: new Map(),
      reqAwait: new Map(),
      respExtra: new Map(),
    })

    const c = this.connection
    await Promise.allSettled([
      c.send("Network.enable", { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 20_000_000 }, sessionId),
      c.send("Page.enable", {}, sessionId),
      c.send("Runtime.enable", {}, sessionId),
      // Recurse into this target's own children (OOP subframes, workers).
      c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
    ])

    // Navigate to the requested target only now that Network is live, so the
    // initial page load is captured. First page target wins.
    if (type === "page" && this.navigateTo && !this.navigated) {
      this.navigated = true
      await c.send("Page.navigate", { url: this.navigateTo }, sessionId).catch(() => {
        this.navigated = false
      })
    }
  }

  // ── network ──────────────────────────────────────────────────────────────────

  private onRequest(params: any, sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session || !sessionId) return
    // Record only once a real page load has begun. The first top-level Document
    // request to an http(s) URL arms the session; before that (new-tab page,
    // about:blank) we ignore the noise. Once armed, everything the page does is
    // captured — including ws/wss and other schemes — so capture isn't limited.
    if (!session.armed) {
      if (params.type === "Document" && isCapturableUrl(params.request?.url)) session.armed = true
      else return
    }
    const requestId: string = params.requestId

    // A redirect reuses the requestId and carries the prior response — finalize
    // the previous leg, then start a new one for the redirected request.
    if (params.redirectResponse) {
      const prevId = session.recordIds.get(requestId)
      if (prevId) {
        const extra = shiftQueue(session.respExtra, requestId)
        this.store.finalizeResponse(prevId, {
          tsResponse: Date.now(),
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText || undefined,
          httpVersion: params.redirectResponse.protocol || undefined,
          responseHeaders: extra ?? headersToPairs(params.redirectResponse.headers),
        })
      }
      session.legs.set(requestId, (session.legs.get(requestId) ?? 0) + 1)
    }

    const leg = session.legs.get(requestId) ?? 0
    const recordId = `${sessionId}:${requestId}:${leg}`
    session.recordIds.set(requestId, recordId)

    // Merge the wire request headers if their extra-info already arrived; otherwise
    // record what the renderer reported now and mark this leg as awaiting the rest.
    const rendererHeaders = headersToPairs(params.request?.headers)
    const wire = shiftQueue(session.reqExtra, requestId)
    if (!wire) pushQueue(session.reqAwait, requestId, recordId)
    const requestHeaders = wire ? mergeHeaders(rendererHeaders, wire) : rendererHeaders

    const postData: string | undefined = params.request?.postData
    this.store.insertRequest({
      id: recordId,
      source: "browser",
      tsRequest: Date.now(),
      method: params.request?.method ?? "GET",
      url: params.request?.url ?? "",
      initiatorUrl: session.currentUrl,
      initiator: parseInitiator(params.initiator),
      resourceType: params.type,
      requestHeaders,
      requestBodyBytes: postData ? Buffer.from(postData, "utf8") : undefined,
    })

    // Large / binary request bodies aren't inlined on the event — pull them so the
    // full request is captured, not just its small bodies.
    if (!postData && params.request?.hasPostData) void this.fetchRequestBody(sessionId, requestId, recordId)
  }

  private async fetchRequestBody(sessionId: string, requestId: string, recordId: string): Promise<void> {
    if (!this.connection) return
    try {
      const res = await this.connection.send<{ postData?: string }>(
        "Network.getRequestPostData",
        { requestId },
        sessionId,
      )
      if (res?.postData) this.store.setRequestBody(recordId, Buffer.from(res.postData, "utf8"))
    } catch {
      // the body may not be retainable (already gone, or a streamed/file upload)
    }
  }

  // The real on-the-wire request headers (Cookie, Authorization, and everything
  // the network stack adds). Pair them with the leg that's awaiting them, or buffer
  // until that leg's requestWillBeSent arrives.
  private onRequestExtra(params: any, sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session) return
    const requestId: string = params.requestId
    const headers = headersToPairs(params.headers)
    const awaiting = shiftQueue(session.reqAwait, requestId)
    if (awaiting) {
      const record = this.store.getRecord(awaiting)
      if (record) this.store.setRequestHeaders(awaiting, mergeHeaders(record.requestHeaders, headers))
    } else {
      pushQueue(session.reqExtra, requestId, headers)
    }
  }

  private onResponse(params: any, sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session) return
    const r = params.response ?? {}
    session.responses.set(params.requestId, {
      status: r.status,
      statusText: r.statusText || undefined,
      httpVersion: r.protocol || undefined,
      remoteIp: r.remoteIPAddress || undefined,
      remotePort: r.remotePort,
      headers: headersToPairs(r.headers),
    })
  }

  // The raw response headers (Set-Cookie and everything as received off the wire).
  // Buffered per leg and preferred over the parsed responseReceived headers.
  private onResponseExtra(params: any, sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session) return
    pushQueue(session.respExtra, params.requestId, headersToPairs(params.headers))
  }

  private async onFinished(params: any, sessionId?: string): Promise<void> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session || !sessionId || !this.connection) return
    const requestId: string = params.requestId
    const recordId = session.recordIds.get(requestId)
    if (!recordId) return
    const meta = session.responses.get(requestId) ?? {}

    let bodyBytes: Buffer | undefined
    try {
      const res = await this.connection.send<{ body: string; base64Encoded: boolean }>(
        "Network.getResponseBody",
        { requestId },
        sessionId,
      )
      bodyBytes = res.base64Encoded ? Buffer.from(res.body, "base64") : Buffer.from(res.body, "utf8")
    } catch {
      // some responses have no retrievable body
    }

    // Network.getResponseBody decodes gzip/brotli/deflate but not always zstd, so the
    // bytes can still be compressed — decompress here so the body reads as text.
    if (bodyBytes) bodyBytes = decompressBody(bodyBytes)

    this.store.finalizeResponse(recordId, {
      tsResponse: Date.now(),
      status: meta.status,
      statusText: meta.statusText,
      httpVersion: meta.httpVersion,
      remoteIp: meta.remoteIp,
      remotePort: meta.remotePort,
      responseHeaders: shiftQueue(session.respExtra, requestId) ?? meta.headers,
      responseBodyBytes: bodyBytes,
    })
    clearRequest(session, requestId)
  }

  private onFailed(params: any, sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session) return
    const requestId: string = params.requestId
    const recordId = session.recordIds.get(requestId)
    if (recordId) {
      const meta = session.responses.get(requestId) ?? {}
      this.store.finalizeResponse(recordId, {
        tsResponse: Date.now(),
        status: meta.status,
        statusText: meta.statusText ?? (params.errorText as string | undefined),
        responseHeaders: shiftQueue(session.respExtra, requestId) ?? meta.headers,
      })
    }
    clearRequest(session, requestId)
  }

  // ── page ─────────────────────────────────────────────────────────────────────

  private async onNavigated(params: any, sessionId?: string): Promise<void> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session || !sessionId || !this.connection) return
    const frame = params.frame ?? {}
    if (frame.parentId) return // main frame only
    const url: string = frame.url ?? ""
    if (!isCapturableUrl(url)) return // ignore about:blank, chrome://newtab, etc.

    session.armed = true // a real page is loaded — capture its traffic
    const initiator = session.currentUrl
    session.currentUrl = url
    this.emit({ type: "nav", nav: { ts: Date.now(), url, frameId: frame.id, initiatorUrl: initiator } })

    // Scan forms in the freshly-navigated page.
    try {
      const result = await this.connection.send<{ result: { value?: any } }>(
        "Runtime.evaluate",
        { expression: FORM_SCAN_JS, returnByValue: true },
        sessionId,
      )
      const forms = (result.result?.value ?? []) as { action: string; method: string; inputs: string[] }[]
      for (const form of forms) {
        this.emit({
          type: "form",
          form: {
            ts: Date.now(),
            pageUrl: url,
            action: resolveAction(form.action, url),
            method: form.method,
            inputs: form.inputs,
          },
        })
      }
    } catch {
      // evaluation can fail on cross-origin or unloaded frames — best effort
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isCapturableUrl(url?: string): boolean {
  return !!url && (url.startsWith("http://") || url.startsWith("https://"))
}

// Decompress a still-compressed response body, detected by its magic bytes (which
// never appear at the start of decoded text/JSON, so this is a no-op when the body
// was already decoded). Covers the gap where getResponseBody returns raw zstd; gzip
// is handled too as a safety net. Failures fall back to the original bytes.
function decompressBody(bytes: Buffer): Buffer {
  if (bytes.length < 4) return bytes
  const safe = (fn: () => Buffer): Buffer => {
    try {
      return fn()
    } catch {
      return bytes
    }
  }
  // zstd: 28 B5 2F FD
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return typeof zlib.zstdDecompressSync === "function" ? safe(() => zlib.zstdDecompressSync(bytes)) : bytes
  }
  // gzip: 1F 8B
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return safe(() => zlib.gunzipSync(bytes))
  return bytes
}

function headersToPairs(headers: Record<string, string> | undefined): HeaderPair[] {
  if (!headers) return []
  const out: HeaderPair[] = []
  for (const [rawName, raw] of Object.entries(headers)) {
    const name = normalizePseudoHeader(rawName)
    if (name === undefined) continue
    const value = String(raw)
    // CDP joins repeated headers (notably Set-Cookie) with newlines — split them
    // back into individual pairs so each one shows verbatim.
    if (value.includes("\n")) for (const part of value.split("\n")) out.push({ name, value: part })
    else out.push({ name, value })
  }
  return out
}

// HTTP/2 & HTTP/3 carry the request line and host as pseudo-headers (:method,
// :path, :scheme, :authority) and the status as :status. They just duplicate the
// start line, so drop them — except :authority, which is the Host and is shown as
// such (so the headers read like a conventional HTTP/1 message).
function normalizePseudoHeader(name: string): string | undefined {
  if (!name.startsWith(":")) return name
  if (name === ":authority") return "Host"
  return undefined
}

// The wire headers (extra) are authoritative and ordered as sent; keep them, then
// append any header the renderer reported that the wire view didn't include.
function mergeHeaders(base: HeaderPair[], extra: HeaderPair[]): HeaderPair[] {
  if (!extra.length) return base
  const seen = new Set(extra.map((h) => h.name.toLowerCase()))
  const out = [...extra]
  for (const h of base) if (!seen.has(h.name.toLowerCase())) out.push(h)
  return out
}

function pushQueue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const q = map.get(key)
  if (q) q.push(value)
  else map.set(key, [value])
}

function shiftQueue<T>(map: Map<string, T[]>, key: string): T | undefined {
  const q = map.get(key)
  if (!q || q.length === 0) return undefined
  const value = q.shift()
  if (q.length === 0) map.delete(key)
  return value
}

function clearRequest(session: SessionState, requestId: string): void {
  session.responses.delete(requestId)
  session.recordIds.delete(requestId)
  session.legs.delete(requestId)
  session.reqExtra.delete(requestId)
  session.reqAwait.delete(requestId)
  session.respExtra.delete(requestId)
}

function parseInitiator(init: any): RequestInitiator | undefined {
  if (!init || typeof init !== "object") return undefined
  const frames = Array.isArray(init.stack?.callFrames) ? init.stack.callFrames : undefined
  const stack = frames?.slice(0, 6).map((f: any) => ({
    functionName: typeof f.functionName === "string" && f.functionName ? f.functionName : undefined,
    url: typeof f.url === "string" && f.url ? f.url : undefined,
    lineNumber: typeof f.lineNumber === "number" ? f.lineNumber : undefined,
    columnNumber: typeof f.columnNumber === "number" ? f.columnNumber : undefined,
  }))
  return {
    type: typeof init.type === "string" ? init.type : "other",
    url: typeof init.url === "string" && init.url ? init.url : undefined,
    lineNumber: typeof init.lineNumber === "number" ? init.lineNumber : undefined,
    columnNumber: typeof init.columnNumber === "number" ? init.columnNumber : undefined,
    stack: stack && stack.length ? stack : undefined,
  }
}

function resolveAction(action: string, pageUrl: string): string {
  if (!action) return pageUrl
  try {
    return new URL(action, pageUrl).toString()
  } catch {
    return pageUrl
  }
}
