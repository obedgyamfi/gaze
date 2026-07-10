// ── Intercepting MITM proxy engine ────────────────────────────────────────────
// A Burp-style HTTP(S) proxy. Plain-HTTP requests arrive in absolute form; HTTPS
// arrives as CONNECT, which we TLS-terminate with a CA-signed per-host leaf cert
// (SNI-driven) and re-parse. The TLS front is an http2 secure server with ALPN, so it
// speaks BOTH HTTP/2 (Google/gRPC/modern apps) and HTTP/1.1 (browsers) — upstream is
// always forwarded over HTTP/1.1. Every transaction streams to the client while a
// size-capped, decompressed copy is teed off for the capture store. Point a device's
// HTTP proxy at host:port and install the CA cert to intercept its HTTPS traffic.

import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse, type Http2SecureServer } from "node:http2"
import { connect as tlsConnect, TLSSocket } from "node:tls"
import { connect as netConnect, type Socket } from "node:net"
import zlib from "node:zlib"
import type { CertAuthority } from "./ca.js"

export interface HeaderPair {
  name: string
  value: string
}
export interface ProxyRequestEvent {
  id: string
  tsRequest: number
  method: string
  url: string
  requestHeaders: HeaderPair[]
  requestBody?: Buffer
}
export interface ProxyResponseEvent {
  id: string
  tsResponse: number
  status?: number
  statusText?: string
  httpVersion?: string
  remoteIp?: string
  remotePort?: number
  responseHeaders: HeaderPair[]
  responseBody?: Buffer
}
export interface ProxySink {
  onRequest(rec: ProxyRequestEvent): void
  onResponse(rec: ProxyResponseEvent): void
  onError?(message: string): void
}

type AnyReq = IncomingMessage | Http2ServerRequest
type AnyRes = ServerResponse | Http2ServerResponse

const DEFAULT_MAX_BODY = 5 * 1024 * 1024 // per side, for STORAGE only (client gets the full stream)
// Hop-by-hop headers that must not cross a proxy (RFC 7230 §6.1). HTTP/2 also forbids
// them outright, so stripping is required for the h2 leg, not just cosmetic.
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
])

/** Response headers → object (lowercased, hop-by-hop dropped, dupes → array). Works for
 *  both the HTTP/1.1 and HTTP/2 client responses (h2 requires lowercase, no hop-by-hop). */
function toResponseHeaders(raw: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i]!.toLowerCase()
    if (HOP_BY_HOP.has(k)) continue
    const v = raw[i + 1]!
    const cur = out[k]
    if (cur === undefined) out[k] = v
    else if (Array.isArray(cur)) cur.push(v)
    else out[k] = [cur, v]
  }
  return out
}

/** Capture-facing header pairs, minus HTTP/2 pseudo-headers (`:method`, `:path`, …). */
function capturePairs(raw: string[]): HeaderPair[] {
  const out: HeaderPair[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.startsWith(":")) continue
    out.push({ name: raw[i]!, value: raw[i + 1]! })
  }
  return out
}

function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")
}

function decompress(buf: Buffer, enc: string): Buffer {
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf)
    if (enc.includes("gzip")) return zlib.gunzipSync(buf)
    if (enc.includes("zstd") && typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buf)
    if (enc.includes("deflate")) {
      try {
        return zlib.inflateSync(buf)
      } catch {
        return zlib.inflateRawSync(buf)
      }
    }
  } catch {
    /* partial/corrupt — keep raw */
  }
  return buf
}

/** Accumulates up to `cap` bytes off a stream; flags truncation. Never affects the
 *  client stream — this only bounds what we keep for the capture panel. */
class Capped {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  constructor(private readonly cap: number) {}
  push(c: Buffer): void {
    if (this.size >= this.cap) {
      this.truncated = true
      return
    }
    const room = this.cap - this.size
    this.chunks.push(c.length <= room ? c : c.subarray(0, room))
    this.size += Math.min(c.length, room)
    if (c.length > room) this.truncated = true
  }
  done(): Buffer | undefined {
    return this.chunks.length ? Buffer.concat(this.chunks) : undefined
  }
}

export interface MitmProxyOptions {
  ca: CertAuthority
  sink: ProxySink
  maxBodyBytes?: number
}

export class MitmProxy {
  private readonly server: http.Server // plain-HTTP proxy + CONNECT tunnel
  private readonly secure: Http2SecureServer // TLS terminator, speaks h2 + http/1.1
  private readonly maxBody: number
  private seq = 0

  constructor(private readonly opts: MitmProxyOptions) {
    this.maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY

    this.server = http.createServer((req, res) => this.handleRequest(req, res))
    this.server.on("connect", (req, socket, head) => this.handleConnect(req, socket as Socket, head))
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Socket, head))
    this.server.on("clientError", (_e, socket) => socket.destroy())

    const dft = opts.ca.defaultCredentials()
    // allowHTTP1 + default ALPN (h2, http/1.1): the client picks the protocol; both land
    // in the same request handler via the http2 compat API. SNICallback mints per-host certs.
    this.secure = createSecureServer(
      {
        key: dft.key,
        cert: dft.cert,
        allowHTTP1: true,
        SNICallback: (name, cb) => {
          try {
            cb(null, opts.ca.contextFor(name))
          } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)))
          }
        },
      },
      (req, res) => this.handleRequest(req, res),
    )
    this.secure.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Socket, head))
    // Bad TLS / broken h2 sessions must never crash the proxy.
    this.secure.on("clientError", (_e: unknown, socket) => (socket as Socket | undefined)?.destroy())
    this.secure.on("sessionError", () => {})
    this.secure.on("tlsClientError", () => {})
  }

  listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(e)
      this.server.once("error", onError)
      this.server.listen(port, host, () => {
        this.server.off("error", onError)
        resolve()
      })
    })
  }

  address(): { host: string; port: number } | undefined {
    const a = this.server.address()
    return a && typeof a === "object" ? { host: a.address, port: a.port } : undefined
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.secure.close()
      this.server.close(() => resolve())
    })
  }

  // ── HTTPS CONNECT → hand the raw socket to the TLS/h2 terminator ──
  private handleConnect(_req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    clientSocket.on("error", () => {})
    clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-agent: GAZE\r\n\r\n", () => {
      if (head?.length) clientSocket.unshift(head)
      this.secure.emit("connection", clientSocket)
    })
  }

  // ── one request (plain HTTP/1.1, decrypted HTTP/1.1, or decrypted HTTP/2) ──
  private handleRequest(req: AnyReq, res: AnyRes): void {
    const id = `proxy:${Date.now()}:${this.seq++}`
    const tsRequest = Date.now()
    const h = req.headers as Record<string, string | string[] | undefined>
    const isH2 = typeof h[":scheme"] === "string" || req.httpVersionMajor === 2
    const encrypted = isH2 || (req.socket as TLSSocket).encrypted === true

    // Reconstruct the absolute URL. HTTP/2 carries :authority + :path; plain proxy
    // requests carry an absolute URI; decrypted HTTP/1.1 carries path + Host.
    const rawUrl = req.url ?? "/"
    let url: string
    if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
      url = rawUrl
    } else {
      const authority = (h[":authority"] as string) || (h["host"] as string) || "unknown.host"
      const scheme = (h[":scheme"] as string) || (encrypted ? "https" : "http")
      const path = (h[":path"] as string) || rawUrl
      url = `${scheme}://${authority}${path}`
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      safeWriteHead(res, 400)
      res.end("bad proxy request")
      return
    }

    const isHttps = parsed.protocol === "https:"
    const lib = isHttps ? https : http
    // Upstream (HTTP/1.1) headers: drop pseudo-headers + hop-by-hop; ensure a Host header.
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || k.startsWith(":") || HOP_BY_HOP.has(k.toLowerCase())) continue
      headers[k] = v
    }
    if (!("host" in headers) && !("Host" in headers)) headers["host"] = parsed.host

    const reqCap = new Capped(this.maxBody)
    const reqHeaderPairs = capturePairs(req.rawHeaders)
    let requestEmitted = false
    const emitRequest = () => {
      if (requestEmitted) return
      requestEmitted = true
      this.opts.sink.onRequest({ id, tsRequest, method: req.method ?? "GET", url, requestHeaders: reqHeaderPairs, requestBody: reqCap.done() })
    }

    const upstream = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        method: req.method,
        path: parsed.pathname + parsed.search,
        headers,
        servername: isHttps && !isIpHost(parsed.hostname) ? parsed.hostname : undefined,
      },
      (upRes) => {
        emitRequest()
        const respCap = new Capped(this.maxBody)
        safeWriteHead(res, upRes.statusCode ?? 502, toResponseHeaders(upRes.rawHeaders))
        upRes.on("data", (c: Buffer) => respCap.push(c))
        upRes.on("error", () => res.end())
        upRes.pipe(res)
        upRes.on("end", () => {
          const raw = respCap.done() ?? Buffer.alloc(0)
          const enc = String(upRes.headers["content-encoding"] ?? "").toLowerCase()
          this.opts.sink.onResponse({
            id,
            tsResponse: Date.now(),
            status: upRes.statusCode,
            statusText: upRes.statusMessage,
            // Report the CLIENT-side protocol so the panel shows HTTP/2 for h2 clients
            // (upstream is always forwarded over HTTP/1.1).
            httpVersion: isH2 ? "HTTP/2" : upRes.httpVersion ? `HTTP/${upRes.httpVersion}` : undefined,
            remoteIp: upstream.socket?.remoteAddress,
            remotePort: upstream.socket?.remotePort,
            responseHeaders: capturePairs(upRes.rawHeaders),
            responseBody: respCap.truncated ? raw : decompress(raw, enc),
          })
        })
      },
    )

    upstream.on("error", (e) => {
      emitRequest()
      this.opts.sink.onResponse({
        id,
        tsResponse: Date.now(),
        status: 502,
        statusText: "Bad Gateway (proxy)",
        responseHeaders: [],
        responseBody: Buffer.from(`upstream error: ${e.message}`),
      })
      this.opts.sink.onError?.(`${parsed.host}: ${e.message}`)
      if (!res.headersSent) safeWriteHead(res, 502)
      res.end()
    })

    req.on("data", (c: Buffer) => reqCap.push(c))
    req.on("end", emitRequest)
    req.on("error", () => upstream.destroy())
    req.pipe(upstream)
  }

  // WebSocket / protocol upgrades: tunnel bytes to upstream untouched (no capture) so
  // wss-dependent apps keep working instead of hanging.
  private handleUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    clientSocket.on("error", () => {})
    const encrypted = (req.socket as TLSSocket).encrypted === true
    let parsed: URL
    try {
      const host = req.headers.host ?? "unknown.host"
      parsed = new URL(`${encrypted ? "https" : "http"}://${host}${req.url ?? "/"}`)
    } catch {
      clientSocket.destroy()
      return
    }
    const tls = parsed.protocol === "https:"
    const port = Number(parsed.port) || (tls ? 443 : 80)
    const upstream = tls
      ? tlsConnect({ host: parsed.hostname, port, servername: isIpHost(parsed.hostname) ? undefined : parsed.hostname })
      : netConnect({ host: parsed.hostname, port })
    upstream.on(tls ? "secureConnect" : "connect", () => {
      const lines = [`${req.method} ${parsed.pathname + parsed.search} HTTP/1.1`]
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(lines.join("\r\n") + "\r\n\r\n")
      if (head?.length) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on("error", () => clientSocket.destroy())
    clientSocket.on("close", () => upstream.destroy())
  }
}

/** writeHead that tolerates the HTTP/1.1 and HTTP/2 response APIs and never throws
 *  (a header HTTP/2 rejects would otherwise kill the stream). */
function safeWriteHead(res: AnyRes, status: number, headers?: Record<string, string | string[]>): void {
  // Both ServerResponse and Http2ServerResponse accept (status, headers-object) at runtime;
  // the union's overloads don't unify, so narrow via a cast.
  const w = res as ServerResponse
  try {
    if (headers) w.writeHead(status, headers)
    else w.writeHead(status)
  } catch {
    try {
      w.writeHead(status)
    } catch {
      /* headers already sent */
    }
  }
}
