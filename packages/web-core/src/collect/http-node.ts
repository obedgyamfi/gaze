// ── ScopedHttp — the Node egress runtime ──────────────────────────────────────
// The concrete, DNS-pinned HTTP client collectors/oracles use. Node-only (uses
// node:http/https/dns) — kept out of the browser barrel. Enforces the security kernel
// on the wire: scope.assert before connect, resolved-IP pinning + private-range recheck
// (SSRF/rebinding defense), and scope re-assertion on every redirect hop. All requests
// go through the Scheduler for rate/concurrency. Bodies are size-capped.

import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { lookup as dnsLookup } from "node:dns/promises"
import type { LookupAddress, LookupOptions } from "node:dns"
import { isIpv4, isPrivateIp, ScopeViolation, type ScopeGuard, type Target } from "./scope.js"
import type { Scheduler } from "./scheduler.js"
import type { HttpReq, HttpRes, ScopedHttp } from "./types.js"

export interface NodeHttpDeps {
  scope: ScopeGuard
  scheduler: Scheduler
  /** hostname → IP. Default: node:dns. Injectable for tests. */
  resolve?: (host: string) => Promise<string>
  maxRedirects?: number
  userAgent?: string
  timeoutMs?: number
  defaultMaxBytes?: number
}

function targetOf(urlStr: string): Target {
  const u = new URL(urlStr)
  const scheme = u.protocol.replace(":", "")
  return { host: u.hostname, port: u.port ? Number(u.port) : scheme === "https" ? 443 : 80, scheme }
}

export function createNodeHttp(deps: NodeHttpDeps): ScopedHttp {
  const maxRedirects = deps.maxRedirects ?? 5
  const ua = deps.userAgent ?? "GAZE/0.1 (+authorized-testing)"
  const timeoutMs = deps.timeoutMs ?? 20_000
  const defaultMaxBytes = deps.defaultMaxBytes ?? 2_000_000
  const resolve = deps.resolve ?? (async (h) => (isIpv4(h) || h.includes(":") ? h : (await dnsLookup(h)).address))

  async function once(
    urlStr: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    redirectsLeft: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<HttpRes> {
    const target = targetOf(urlStr)
    deps.scope.assert(target) // fast-fail before any DNS/connect

    const ip = await resolve(target.host)
    if (deps.scope.rules.denyPrivate && isPrivateIp(ip) && !deps.scope.allows({ host: ip, port: target.port })) {
      throw new ScopeViolation(target, `${target.host} resolves to private address ${ip}`)
    }

    const started = Date.now()
    const lib = target.scheme === "https" ? httpsRequest : httpRequest
    const res = await new Promise<IncomingMessage>((resolveRes, rejectRes) => {
      const req = lib(
        urlStr,
        {
          method,
          headers: { "user-agent": ua, ...headers },
          signal,
          timeout: timeoutMs,
          // Pin the connection to the vetted IP (defeats DNS rebinding). Honor the
          // `all` form the http client calls with (it expects an address array).
          lookup: (
            _hostname: string,
            opts: LookupOptions,
            cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
          ) => {
            const family = isIpv4(ip) ? 4 : 6
            if (opts.all) cb(null, [{ address: ip, family }])
            else cb(null, ip, family)
          },
          servername: target.scheme === "https" ? target.host : undefined,
        },
        resolveRes,
      )
      req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)))
      req.on("error", rejectRes)
      if (body != null) req.write(body)
      req.end()
    })

    const status = res.statusCode ?? 0
    const location = res.headers.location

    // Follow redirects manually so every hop is re-scope-checked.
    if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
      res.resume() // drain
      const next = new URL(location, urlStr).toString()
      const downgradeToGet = status === 301 || status === 302 || status === 303
      return once(
        next,
        downgradeToGet ? "GET" : method,
        headers,
        downgradeToGet ? undefined : body,
        redirectsLeft - 1,
        maxBytes,
        signal,
      )
    }

    const outHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers)) outHeaders[k] = Array.isArray(v) ? v.join(", ") : (v ?? "")

    const chunks: Buffer[] = []
    let bytes = 0
    let kept = 0
    await new Promise<void>((done, fail) => {
      res.on("data", (c: Buffer) => {
        bytes += c.length
        if (kept < maxBytes) {
          const room = maxBytes - kept
          const slice = c.length <= room ? c : c.subarray(0, room)
          chunks.push(slice)
          kept += slice.length
          if (kept >= maxBytes) res.destroy() // stop reading once capped
        }
      })
      res.on("end", done)
      res.on("close", done)
      res.on("error", (e) => (kept >= maxBytes ? done() : fail(e)))
    })

    return {
      status,
      headers: outHeaders,
      body: Buffer.concat(chunks).toString("utf8"),
      bytes,
      ms: Date.now() - started,
      finalUrl: urlStr,
    }
  }

  return {
    fetch(req: HttpReq): Promise<HttpRes> {
      let target: Target
      try {
        target = targetOf(req.url)
        deps.scope.assert(target) // fail fast, before we even queue — as a rejection, never a throw
      } catch (e) {
        return Promise.reject(e)
      }
      return deps.scheduler.submit(
        (signal) => {
          const merged = req.signal
            ? mergeSignals(signal, req.signal)
            : signal
          return once(
            req.url,
            req.method.toUpperCase(),
            req.headers ?? {},
            req.body,
            maxRedirects,
            req.maxBytes ?? defaultMaxBytes,
            merged,
          )
        },
        { host: target.host },
      )
    },
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (a.aborted || b.aborted) ac.abort()
  else {
    a.addEventListener("abort", onAbort, { once: true })
    b.addEventListener("abort", onAbort, { once: true })
  }
  return ac.signal
}
