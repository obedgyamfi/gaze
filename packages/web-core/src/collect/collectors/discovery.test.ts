import { describe, expect, test } from "bun:test"
import { createInMemoryStores } from "../../stores.js"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { CollectorCtx, Observation, ScopedHttp } from "../types.js"
import { contentDiscoveryCollector, isHit } from "./content-discovery.js"
import { paramMinerCollector } from "./param-miner.js"

function ctxWith(net: ScopedHttp, emitted: Observation[]): CollectorCtx {
  return {
    scope: createScopeGuard({ hosts: ["site.test"], denyPrivate: true }),
    net,
    scheduler: createScheduler({ defaultRps: 1000 }),
    emit: (o) => emitted.push(o),
    workspace: createInMemoryStores(),
    signal: new AbortController().signal,
    log: () => {},
  }
}

describe("isHit", () => {
  test("404 baseline → any non-404 is a hit", () => {
    expect(isHit({ status: 200, bytes: 10 }, { status: 404, bytes: 0 })).toBe(true)
    expect(isHit({ status: 404, bytes: 0 }, { status: 404, bytes: 0 })).toBe(false)
  })
  test("catch-all 200 baseline → needs a real signal", () => {
    expect(isHit({ status: 200, bytes: 1000 }, { status: 200, bytes: 1000 })).toBe(false)
    expect(isHit({ status: 403, bytes: 20 }, { status: 200, bytes: 1000 })).toBe(true)
    expect(isHit({ status: 200, bytes: 5000 }, { status: 200, bytes: 1000 })).toBe(true)
  })
})

describe("contentDiscoveryCollector", () => {
  test("finds paths that deviate from the soft-404", async () => {
    const net: ScopedHttp = {
      fetch: async (req) => {
        const p = new URL(req.url).pathname
        const body = (s: number, b: string) => ({ status: s, headers: {}, body: b, bytes: b.length, ms: 1, finalUrl: req.url })
        if (p.includes("gaze-not-found")) return body(404, "nope")
        if (p === "/admin") return body(200, "admin panel")
        if (p === "/secret") return body(403, "denied")
        return body(404, "nope")
      },
    }
    const emitted: Observation[] = []
    const res = await contentDiscoveryCollector.run(ctxWith(net, emitted), {
      baseUrl: "http://site.test/",
      wordlist: ["admin", "secret", "nope"],
    })
    const urls = emitted.map((o) => (o.kind === "endpoint" ? o.url : ""))
    expect(urls).toContain("http://site.test/admin")
    expect(urls).toContain("http://site.test/secret")
    expect(urls.some((u) => u.endsWith("/nope"))).toBe(false)
    expect(res.emitted).toBe(2)
  })
})

describe("paramMinerCollector", () => {
  test("detects reflected + length-changing params, ignores inert ones", async () => {
    const net: ScopedHttp = {
      fetch: async (req) => {
        const u = new URL(req.url)
        let body = "hello"
        if (u.searchParams.has("q")) body = "hello " + u.searchParams.get("q") // reflected
        if (u.searchParams.has("size")) body = "hello " + "x".repeat(60) // length change, no reflection
        return { status: 200, headers: {}, body, bytes: body.length, ms: 1, finalUrl: req.url }
      },
    }
    const emitted: Observation[] = []
    const res = await paramMinerCollector.run(ctxWith(net, emitted), {
      url: "http://site.test/search",
      params: ["q", "size", "inert"],
    })
    expect(res.emitted).toBe(2)
    const obs = emitted.find((o) => o.kind === "endpoint")
    const names = obs && obs.kind === "endpoint" ? (obs.params ?? []).map((p) => p.name).sort() : []
    expect(names).toEqual(["q", "size"])
  })
})
