import { describe, expect, test } from "bun:test"
import { buildEnrichedGraph } from "./enriched.js"
import { createSeedKnowledgeBase } from "../kb.js"
import type { CaptureRecord } from "../capture-source.js"
import type { GraphNode, NodeKind } from "../types.js"

// ── fixture helper ──────────────────────────────────────────────────────────────
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
const cookie = (v: string) => [{ name: "Cookie", value: `session=${v}` }]

function byKind(g: ReturnType<typeof buildEnrichedGraph>, kind: NodeKind): GraphNode[] {
  return [...g.nodes.values()].filter((n) => n.kind === kind)
}
function find(g: ReturnType<typeof buildEnrichedGraph>, pred: (n: GraphNode) => boolean): GraphNode | undefined {
  return [...g.nodes.values()].find(pred)
}

// ── principals ──────────────────────────────────────────────────────────────────
describe("principal fingerprinting", () => {
  test("distinct sessions become distinct principals; same session dedupes; no raw credential is stored", () => {
    const g = buildEnrichedGraph({
      captures: [
        cap({ url: "https://app.test/api/orders/1", requestHeaders: cookie("AAA") }),
        cap({ url: "https://app.test/api/orders/2", requestHeaders: cookie("AAA") }),
        cap({ url: "https://app.test/api/orders/1", requestHeaders: cookie("BBB") }),
      ],
    })
    const principals = byKind(g, "Principal")
    expect(principals.length).toBe(2)
    // the credential value never appears anywhere in the graph
    const dump = JSON.stringify([...g.nodes.values()])
    expect(dump).not.toContain("AAA")
    expect(dump).not.toContain("BBB")
    expect(dump).not.toContain("session=")
  })

  test("absent auth folds into a single anonymous principal", () => {
    const g = buildEnrichedGraph({
      captures: [cap({ url: "https://app.test/api/a" }), cap({ url: "https://app.test/api/b" })],
    })
    const principals = byKind(g, "Principal")
    expect(principals.length).toBe(1)
    expect(principals[0].tags).toContain("anonymous")
  })
})

// ── templating + cross-request correlation ───────────────────────────────────────
describe("endpoint templating + cross-request signals", () => {
  const g = buildEnrichedGraph({
    captures: [
      cap({ url: "https://app.test/api/orders/1", requestHeaders: cookie("AAA") }),
      cap({ url: "https://app.test/api/orders/2", requestHeaders: cookie("AAA") }),
      cap({ url: "https://app.test/api/orders/1", requestHeaders: cookie("BBB") }),
      cap({ url: "https://app.test/api/orders/2", requestHeaders: cookie("BBB") }),
    ],
  })
  const tmpl = byKind(g, "EndpointTemplate")[0]

  test("id-bearing instances collapse into one /{id} family", () => {
    expect(byKind(g, "EndpointTemplate").length).toBe(1)
    expect(tmpl.label).toBe("GET /api/orders/{id}")
    const instanceOf = [...g.edges.values()].filter((e) => e.kind === "INSTANCE_OF")
    expect(instanceOf.length).toBe(2) // orders/1 and orders/2
  })

  test("a family with many instances is tagged enumerable", () => {
    expect(tmpl.tags).toContain("enumerable")
  })

  test("a family reached by multiple principals is tagged multi-principal and raised to high risk", () => {
    expect(tmpl.tags).toContain("multi-principal")
    expect(tmpl.risk).toBe("high")
  })

  test("instances carry object-id and get ACCESSED_BY edges per principal", () => {
    const inst = find(g, (n) => n.kind === "Endpoint" && n.url === "https://app.test/api/orders/1")!
    expect(inst.tags).toContain("object-id")
    expect(inst.tags).toContain("multi-principal")
    const accessed = [...g.edges.values()].filter((e) => e.kind === "ACCESSED_BY" && e.target === inst.id)
    expect(accessed.length).toBe(2)
  })
})

// ── parameters ────────────────────────────────────────────────────────────────────
describe("parameter extraction + value-class", () => {
  test("a url-valued query param becomes a Parameter node and tags the endpoint", () => {
    const g = buildEnrichedGraph({
      captures: [cap({ url: "https://app.test/api/fetch?url=https://example.com/x", requestHeaders: cookie("AAA") })],
    })
    const param = byKind(g, "Parameter").find((p) => p.label === "url")!
    expect(param).toBeDefined()
    expect(param.metadata?.valueClass).toBe("url")
    const endpoint = find(g, (n) => n.kind === "Endpoint")!
    expect(endpoint.tags).toContain("param:url")
    expect([...g.edges.values()].some((e) => e.kind === "HAS_PARAM" && e.target === param.id)).toBe(true)
  })
})

// ── the payoff: candidate generation ──────────────────────────────────────────────
describe("candidate generation off SPG signals", () => {
  const kb = createSeedKnowledgeBase()
  const kbNode = (n: GraphNode) => ({ kind: n.kind, tags: n.tags, method: n.method, url: n.url, risk: n.risk })

  test("a multi-principal id family yields a high-confidence IDOR candidate", () => {
    const g = buildEnrichedGraph({
      captures: [
        cap({ url: "https://app.test/api/orders/1", requestHeaders: cookie("AAA") }),
        cap({ url: "https://app.test/api/orders/2", requestHeaders: cookie("BBB") }),
      ],
    })
    const tmpl = byKind(g, "EndpointTemplate")[0]
    const cands = kb.candidatesFor(kbNode(tmpl))
    const idor = cands.find((c) => c.vulnClass === "idor")
    expect(idor?.confidence).toBe("high")
  })

  test("a url param yields an SSRF candidate", () => {
    const g = buildEnrichedGraph({
      captures: [cap({ url: "https://app.test/api/fetch?url=https://example.com", requestHeaders: cookie("AAA") })],
    })
    const endpoint = find(g, (n) => n.kind === "Endpoint")!
    const cands = kb.candidatesFor(kbNode(endpoint))
    expect(cands.some((c) => c.vulnClass === "ssrf")).toBe(true)
  })

  test("candidates are de-duplicated to one per vuln class", () => {
    const g = buildEnrichedGraph({
      captures: [cap({ url: "https://app.test/api/items/5?q=hi", requestHeaders: cookie("AAA") })],
    })
    const endpoint = find(g, (n) => n.kind === "Endpoint")!
    const cands = kb.candidatesFor(kbNode(endpoint))
    expect(new Set(cands.map((c) => c.vulnClass)).size).toBe(cands.length)
  })
})
