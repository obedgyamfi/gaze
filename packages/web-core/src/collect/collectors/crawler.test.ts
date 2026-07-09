import { describe, expect, test } from "bun:test"
import { createInMemoryStores } from "../../stores.js"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { CollectorCtx, Observation, ScopedHttp } from "../types.js"
import { crawlerCollector } from "./crawler.js"

const PAGES: Record<string, string> = {
  "http://site.test/": `<a href="/a">a</a><a href="/b">b</a><a href="http://evil.com/x">e</a>`,
  "http://site.test/a": `<form action="/login" method="post"><input name="user"><input name="pass"></form>`,
  "http://site.test/b": `<p>leaf</p>`,
}

function makeCtx(emitted: Observation[], maxItems?: number): CollectorCtx {
  const net: ScopedHttp = {
    fetch: async (req) => ({ status: 200, headers: {}, body: PAGES[req.url] ?? "", bytes: 0, ms: 1, finalUrl: req.url }),
  }
  return {
    scope: createScopeGuard({ hosts: ["site.test"], denyPrivate: true }),
    net,
    scheduler: createScheduler({ defaultRps: 1000 }),
    emit: (o) => emitted.push(o),
    workspace: createInMemoryStores(),
    signal: new AbortController().signal,
    log: () => {},
    budget: maxItems != null ? { maxItems } : undefined,
  }
}

describe("crawlerCollector", () => {
  test("crawls in-scope pages, emits form endpoint, ignores out-of-scope links", async () => {
    const emitted: Observation[] = []
    await crawlerCollector.run(makeCtx(emitted), { seeds: ["http://site.test/"] })

    const urls = emitted.filter((o) => o.kind === "endpoint").map((o) => (o.kind === "endpoint" ? o.url : ""))
    expect(urls).toContain("http://site.test/")
    expect(urls).toContain("http://site.test/a")
    expect(urls).toContain("http://site.test/b")
    // out-of-scope link never fetched/emitted
    expect(urls.some((u) => u.includes("evil.com"))).toBe(false)

    const form = emitted.find((o) => o.kind === "endpoint" && o.method === "POST")
    expect(form).toBeDefined()
    if (form && form.kind === "endpoint") {
      expect(form.url).toBe("http://site.test/login")
      expect(form.params?.map((p) => p.name).sort()).toEqual(["pass", "user"])
    }
  })

  test("respects the page budget and reports truncation", async () => {
    const emitted: Observation[] = []
    const res = await crawlerCollector.run(makeCtx(emitted, 2), { seeds: ["http://site.test/"] })
    const pageGets = emitted.filter((o) => o.kind === "endpoint" && o.method === "GET").length
    expect(pageGets).toBeLessThanOrEqual(2)
    expect(res.truncated).toBe(true)
  })
})
