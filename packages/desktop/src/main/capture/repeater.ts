// Repeater send — performs a raw HTTP request (no browser), captures the full
// response, and records it into the store as a `repeater`-source capture so it
// shows up in the proxy log alongside browser traffic.

import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { IncomingMessage } from "node:http"
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
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || undefined,
            httpVersion: res.httpVersion ? `HTTP/${res.httpVersion}` : undefined,
            headers: incomingHeaders(res),
            body: chunks.length ? Buffer.concat(chunks) : undefined,
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
