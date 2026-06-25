// Repeater send — performs a raw HTTP request (no browser), captures the full
// response, and records it into the store as a `repeater`-source capture so it
// shows up in the proxy log alongside browser traffic.

import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { IncomingMessage } from "node:http"
import zlib from "node:zlib"
import { CaptureStore } from "./store"
import type { CaptureRecord, HeaderPair, RepeaterRequest } from "./types"

let repeaterSeq = 0

export async function sendRepeater(store: CaptureStore, req: RepeaterRequest): Promise<CaptureRecord> {
  const id = `repeater:${Date.now()}:${repeaterSeq++}`
  const bodyBytes = req.body ? Buffer.from(req.body, "utf8") : undefined

  store.insertRequest({
    id,
    source: "repeater",
    tsRequest: Date.now(),
    method: req.method,
    url: req.url,
    requestHeaders: req.headers,
    requestBodyBytes: bodyBytes,
  })

  const { status, statusText, httpVersion, headers, body } = await perform(req, bodyBytes)

  store.finalizeResponse(id, {
    tsResponse: Date.now(),
    status,
    statusText,
    httpVersion,
    responseHeaders: headers,
    responseBodyBytes: body,
  })

  const record = store.getRecord(id)
  if (!record) throw new Error("repeater record vanished")
  return record
}

interface PerformResult {
  status?: number
  statusText?: string
  httpVersion?: string
  headers: HeaderPair[]
  body?: Buffer
}

function perform(req: RepeaterRequest, body: Buffer | undefined): Promise<PerformResult> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      reject(new Error(`invalid url: ${req.url}`))
      return
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest
    const headers: Record<string, string> = {}
    for (const h of req.headers) headers[h.name] = h.value

    const r = send(
      url,
      { method: req.method, headers },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(Buffer.from(c)))
        res.on("end", () => {
          // node:http does NOT auto-decompress (unlike the browser/fetch), so decode the
          // body per Content-Encoding — otherwise the stored bytes are raw gzip/br/deflate
          // and render as garbage in the proxy panel.
          const raw = chunks.length ? Buffer.concat(chunks) : undefined
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase()
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || undefined,
            httpVersion: res.httpVersion ? `HTTP/${res.httpVersion}` : undefined,
            headers: incomingHeaders(res),
            body: raw ? decompress(raw, enc) : undefined,
          })
        })
      },
    )
    r.on("error", reject)
    if (body) r.write(body)
    r.end()
  })
}

function incomingHeaders(res: IncomingMessage): HeaderPair[] {
  const pairs: HeaderPair[] = []
  const raw = res.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push({ name: raw[i], value: raw[i + 1] })
  return pairs
}

// Decode a response body by its Content-Encoding (the header is authoritative, more
// reliable than magic-byte sniffing — deflate has no magic). Falls back to the raw
// bytes if the codec is unknown or decompression fails on a partial/corrupt body.
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
    /* fall through to raw bytes */
  }
  return buf
}
