import { describe, expect, test } from "bun:test"
import { createInMemoryStores } from "../../stores.js"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { CollectorCtx, Observation, ScopedHttp } from "../types.js"
import { jsAnalyzerCollector } from "./js-analyzer.js"

function ctxWith(net: ScopedHttp, emitted: Observation[]): CollectorCtx {
  return {
    scope: createScopeGuard({ hosts: ["*.a.test"], denyPrivate: true }),
    net,
    scheduler: createScheduler({ defaultRps: 1000 }),
    emit: (o) => emitted.push(o),
    workspace: createInMemoryStores(),
    signal: new AbortController().signal,
    log: () => {},
  }
}

describe("jsAnalyzerCollector", () => {
  test("emits a js observation with extracted endpoints + secret refs", async () => {
    const script = `fetch("https://api.a.test/v1/me"); const k="AKIAIOSFODNN7EXAMPLE";`
    const net: ScopedHttp = {
      fetch: async (req) => ({ status: 200, headers: {}, body: script, bytes: script.length, ms: 1, finalUrl: req.url }),
    }
    const emitted: Observation[] = []
    const res = await jsAnalyzerCollector.run(ctxWith(net, emitted), { urls: ["https://app.a.test/app.js"] })

    expect(res.emitted).toBe(1)
    const obs = emitted[0]
    expect(obs.kind).toBe("js")
    if (obs.kind === "js") {
      expect(obs.endpoints).toContain("https://api.a.test/v1/me")
      expect(obs.secrets.map((s) => s.class)).toContain("aws")
    }
  })

  test("skips a script that fails to fetch, continues the rest", async () => {
    const net: ScopedHttp = {
      fetch: async (req) => {
        if (req.url.includes("bad")) throw new Error("boom")
        return { status: 200, headers: {}, body: `fetch("/x")`, bytes: 10, ms: 1, finalUrl: req.url }
      },
    }
    const emitted: Observation[] = []
    const res = await jsAnalyzerCollector.run(ctxWith(net, emitted), {
      urls: ["https://a.test/bad.js", "https://a.test/good.js"],
    })
    expect(res.emitted).toBe(1)
  })
})
