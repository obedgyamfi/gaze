import { describe, expect, test } from "bun:test"
import type { Graph } from "../types.js"
import { foldObservation } from "./ingest.js"
import type { Observation } from "./types.js"

const emptyGraph = (): Graph => ({ nodes: new Map(), edges: new Map(), version: 0 })
const via = { collector: "test", at: 1 }

describe("foldObservation", () => {
  test("endpoint + params create nodes and HAS_PARAM edges", () => {
    const g = emptyGraph()
    foldObservation(
      g,
      { kind: "endpoint", method: "get", url: "https://a.test/api/x?y=1#frag", via, params: [{ name: "y", loc: "query" }] },
      1,
    )
    const ep = [...g.nodes.values()].find((n) => n.kind === "Endpoint")!
    expect(ep.method).toBe("GET")
    expect(ep.url).toBe("https://a.test/api/x?y=1") // fragment stripped
    expect([...g.nodes.values()].some((n) => n.kind === "Parameter" && n.label === "y")).toBe(true)
    expect([...g.edges.values()].some((e) => e.kind === "HAS_PARAM")).toBe(true)
  })

  test("is idempotent — replay bumps weight/lastSeen, no duplicates", () => {
    const g = emptyGraph()
    const obs: Observation = { kind: "endpoint", method: "GET", url: "https://a.test/x", via }
    foldObservation(g, obs, 1)
    foldObservation(g, obs, 2)
    const eps = [...g.nodes.values()].filter((n) => n.kind === "Endpoint")
    expect(eps.length).toBe(1)
    expect(eps[0].lastSeen).toBe(2)
  })

  test("js observation folds endpoints + secret refs (fingerprint only)", () => {
    const g = emptyGraph()
    foldObservation(
      g,
      {
        kind: "js",
        url: "https://a.test/app.js",
        endpoints: ["https://a.test/api/hidden"],
        secrets: [{ hash: "abc123", class: "aws", entropy: 4.2 }],
        via,
      },
      1,
    )
    expect([...g.nodes.values()].some((n) => n.kind === "JsAsset")).toBe(true)
    expect([...g.nodes.values()].some((n) => n.kind === "Endpoint" && n.url === "https://a.test/api/hidden")).toBe(true)
    const secret = [...g.nodes.values()].find((n) => n.kind === "SecretRef")!
    expect(secret.risk).toBe("high")
    // the raw secret value must never appear anywhere in the graph
    expect(JSON.stringify([...g.nodes.values()])).not.toContain("value")
  })

  test("takeover marks the host critical", () => {
    const g = emptyGraph()
    foldObservation(
      g,
      { kind: "takeover", host: "dangling.a.test", service: "github-pages", fingerprint: "There isn't a GitHub Pages site here.", confidence: 0.9, via },
      1,
    )
    const host = g.nodes.get("host:dangling.a.test")!
    expect(host.risk).toBe("critical")
    expect(host.tags).toContain("takeover")
  })

  test("cert SANs become asset-discovery edges", () => {
    const g = emptyGraph()
    foldObservation(
      g,
      { kind: "cert", host: "a.test", sans: ["a.test", "internal.a.test"], issuer: "R3", notAfter: 0, via },
      1,
    )
    expect([...g.edges.values()].some((e) => e.kind === "RESOLVES_TO" && e.target === "host:internal.a.test")).toBe(true)
  })
})
