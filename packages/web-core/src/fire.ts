// ── createFetchFire — the assisted-mode firing capability ─────────────────────
// Implements ctx.fire over the global `fetch`. When `replayCaptureId` is set it
// reuses the captured request's REAL headers (incl. the session token) read from
// the store — server-side, so the credential never reaches the model. Persists
// the result as a "repeater" capture (so it gets an id the oracle can diff) and
// returns observable signals only. Scope-checked before any request leaves.

import { createHash } from "node:crypto"
import type { CaptureRecord, CaptureSink, CaptureSource } from "./capture-source.js"
import type { FireRequest, FireResult } from "./tools.js"

const HOP_BY_HOP = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding"])

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}
function inScope(host: string, scopeHosts: string[]): boolean {
  return scopeHosts.length === 0 || scopeHosts.some((s) => host === s || host.endsWith("." + s))
}
function isTexty(ct?: string): boolean {
  if (!ct) return false
  const c = ct.toLowerCase()
  return c.includes("json") || c.includes("text") || c.includes("xml") || c.includes("javascript") || c.includes("html") || c.includes("urlencoded")
}

export function createFetchFire(deps: { source: CaptureSource; sink: CaptureSink; scopeHosts: string[] }): (req: FireRequest) => Promise<FireResult> {
  return async (req) => {
    let method = req.method
    let url = req.url
    const headers: Record<string, string> = { ...(req.headers ?? {}) }
    let body = req.body

    // Replay: reuse the captured request's real auth/headers, server-side.
    if (req.replayCaptureId) {
      const base = (await deps.source.list()).find((c) => c.id === req.replayCaptureId)
      if (base) {
        method = req.method || base.method
        url = req.url || base.url
        for (const h of base.requestHeaders) if (!(h.name.toLowerCase() in headers)) headers[h.name] = h.value
        if (body === undefined) body = (await deps.source.getBody(base.id, "request"))?.text
      }
    }

    for (const s of req.substitutions ?? []) {
      url = url.split(s.from).join(s.to)
      if (body) body = body.split(s.from).join(s.to)
    }

    const u = safeUrl(url)
    if (!u) throw new Error(`invalid url: ${url}`)
    if (!inScope(u.host, deps.scopeHosts)) throw new Error(`Host '${u.host}' is out of engagement scope.`)

    for (const name of Object.keys(headers)) {
      const lk = name.toLowerCase()
      if (HOP_BY_HOP.has(lk) || lk.startsWith(":")) delete headers[name]
    }

    const noBody = method === "GET" || method === "HEAD"
    const started = Date.now()
    const res = await fetch(url, { method, headers, body: noBody ? undefined : body, redirect: "manual" })
    const ms = Date.now() - started
    const buf = new Uint8Array(await res.arrayBuffer())
    const base64 = Buffer.from(buf).toString("base64")
    const bodyHash = createHash("sha256").update(base64).digest("hex")
    const ct = res.headers.get("content-type") ?? undefined

    const id = `repeater-${createHash("sha1").update(`${method}:${url}:${started}`).digest("hex").slice(0, 12)}`
    const record: CaptureRecord = {
      id,
      seq: started,
      source: "repeater",
      tsRequest: started,
      method,
      url,
      host: u.host,
      path: u.pathname,
      query: u.search ? u.search.slice(1) : undefined,
      scheme: u.protocol.replace(/:$/, ""),
      requestHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      tsResponse: Date.now(),
      status: res.status,
      statusText: res.statusText,
      responseHeaders: [...res.headers].map(([name, value]) => ({ name, value })),
      responseBody: { present: buf.length > 0, size: buf.length, contentType: ct },
      durationMs: ms,
    }
    deps.sink.putRecord(record)
    if (buf.length > 0) deps.sink.putBody(id, "response", buf, ct)

    const text = isTexty(ct) ? Buffer.from(buf).toString("utf8") : ""
    const marker = req.marker && text.includes(req.marker) ? req.marker : undefined
    return { captureId: id, status: res.status, ms, bodyHash, marker }
  }
}
