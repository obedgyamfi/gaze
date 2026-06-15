import type { CaptureRecord, HeaderPair } from "@/web/capture-types"

// Raw HTTP message assembly + parsing for the Burp-style message panes. The
// request/response are shown as the full raw wire message (start line + headers
// + blank line + body), which is also what the repeater edits.

// CDP reports the protocol as "h2" / "h3" / "http/1.1"; show the conventional
// form ("HTTP/2") in start lines and the General block.
export function normalizeProtocol(p?: string): string {
  if (!p) return "HTTP/1.1"
  const l = p.toLowerCase()
  if (l === "h2" || l === "h2c" || l === "http/2") return "HTTP/2"
  if (l === "h3" || l === "http/3") return "HTTP/3"
  return p.toUpperCase()
}

export function requestStartLine(r: Pick<CaptureRecord, "method" | "path" | "query" | "httpVersion">): string {
  const pathQ = (r.path || "/") + (r.query ? `?${r.query}` : "")
  return `${r.method} ${pathQ} ${normalizeProtocol(r.httpVersion)}`
}

export function responseStartLine(r: Pick<CaptureRecord, "httpVersion" | "status" | "statusText">): string {
  return `${normalizeProtocol(r.httpVersion)} ${r.status ?? ""} ${r.statusText ?? ""}`.replace(/\s+$/, "")
}

// HTTP/2 lowercases header names on the wire; restore the conventional
// hyphen-segment capitalization for display (sec-ch-ua → Sec-Ch-Ua).
const HEADER_SPECIAL: Record<string, string> = {
  etag: "ETag",
  dnt: "DNT",
  "www-authenticate": "WWW-Authenticate",
  "x-xss-protection": "X-XSS-Protection",
  te: "TE",
}
export function canonicalHeaderName(name: string): string {
  const lower = name.toLowerCase()
  if (HEADER_SPECIAL[lower]) return HEADER_SPECIAL[lower]
  return lower
    .split("-")
    .map((seg) => (seg ? seg[0].toUpperCase() + seg.slice(1) : seg))
    .join("-")
}

export function headerBlock(headers: HeaderPair[]): string {
  return headers.map((h) => `${canonicalHeaderName(h.name)}: ${h.value}`).join("\n")
}

export function buildRawMessage(startLine: string, headers: HeaderPair[], body?: string): string {
  let out = startLine
  const block = headerBlock(headers)
  if (block) out += "\n" + block
  if (body != null && body !== "") out += "\n\n" + body
  return out
}

export interface ParsedRequest {
  method: string
  path: string
  httpVersion?: string
  headers: HeaderPair[]
  body?: string
}

/** Parse an editable raw request back into parts. Body starts at the first
 *  blank line; the start line is "METHOD path VERSION". */
export function parseRawRequest(raw: string): ParsedRequest {
  const sep = raw.search(/\r?\n\r?\n/)
  const head = sep >= 0 ? raw.slice(0, sep) : raw
  const body = sep >= 0 ? raw.slice(sep).replace(/^\r?\n\r?\n/, "") : ""
  const lines = head.split(/\r?\n/)
  const start = lines.shift() ?? ""
  const m = start.match(/^(\S+)\s+(\S+)(?:\s+(\S+))?/)
  const headers: HeaderPair[] = []
  for (const line of lines) {
    const i = line.indexOf(":")
    if (i <= 0) continue
    const name = line.slice(0, i).trim()
    if (name) headers.push({ name, value: line.slice(i + 1).trim() })
  }
  return {
    method: m?.[1] ?? "GET",
    path: m?.[2] ?? "/",
    httpVersion: m?.[3],
    headers,
    body: body || undefined,
  }
}

/** scheme://host[:port] for a record — the repeater "Target". */
export function originOf(r: Pick<CaptureRecord, "scheme" | "host">): string {
  return `${r.scheme || "https"}://${r.host}`
}

/** Parse Cookie / Set-Cookie header values into name/value pairs. */
export function parseCookies(headers: HeaderPair[], side: "request" | "response"): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  if (side === "request") {
    const cookie = headers.find((h) => h.name.toLowerCase() === "cookie")?.value
    if (cookie) {
      for (const part of cookie.split(";")) {
        const i = part.indexOf("=")
        if (i > 0) out.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() })
      }
    }
  } else {
    for (const h of headers) {
      if (h.name.toLowerCase() !== "set-cookie") continue
      const first = h.value.split(";")[0]
      const i = first.indexOf("=")
      if (i > 0) out.push({ name: first.slice(0, i).trim(), value: first.slice(i + 1).trim() })
    }
  }
  return out
}

/** Count case-insensitive occurrences of `term` in `text`. */
export function countMatches(text: string, term: string): number {
  if (!term) return 0
  const t = term.toLowerCase()
  const hay = text.toLowerCase()
  let n = 0
  let i = 0
  while ((i = hay.indexOf(t, i)) !== -1) {
    n++
    i += t.length
  }
  return n
}
