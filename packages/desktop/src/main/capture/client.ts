// Capture client — attaches to the operator's Chromium over CDP (flatten-mode
// auto-attach covers every tab/subframe), translates Network + Page events into
// CaptureRecords, and feeds the store. Mirrors the gaze capture logic; redesigned
// for Electron/TS with no tab polling and no redaction.

import { CdpConnection } from "./cdp"
import { CaptureStore } from "./store"
import type { CaptureStreamEvent, HeaderPair } from "./types"

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
  /** requestId → current record id (advances across redirects). */
  recordIds: Map<string, string>
  /** requestId → redirect leg index. */
  legs: Map<string, number>
  /** requestId → response metadata awaiting loadingFinished. */
  responses: Map<string, ResponseMeta>
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
    connection.on("Network.responseReceived", (params, sid) => this.onResponse(params, sid))
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
      recordIds: new Map(),
      legs: new Map(),
      responses: new Map(),
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
    const requestId: string = params.requestId

    // A redirect reuses the requestId and carries the prior response — finalize
    // the previous leg, then start a new one for the redirected request.
    if (params.redirectResponse) {
      const prevId = session.recordIds.get(requestId)
      if (prevId) {
        this.store.finalizeResponse(prevId, {
          tsResponse: Date.now(),
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText || undefined,
          httpVersion: params.redirectResponse.protocol || undefined,
          responseHeaders: headersToPairs(params.redirectResponse.headers),
        })
      }
      session.legs.set(requestId, (session.legs.get(requestId) ?? 0) + 1)
    }

    const leg = session.legs.get(requestId) ?? 0
    const recordId = `${sessionId}:${requestId}:${leg}`
    session.recordIds.set(requestId, recordId)

    const postData: string | undefined = params.request?.postData
    this.store.insertRequest({
      id: recordId,
      source: "browser",
      tsRequest: Date.now(),
      method: params.request?.method ?? "GET",
      url: params.request?.url ?? "",
      initiatorUrl: session.currentUrl,
      resourceType: params.type,
      requestHeaders: headersToPairs(params.request?.headers),
      requestBodyBytes: postData ? Buffer.from(postData, "utf8") : undefined,
    })
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

    this.store.finalizeResponse(recordId, {
      tsResponse: Date.now(),
      status: meta.status,
      statusText: meta.statusText,
      httpVersion: meta.httpVersion,
      remoteIp: meta.remoteIp,
      remotePort: meta.remotePort,
      responseHeaders: meta.headers,
      responseBodyBytes: bodyBytes,
    })
    session.responses.delete(requestId)
    session.recordIds.delete(requestId)
    session.legs.delete(requestId)
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
        responseHeaders: meta.headers,
      })
    }
    session.responses.delete(requestId)
    session.recordIds.delete(requestId)
    session.legs.delete(requestId)
  }

  // ── page ─────────────────────────────────────────────────────────────────────

  private async onNavigated(params: any, sessionId?: string): Promise<void> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session || !sessionId || !this.connection) return
    const frame = params.frame ?? {}
    if (frame.parentId) return // main frame only
    const url: string = frame.url ?? ""
    if (!url || url === "about:blank") return

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

function headersToPairs(headers: Record<string, string> | undefined): HeaderPair[] {
  if (!headers) return []
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}

function resolveAction(action: string, pageUrl: string): string {
  if (!action) return pageUrl
  try {
    return new URL(action, pageUrl).toString()
  } catch {
    return pageUrl
  }
}
