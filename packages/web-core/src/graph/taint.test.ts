import { describe, expect, test } from "bun:test"
import { buildEnrichedGraph } from "./enriched.js"
import { enrichTaint, type TaintObservation } from "./taint.js"
import { createSeedKnowledgeBase } from "../kb.js"
import type { CaptureRecord } from "../capture-source.js"
import type { Graph, GraphNode, NodeKind } from "../types.js"

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"

let seq = 0
function cap(p: Partial<CaptureRecord> & { url: string }): CaptureRecord {
  const u = new URL(p.url)
  return {
    id: `c${seq}`,
    seq: seq++,
    source: "browser",
    tsRequest: seq,
    method: "GET",
    host: u.host,
    path: u.pathname,
    query: u.search.slice(1) || undefined,
    scheme: u.protocol.replace(":", ""),
    resourceType: "XHR",
    initiatorUrl: `${u.protocol}//${u.host}/app`,
    requestHeaders: [],
    ...p,
  } as CaptureRecord
}
const bearer = (t: string) => [{ name: "Authorization", value: `Bearer ${t}` }]

function build(captures: CaptureRecord[], obs?: TaintObservation[]): Graph {
  const g = buildEnrichedGraph({ captures })
  enrichTaint(g, obs ?? captures.map((c) => ({ capture: c })))
  return g
}
const byKind = (g: Graph, k: NodeKind) => [...g.nodes.values()].filter((n) => n.kind === k)
const find = (g: Graph, p: (n: GraphNode) => boolean) => [...g.nodes.values()].find(p)

// ── cross-boundary secret leak ────────────────────────────────────────────────
describe("cross-boundary secret leak", () => {
  const g = build([
    cap({ url: "https://app.test/", resourceType: "Document" }),
    cap({ url: "https://app.test/api/me", requestHeaders: bearer(JWT) }),
    cap({ url: "https://analytics.evil/collect", initiatorUrl: "https://app.test/", requestHeaders: bearer(JWT) }),
  ])

  test("the same token sent first-party and third-party is flagged a cross-boundary leak at high risk", () => {
    const v = byKind(g, "Value").find((n) => n.tags.includes("value:jwt"))!
    expect(v).toBeDefined()
    expect(v.tags).toContain("cross-boundary-leak")
    expect(v.risk).toBe("high")
  })

  test("the raw credential never enters the graph — only its fingerprint", () => {
    expect(JSON.stringify([...g.nodes.values()])).not.toContain(JWT)
  })

  test("a FLOWS_TO edge to the third-party node is marked crossesBoundary", () => {
    const crossing = [...g.edges.values()].filter((e) => e.kind === "FLOWS_TO" && e.metadata?.["crossesBoundary"])
    expect(crossing.length).toBeGreaterThanOrEqual(1)
  })
})

// ── trust zones ────────────────────────────────────────────────────────────────
describe("trust zones", () => {
  const g = build([
    cap({ url: "https://app.test/", resourceType: "Document" }),
    cap({ url: "https://analytics.evil/collect", initiatorUrl: "https://app.test/" }),
    cap({ url: "http://169.254.169.254/latest/meta-data", initiatorUrl: "https://app.test/" }),
  ])

  test("hosts bucket into first-party / third-party / internal TrustZone nodes with IN_ZONE edges", () => {
    const zones = byKind(g, "TrustZone").map((n) => n.label).sort()
    expect(zones).toEqual(["first-party", "internal", "third-party"])
    expect([...g.edges.values()].some((e) => e.kind === "IN_ZONE")).toBe(true)
  })
})

// ── reflected input ─────────────────────────────────────────────────────────────
describe("reflected input", () => {
  const search = cap({ url: "https://app.test/search?q=REFLECTED_MARKER_123" })
  const g = build([cap({ url: "https://app.test/", resourceType: "Document" }), search], [
    { capture: search, responseText: "<div>you searched for REFLECTED_MARKER_123</div>" },
  ])

  test("a request value echoed un-encoded tags the node reflected and adds a REFLECTS edge", () => {
    const ep = find(g, (n) => n.kind === "Endpoint" && (n.url ?? "").includes("/search"))!
    expect(ep.tags).toContain("reflected")
    expect([...g.edges.values()].some((e) => e.kind === "REFLECTS" && e.target === ep.id)).toBe(true)
  })

  test("a value present in the request but absent from the response is NOT reflected", () => {
    const other = cap({ url: "https://app.test/lookup?q=NOTECHOED_VALUE_9" })
    const g2 = build([other], [{ capture: other, responseText: "<div>no echo here</div>" }])
    expect(find(g2, (n) => n.kind === "Endpoint")!.tags).not.toContain("reflected")
  })
})

// ── candidate generation off taint signals ──────────────────────────────────────
describe("candidate generation off taint signals", () => {
  const kb = createSeedKnowledgeBase()
  const kbNode = (n: GraphNode) => ({ kind: n.kind, tags: n.tags, method: n.method, url: n.url, risk: n.risk })

  test("a reflected node yields a high-confidence XSS candidate", () => {
    const s = cap({ url: "https://app.test/q?term=PAYLOAD_MARKER_42" })
    const g = build([s], [{ capture: s, responseText: "echo PAYLOAD_MARKER_42 back" }])
    const ep = find(g, (n) => n.kind === "Endpoint")!
    expect(kb.candidatesFor(kbNode(ep)).find((c) => c.vulnClass === "xss")?.confidence).toBe("high")
  })

  test("a leaked secret value yields an info-leak candidate", () => {
    const g = build([
      cap({ url: "https://app.test/", resourceType: "Document" }),
      cap({ url: "https://app.test/api/me", requestHeaders: bearer(JWT) }),
      cap({ url: "https://analytics.evil/collect", initiatorUrl: "https://app.test/", requestHeaders: bearer(JWT) }),
    ])
    const v = byKind(g, "Value").find((n) => n.tags.includes("cross-boundary-leak"))!
    expect(kb.candidatesFor(kbNode(v)).some((c) => c.vulnClass === "info-leak")).toBe(true)
  })
})
