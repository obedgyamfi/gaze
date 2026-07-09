import { describe, expect, test } from "bun:test"
import { createInMemoryStores } from "./stores.js"
import { createScheduler } from "./collect/scheduler.js"
import { createScopeGuard } from "./collect/scope.js"
import type { Observation, ScopedHttp } from "./collect/types.js"
import { COLLECT_TOOLS } from "./tools-collect.js"
import type { HandlerCtx } from "./tools.js"

const tool = (name: string) => COLLECT_TOOLS.find((t) => t.name === name)!

function ctxWith(net: ScopedHttp, ingested: Observation[]): HandlerCtx {
  const stores = createInMemoryStores()
  return {
    ...stores,
    collect: {
      scope: createScopeGuard({ hosts: ["*.a.test"], denyPrivate: true }),
      net,
      scheduler: createScheduler({ defaultRps: 1000 }),
      ingest: (o) => ingested.push(o),
    },
    signal: new AbortController().signal,
  } as unknown as HandlerCtx
}

describe("COLLECT_TOOLS", () => {
  test("all discovery tools are network (not read-only)", () => {
    expect(COLLECT_TOOLS.length).toBeGreaterThanOrEqual(6)
    expect(COLLECT_TOOLS.every((t) => t.readOnly === false)).toBe(true)
  })

  test("web_analyze_js folds a js observation into the graph", async () => {
    const script = `fetch("https://api.a.test/v1/me"); const k="AKIAIOSFODNN7EXAMPLE";`
    const net: ScopedHttp = {
      fetch: async (req) => ({ status: 200, headers: {}, body: script, bytes: script.length, ms: 1, finalUrl: req.url }),
    }
    const ingested: Observation[] = []
    const res = await tool("web_analyze_js").handler({ urls: ["https://app.a.test/app.js"] }, ctxWith(net, ingested))
    expect(res.data.scripts).toBe(1)
    expect(ingested.some((o) => o.kind === "js")).toBe(true)
  })

  test("refuses cleanly when the collection runtime is absent", async () => {
    const bare = createInMemoryStores() as unknown as HandlerCtx
    const res = await tool("web_crawl").handler({ seeds: ["https://app.a.test/"] }, bare)
    expect(res.data.error).toBeDefined()
  })
})
