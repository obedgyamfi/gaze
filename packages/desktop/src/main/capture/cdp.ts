// Minimal Chrome DevTools Protocol client over a single browser-level WebSocket.
// Uses flatten mode (sessionId on every message) so one connection multiplexes
// every page/tab target. No external CDP library — just `ws` + the JSON protocol.

import WebSocket from "ws"

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type EventHandler = (params: any, sessionId?: string) => void

export class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, Set<EventHandler>>()
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on("message", (data) => this.onMessage(data.toString()))
    ws.on("close", () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error("cdp connection closed"))
      this.pending.clear()
    })
    ws.on("error", () => {
      /* surfaced via close */
    })
  }

  /** Resolve the browser-level debugger URL from the dev-tools port and connect. */
  static async connect(port: number, signal?: AbortSignal): Promise<CdpConnection> {
    const wsUrl = await resolveBrowserWsUrl(port, signal)
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", (err) => reject(err))
    })
    return new CdpConnection(ws)
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("cdp connection closed"))
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  on(method: string, handler: EventHandler): void {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
  }

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }

  private onMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"))
      else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === "string") {
      const set = this.handlers.get(msg.method)
      if (!set) return
      for (const handler of set) handler(msg.params ?? {}, msg.sessionId)
    }
  }
}

/** Polls /json/version for the browser webSocketDebuggerUrl until the port is up. */
async function resolveBrowserWsUrl(port: number, signal?: AbortSignal): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt++) {
    if (signal?.aborted) throw new Error("aborted")
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      const json = (await res.json()) as { webSocketDebuggerUrl?: string }
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
    } catch (err) {
      lastError = err
    }
    await delay(250, signal)
  }
  throw new Error(`could not reach the browser debug endpoint on port ${port}: ${String(lastError)}`)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(new Error("aborted"))
      },
      { once: true },
    )
  })
}
