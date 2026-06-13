import { describe, expect, test } from "bun:test"
import { CaptureStore, contentTypeOf, isTexty, splitUrl } from "./store"
import type { CaptureStreamEvent } from "./types"

describe("url + header helpers", () => {
  test("splitUrl breaks a url into host/path/query/scheme", () => {
    expect(splitUrl("https://api.test/accounts?id=7")).toEqual({
      host: "api.test",
      path: "/accounts",
      query: "id=7",
      scheme: "https",
    })
    expect(splitUrl("not a url").host).toBe("")
  })

  test("contentTypeOf reads content-type case-insensitively, strips params", () => {
    expect(contentTypeOf([{ name: "Content-Type", value: "application/json; charset=utf-8" }])).toBe("application/json")
    expect(contentTypeOf([{ name: "x", value: "y" }])).toBeUndefined()
  })

  test("isTexty recognizes texty content types", () => {
    expect(isTexty("application/json")).toBe(true)
    expect(isTexty("text/html")).toBe(true)
    expect(isTexty("image/png")).toBe(false)
    expect(isTexty(undefined)).toBe(false)
  })
})

describe("CaptureStore", () => {
  const collect = () => {
    const events: CaptureStreamEvent[] = []
    const store = new CaptureStore((e) => events.push(e))
    return { store, events }
  }

  test("insert + finalize builds a full record and streams both sides", () => {
    const { store, events } = collect()
    store.insertRequest({
      id: "s1:1:0",
      source: "browser",
      tsRequest: 1000,
      method: "GET",
      url: "https://api.test/accounts?id=7",
      initiatorUrl: "https://app.test/dashboard",
      resourceType: "XHR",
      requestHeaders: [{ name: "Authorization", value: "Bearer secret" }],
    })

    let record = store.getRecord("s1:1:0")!
    expect(record.host).toBe("api.test")
    expect(record.path).toBe("/accounts")
    expect(record.query).toBe("id=7")
    // No redaction — the auth header is kept verbatim.
    expect(record.requestHeaders[0].value).toBe("Bearer secret")
    expect(record.status).toBeUndefined()

    store.finalizeResponse("s1:1:0", {
      tsResponse: 1100,
      status: 200,
      statusText: "OK",
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      responseBodyBytes: Buffer.from('{"ok":true}', "utf8"),
    })

    record = store.getRecord("s1:1:0")!
    expect(record.status).toBe(200)
    expect(record.durationMs).toBe(100)
    expect(record.responseBody?.present).toBe(true)
    expect(record.responseBody?.contentType).toBe("application/json")

    expect(events.filter((e) => e.type === "record")).toHaveLength(2)
  })

  test("getBody returns base64 plus decoded text for texty bodies only", () => {
    const { store } = collect()
    store.insertRequest({
      id: "s1:2:0",
      source: "browser",
      tsRequest: 1,
      method: "GET",
      url: "https://x.test/data",
      requestHeaders: [],
    })
    store.finalizeResponse("s1:2:0", {
      tsResponse: 2,
      status: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      responseBodyBytes: Buffer.from('{"a":1}', "utf8"),
    })
    const body = store.getBody("s1:2:0", "response")!
    expect(body.text).toBe('{"a":1}')
    expect(Buffer.from(body.base64, "base64").toString("utf8")).toBe('{"a":1}')

    store.insertRequest({
      id: "s1:3:0",
      source: "browser",
      tsRequest: 1,
      method: "GET",
      url: "https://x.test/logo.png",
      requestHeaders: [],
    })
    store.finalizeResponse("s1:3:0", {
      tsResponse: 2,
      status: 200,
      responseHeaders: [{ name: "content-type", value: "image/png" }],
      responseBodyBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })
    const png = store.getBody("s1:3:0", "response")!
    expect(png.text).toBeUndefined()
    expect(png.size).toBe(4)
  })

  test("list filters by method, status class, search, and starred", () => {
    const { store } = collect()
    const add = (id: string, method: string, url: string, status: number) => {
      store.insertRequest({ id, source: "browser", tsRequest: 1, method, url, requestHeaders: [] })
      store.finalizeResponse(id, { tsResponse: 2, status, responseHeaders: [] })
    }
    add("a", "GET", "https://api.test/accounts", 200)
    add("b", "POST", "https://api.test/login", 401)
    add("c", "GET", "https://cdn.test/app.js", 200)

    expect(store.list({ methods: ["GET"] }).map((r) => r.id).sort()).toEqual(["a", "c"])
    expect(store.list({ statusClasses: ["4xx"] }).map((r) => r.id)).toEqual(["b"])
    expect(store.list({ q: "login" }).map((r) => r.id)).toEqual(["b"])

    store.star("c", true)
    expect(store.list({ starred: true }).map((r) => r.id)).toEqual(["c"])
  })

  test("clear empties the store and streams a clear event", () => {
    const { store, events } = collect()
    store.insertRequest({ id: "z", source: "browser", tsRequest: 1, method: "GET", url: "https://x.test/", requestHeaders: [] })
    store.clear()
    expect(store.list()).toHaveLength(0)
    expect(events.at(-1)).toEqual({ type: "clear" })
  })
})
