import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { createScheduler } from "./scheduler.js"
import { createScopeGuard, ScopeViolation } from "./scope.js"
import { createNodeHttp } from "./http-node.js"

let server: Server
let port = 0

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === "/ok") return new Response("hello", { status: 200 })
      if (u.pathname === "/big") return new Response("X".repeat(10_000), { status: 200 })
      if (u.pathname === "/redir-in") return new Response(null, { status: 302, headers: { location: `http://app.test:${port}/ok` } })
      if (u.pathname === "/redir-out") return new Response(null, { status: 302, headers: { location: "http://evil.com/" } })
      return new Response("nope", { status: 404 })
    },
  })
  port = server.port
})
afterAll(() => server.stop(true))

// Everything resolves to the local server; scope is by hostname so we can prove
// scope/redirect/pinning behavior without real DNS.
const make = (opts?: { denyPrivate?: boolean; resolveTo?: string }) => {
  const scope = createScopeGuard({ hosts: ["app.test", "*.test"], denyPrivate: opts?.denyPrivate ?? false })
  const scheduler = createScheduler({ defaultRps: 1000 })
  return createNodeHttp({ scope, scheduler, resolve: async () => opts?.resolveTo ?? "127.0.0.1" })
}

describe("createNodeHttp", () => {
  test("fetches an in-scope URL", async () => {
    const res = await make().fetch({ method: "GET", url: `http://app.test:${port}/ok` })
    expect(res.status).toBe(200)
    expect(res.body).toBe("hello")
  })

  test("refuses an out-of-scope host before connecting", async () => {
    await expect(make().fetch({ method: "GET", url: "http://evil.com/" })).rejects.toBeInstanceOf(ScopeViolation)
  })

  test("re-checks scope on redirect — follows in-scope, blocks out-of-scope", async () => {
    const inRes = await make().fetch({ method: "GET", url: `http://app.test:${port}/redir-in` })
    expect(inRes.status).toBe(200)
    expect(inRes.body).toBe("hello")
    await expect(make().fetch({ method: "GET", url: `http://app.test:${port}/redir-out` })).rejects.toBeInstanceOf(
      ScopeViolation,
    )
  })

  test("blocks a host that resolves to a private address when denyPrivate", async () => {
    const http = make({ denyPrivate: true, resolveTo: "10.0.0.5" })
    await expect(http.fetch({ method: "GET", url: `http://app.test:${port}/ok` })).rejects.toBeInstanceOf(ScopeViolation)
  })

  test("caps the response body at maxBytes but reports true size", async () => {
    const res = await make().fetch({ method: "GET", url: `http://app.test:${port}/big`, maxBytes: 100 })
    expect(res.body.length).toBe(100)
    expect(res.bytes).toBeGreaterThanOrEqual(100)
  })
})
