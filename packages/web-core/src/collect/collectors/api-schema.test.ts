import { describe, expect, test } from "bun:test"
import { createInMemoryStores } from "../../stores.js"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { CollectorCtx, Observation, ScopedHttp } from "../types.js"
import { detectSchemaKind, parseGraphqlIntrospection, parseOpenApi } from "../api-schema.js"
import { apiSchemaCollector } from "./api-schema.js"

describe("parseOpenApi", () => {
  test("expands paths × methods with params and body", () => {
    const doc = {
      openapi: "3.0.0",
      servers: [{ url: "https://api.a.test/v1" }],
      paths: {
        "/orders/{id}": {
          get: { parameters: [{ name: "id", in: "path" }] },
          post: { requestBody: {} },
        },
      },
    }
    const eps = parseOpenApi(doc)
    expect(eps.length).toBe(2)
    const get = eps.find((e) => e.method === "GET")!
    expect(get.url).toBe("https://api.a.test/v1/orders/{id}")
    expect(get.params).toEqual([{ name: "id", loc: "path" }])
    expect(eps.find((e) => e.method === "POST")!.params.some((p) => p.loc === "body")).toBe(true)
  })
})

describe("parseGraphqlIntrospection", () => {
  test("emits a POST op per root query/mutation field", () => {
    const doc = {
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: { name: "Mutation" },
          types: [
            { name: "Query", fields: [{ name: "me" }, { name: "orders" }] },
            { name: "Mutation", fields: [{ name: "deleteUser" }] },
          ],
        },
      },
    }
    const eps = parseGraphqlIntrospection(doc, "https://a.test/graphql")
    expect(eps.length).toBe(3)
    expect(eps.every((e) => e.method === "POST" && e.url === "https://a.test/graphql")).toBe(true)
    expect(eps.map((e) => e.params[0].name).sort()).toEqual(["deleteUser", "me", "orders"])
  })
})

describe("detectSchemaKind", () => {
  test("classifies", () => {
    expect(detectSchemaKind({ paths: {} })).toBe("openapi")
    expect(detectSchemaKind({ __schema: {} })).toBe("graphql")
    expect(detectSchemaKind({ nope: 1 })).toBe("unknown")
  })
})

describe("apiSchemaCollector", () => {
  test("fetches + emits endpoints (scope-gated)", async () => {
    const doc = { openapi: "3.0.0", servers: [{ url: "https://api.a.test" }], paths: { "/users": { get: {} } } }
    const net: ScopedHttp = {
      fetch: async (req) => {
        const b = JSON.stringify(doc)
        return { status: 200, headers: {}, body: b, bytes: b.length, ms: 1, finalUrl: req.url }
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
    const res = await apiSchemaCollector.run(ctx, { url: "https://api.a.test/openapi.json" })
    expect(res.emitted).toBe(1)
    expect(emitted[0].kind).toBe("endpoint")
  })
})
