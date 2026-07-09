import { describe, expect, test } from "bun:test"
import type { Graph } from "../types.js"
import { edgeId, nodeId } from "../graph/enriched.js"
import { createInMemoryStores } from "../stores.js"
import { foldObservation, foldObservations, observationId } from "./ingest.js"
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

  test("discovered endpoint/param/edge ids match the enriched-build helpers (collapse onto captured)", () => {
    const g = emptyGraph()
    const url = "https://a.test/api/x?y=1"
    foldObservation(
      g,
      { kind: "endpoint", method: "get", url, via, params: [{ name: "y", loc: "query" }] },
      1,
    )
    // The endpoint node is keyed exactly as buildEnrichedGraph would key the captured one,
    // so a later capture of the same url merges instead of forking a parallel node.
    const epId = nodeId("Endpoint", url)
    expect(g.nodes.has(epId)).toBe(true)
    // Query param keyed `owner?name` (enriched convention), and its edge via edgeId().
    const pid = nodeId("Parameter", `${epId}?y`)
    expect(g.nodes.has(pid)).toBe(true)
    expect(g.edges.has(edgeId(epId, "HAS_PARAM", pid))).toBe(true)
    // No leftover ad-hoc ids.
    expect([...g.nodes.keys()].some((k) => k.startsWith("ep:"))).toBe(false)
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

describe("foldObservations", () => {
  test("folds a batch, each at its own discovery time", () => {
    const g = emptyGraph()
    foldObservations(g, [
      { kind: "endpoint", method: "GET", url: "https://a.test/a", via: { collector: "c", at: 10 } },
      { kind: "endpoint", method: "GET", url: "https://a.test/b", via: { collector: "c", at: 20 } },
    ])
    const a = g.nodes.get(nodeId("Endpoint", "https://a.test/a"))!
    const b = g.nodes.get(nodeId("Endpoint", "https://a.test/b"))!
    expect(a.lastSeen).toBe(10) // used obs.via.at, not a shared clock
    expect(b.lastSeen).toBe(20)
  })

  test("re-folding a persisted set is idempotent (survives a rebuild without duplicating)", () => {
    const set: Observation[] = [{ kind: "endpoint", method: "GET", url: "https://a.test/x", via: { collector: "c", at: 5 } }]
    const g = emptyGraph()
    foldObservations(g, set) // build 1
    foldObservations(g, set) // build 2 (rebuild re-applies the same stored set)
    expect([...g.nodes.values()].filter((n) => n.kind === "Endpoint").length).toBe(1)
  })
})

describe("observationId", () => {
  test("is stable across discovery time and property order (dedups replays)", () => {
    const a: Observation = { kind: "endpoint", method: "GET", url: "https://a.test/x", via: { collector: "crawler", at: 1 } }
    const b: Observation = { kind: "endpoint", url: "https://a.test/x", method: "GET", via: { at: 999, collector: "crawler" } }
    expect(observationId(a)).toBe(observationId(b))
  })

  test("distinguishes different findings", () => {
    const a: Observation = { kind: "endpoint", method: "GET", url: "https://a.test/x", via: { collector: "c", at: 1 } }
    const b: Observation = { kind: "endpoint", method: "POST", url: "https://a.test/x", via: { collector: "c", at: 1 } }
    expect(observationId(a)).not.toBe(observationId(b))
  })
})

describe("in-memory ObservationStore", () => {
  test("put is idempotent by content; list round-trips", () => {
    const { observations } = createInMemoryStores()
    const obs: Observation = { kind: "endpoint", method: "GET", url: "https://a.test/x", via: { collector: "c", at: 1 } }
    observations.put(obs)
    observations.put({ ...obs, via: { collector: "c", at: 2 } }) // same finding, later time
    expect(observations.list().length).toBe(1)
    // and the stored set folds back into a graph as the same node
    const g = emptyGraph()
    foldObservations(g, observations.list())
    expect(g.nodes.has(nodeId("Endpoint", "https://a.test/x"))).toBe(true)
  })
})
