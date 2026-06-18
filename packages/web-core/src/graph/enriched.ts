// ── Enriched graph builder (the moat) ─────────────────────────────────────────
// Ported from exodus/src/main/graphBuilder.ts, re-keyed from gaze CDPEvent onto
// opencode CaptureRecord. Produces the labeled-property-graph: typed semantic
// edges, risk classification, tags, and LLM-prose descriptions. Pure: captures in
// → Graph out. DECOUPLED from the base graph (graph/base.ts) — they share only
// the input and a node-id convention, so either can change without the other.

import { createHash } from "node:crypto"
import { type CaptureRecord, type FormRecord, type NavRecord, headerMap } from "../capture-source.js"
import { type Graph, type GraphEdge, type GraphNode, type NodeKind, type RiskLevel, RISK_ORDER } from "../types.js"

// ── id + url helpers ──────────────────────────────────────────────────────────
function sha8(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8)
}
function nodeId(kind: NodeKind, url: string): string {
  return `${kind.toLowerCase()}-${sha8(kind + url)}`
}
function edgeId(source: string, kind: string, target: string): string {
  return `${source}::${kind}::${target}`
}
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
function originOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return url
  }
}
function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

// ── normalized observation (one capture or nav) ───────────────────────────────
interface Norm {
  url: string
  method?: string
  status?: number
  resourceType?: string
  reqH: Record<string, string>
  resH: Record<string, string>
  initiator?: string
  ts: number
  captureId?: string
  isNav: boolean
}

function normCapture(c: CaptureRecord): Norm {
  return {
    url: c.url,
    method: c.method,
    status: c.status,
    resourceType: c.resourceType,
    reqH: headerMap(c.requestHeaders),
    resH: headerMap(c.responseHeaders),
    initiator: c.initiatorUrl,
    ts: c.tsRequest,
    captureId: c.id,
    isNav: c.resourceType === "Document",
  }
}

// ── heuristics (identical to the gaze builder) ────────────────────────────────
function detectTags(n: Norm): string[] {
  const tags: string[] = []
  const url = n.url.toLowerCase()
  if (n.method === "POST" || n.method === "PUT" || n.method === "DELETE") tags.push("mutating")
  if (n.reqH["authorization"] || n.reqH["x-api-key"] || url.includes("/auth") || url.includes("/login") || url.includes("/token"))
    tags.push("auth")
  const cors = n.resH["access-control-allow-origin"]
  if (cors === "*") tags.push("cors-wildcard")
  else if (cors) tags.push("cors")
  if (!n.resH["content-security-policy"] && n.isNav) tags.push("no-csp")
  if (!n.resH["x-frame-options"] && n.isNav) tags.push("no-x-frame")
  const ct = n.resH["content-type"] ?? ""
  if (ct.includes("application/json")) tags.push("json")
  if (ct.includes("text/html")) tags.push("html")
  if (n.resourceType === "Script") tags.push("script")
  if (n.resourceType === "Stylesheet") tags.push("css")
  if (n.resourceType === "Image") tags.push("image")
  return tags
}

function inferRisk(n: Norm, tags: string[]): RiskLevel {
  const url = n.url.toLowerCase()
  if (tags.includes("cors-wildcard")) return "high"
  if (tags.includes("no-csp")) return "medium"
  if (tags.includes("auth")) return "medium"
  if (url.includes("/admin")) return "high"
  if (url.includes("/internal")) return "high"
  if (url.includes("/graphql")) return "medium"
  if (url.includes("/api/") && n.method === "POST") return "medium"
  return "none"
}

function buildDescription(n: Norm, tags: string[]): string {
  const parts: string[] = []
  if (n.method) parts.push(`Method: ${n.method}`)
  if (n.status) parts.push(`Status: ${n.status}`)
  if (n.resH["server"]) parts.push(`Server: ${n.resH["server"]}`)
  if (n.resH["x-powered-by"]) parts.push(`Powered-by: ${n.resH["x-powered-by"]}`)
  if (n.resH["content-type"]) parts.push(`Content-Type: ${n.resH["content-type"]}`)
  const interesting = ["cors-wildcard", "auth", "no-csp", "mutating"]
  const flagged = tags.filter((t) => interesting.includes(t))
  if (flagged.length) parts.push(`Flags: ${flagged.join(", ")}`)
  return parts.join(" · ") || "Observed via capture"
}

function isDataEndpoint(n: Norm): boolean {
  const rt = (n.resourceType ?? "").toLowerCase()
  if (rt === "xhr" || rt === "fetch") return true
  if (n.method && n.method !== "GET") return true
  const url = n.url.toLowerCase()
  return url.includes("/api/") || url.includes("/graphql") || url.endsWith(".json")
}
function isExternal(n: Norm): boolean {
  if (!n.initiator) return false
  return hostnameOf(n.initiator) !== hostnameOf(n.url)
}

// ── upsert (merge) helpers ────────────────────────────────────────────────────
function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}
function mergeCaptureIds(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const ai = (a?.["captureIds"] as string[] | undefined) ?? []
  const bi = (b?.["captureIds"] as string[] | undefined) ?? []
  if (ai.length === 0 && bi.length === 0) return a ?? b
  const ids = Array.from(new Set([...bi, ...ai])).slice(0, 500) // most-recent (b) first
  return { ...(a ?? {}), ...(b ?? {}), captureIds: ids }
}

class Builder {
  nodes = new Map<string, GraphNode>()
  edges = new Map<string, GraphEdge>()

  node(n: GraphNode): void {
    const e = this.nodes.get(n.id)
    if (!e) {
      this.nodes.set(n.id, n)
      return
    }
    this.nodes.set(n.id, {
      ...e,
      ...n,
      risk: higherRisk(e.risk, n.risk),
      firstSeen: Math.min(e.firstSeen, n.firstSeen),
      lastSeen: Math.max(e.lastSeen, n.lastSeen),
      tags: Array.from(new Set([...e.tags, ...n.tags])),
      metadata: mergeCaptureIds(e.metadata, n.metadata),
    })
  }

  edge(e: GraphEdge): void {
    const x = this.edges.get(e.id)
    if (!x) {
      this.edges.set(e.id, e)
      return
    }
    this.edges.set(e.id, {
      ...x,
      weight: x.weight + e.weight,
      firstSeen: Math.min(x.firstSeen, e.firstSeen),
      lastSeen: Math.max(x.lastSeen, e.lastSeen),
    })
  }
}

export function buildEnrichedGraph(input: { captures: CaptureRecord[]; navs?: NavRecord[]; forms?: FormRecord[] }): Graph {
  const b = new Builder()

  for (const c of input.captures) {
    const n = normCapture(c)
    if (n.isNav) handlePage(b, n)
    else handleRequest(b, n)
  }
  for (const nav of input.navs ?? []) {
    handlePage(b, { url: nav.url, reqH: {}, resH: {}, initiator: nav.initiatorUrl, ts: nav.ts, isNav: true })
  }
  for (const f of input.forms ?? []) {
    handleForm(b, f)
  }

  return { nodes: b.nodes, edges: b.edges, version: input.captures.length }
}

function handlePage(b: Builder, n: Norm): void {
  const tags = detectTags(n)
  const risk = inferRisk(n, tags)
  const now = n.ts
  const pageId = nodeId("Page", n.url)
  const domain = hostnameOf(n.url)
  const domainId = nodeId("Domain", domain)

  b.node({ id: domainId, kind: "Domain", label: domain, url: originOf(n.url), risk: "none", description: `Root domain for ${domain}`, tags: [], firstSeen: now, lastSeen: now })
  b.node({
    id: pageId,
    kind: "Page",
    label: pathOf(n.url) || "/",
    url: n.url,
    statusCode: n.status,
    risk,
    description: buildDescription(n, tags),
    tags,
    firstSeen: now,
    lastSeen: now,
    metadata: n.captureId ? { captureIds: [n.captureId] } : undefined,
  })
  b.edge({ id: edgeId(domainId, "HOSTS", pageId), kind: "HOSTS", source: domainId, target: pageId, label: "hosts", weight: 1, firstSeen: now, lastSeen: now })
  if (n.initiator) {
    const src = nodeId("Page", n.initiator)
    b.edge({ id: edgeId(src, "NAVIGATES_TO", pageId), kind: "NAVIGATES_TO", source: src, target: pageId, label: "→", weight: 1, firstSeen: now, lastSeen: now })
  }
}

function handleRequest(b: Builder, n: Norm): void {
  const tags = detectTags(n)
  const risk = inferRisk(n, tags)
  const now = n.ts
  const metadata = n.captureId ? { captureIds: [n.captureId] } : undefined

  let targetId: string
  let kind: NodeKind
  let label: string
  if (isExternal(n)) {
    const ext = hostnameOf(n.url)
    targetId = nodeId("ExternalService", ext)
    kind = "ExternalService"
    label = ext
  } else if (isDataEndpoint(n)) {
    targetId = nodeId("Endpoint", n.url)
    kind = "Endpoint"
    label = `${n.method ?? "GET"} ${pathOf(n.url)}`
  } else {
    targetId = nodeId("Resource", n.url)
    kind = "Resource"
    label = pathOf(n.url).split("/").pop() || pathOf(n.url)
  }

  b.node({ id: targetId, kind, label, url: n.url, method: kind === "Endpoint" ? n.method : undefined, statusCode: n.status, risk, description: buildDescription(n, tags), tags, firstSeen: now, lastSeen: now, metadata })

  if (n.initiator) {
    const src = nodeId("Page", n.initiator)
    const ek = isExternal(n) ? "CROSS_ORIGIN_CALL" : isDataEndpoint(n) ? "CALLS" : "LOADS"
    b.edge({ id: edgeId(src, ek, targetId), kind: ek, source: src, target: targetId, label: ek.toLowerCase().replace("_", " "), weight: 1, firstSeen: now, lastSeen: now })
  }
}

function handleForm(b: Builder, f: FormRecord): void {
  const now = f.ts
  const method = (f.method || "GET").toUpperCase()
  const formId = nodeId("Form", f.action)
  const sensitive: string[] = []
  if (f.inputs.some((i) => /password|passwd|pwd/i.test(i))) sensitive.push("password-field")
  if (f.inputs.some((i) => /credit|card|cvv|cvc/i.test(i))) sensitive.push("payment-field")
  if (f.inputs.some((i) => /token|csrf|_token/i.test(i))) sensitive.push("csrf-token")

  b.node({
    id: formId,
    kind: "Form",
    label: `${method} ${pathOf(f.action)}`,
    url: f.action,
    method,
    risk: sensitive.length ? "medium" : "none",
    description: `Form submits to ${f.action} via ${method}. Inputs: ${f.inputs.join(", ") || "unknown"}`,
    tags: sensitive,
    firstSeen: now,
    lastSeen: now,
  })
  const endpointId = nodeId("Endpoint", f.action)
  b.edge({ id: edgeId(formId, "SUBMITS_TO", endpointId), kind: "SUBMITS_TO", source: formId, target: endpointId, label: "submits to", weight: 1, firstSeen: now, lastSeen: now })
}
