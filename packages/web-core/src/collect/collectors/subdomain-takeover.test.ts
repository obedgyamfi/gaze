import { describe, expect, test } from "bun:test"
import { createInMemoryStores } from "../../stores.js"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { CollectorCtx, Observation, ScopedHttp } from "../types.js"
import { matchTakeover } from "../takeover-fingerprints.js"
import { subdomainTakeoverCollector } from "./subdomain-takeover.js"

describe("matchTakeover", () => {
  test("detects a github-pages claim-me page", () => {
    expect(matchTakeover("There isn't a GitHub Pages site here.")?.service).toBe("github-pages")
  })
  test("no match on a normal page", () => {
    expect(matchTakeover("<html><body>welcome</body></html>")).toBeUndefined()
  })
})

describe("subdomainTakeoverCollector", () => {
  test("flags a dangling host, ignores a healthy one", async () => {
    const net: ScopedHttp = {
      fetch: async (req) => {
        const host = new URL(req.url).hostname
        const body = host === "dangling.a.test" ? "There isn't a GitHub Pages site here." : "<html>ok</html>"
        return { status: host === "dangling.a.test" ? 404 : 200, headers: {}, body, bytes: body.length, ms: 1, finalUrl: req.url }
      },
    }
    const emitted: Observation[] = []
    const ctx: CollectorCtx = {
      scope: createScopeGuard({ hosts: ["*.a.test"], denyPrivate: true }),
      net,
      scheduler: createScheduler({ defaultRps: 1000 }),
      emit: (o) => emitted.push(o),
      workspace: createInMemoryStores(),
      signal: new AbortController().signal,
      log: () => {},
    }
    const res = await subdomainTakeoverCollector.run(ctx, { hosts: ["dangling.a.test", "healthy.a.test"] })
    expect(res.emitted).toBe(1)
    const obs = emitted[0]
    expect(obs.kind).toBe("takeover")
    if (obs.kind === "takeover") {
      expect(obs.host).toBe("dangling.a.test")
      expect(obs.service).toBe("github-pages")
    }
  })
})
