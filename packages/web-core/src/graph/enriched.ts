// ── Enriched graph builder (the moat) ─────────────────────────────────────────
// Ported from exodus/src/main/graphBuilder.ts, re-keyed from gaze CDPEvent onto
// opencode CaptureRecord. Produces the labeled-property-graph: typed semantic
// edges, risk classification, tags, and LLM-prose descriptions. Pure: captures in
// → Graph out. DECOUPLED from the base graph (graph/base.ts) — they share only
// the input and a node-id convention, so either can change without the other.

import { hashHex } from "./hash.js"
import { type CaptureRecord, type FormRecord, type NavRecord, headerMap } from "../capture-source.js"
import { type Graph, type GraphEdge, type GraphNode, type NodeKind, type RiskLevel, RISK_ORDER } from "../types.js"

// ── id + url helpers ──────────────────────────────────────────────────────────
export function nodeId(kind: NodeKind, url: string): string {
  return `${kind.toLowerCase()}-${hashHex(kind + url)}`
}
export function edgeId(source: string, kind: string, target: string): string {
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
function safeUrlObj(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

// ── SPG: principal fingerprinting ─────────────────────────────────────────────
// A principal is a distinct session/role, identified ONLY by a hash of its auth
// material — never the credential itself (hard rule: credentials never enter the
// graph). The raw token/cookie is hashed to derive the fingerprint and then
// discarded — never stored. Absent auth ⇒ the shared anonymous principal.
const SESSION_COOKIE = /sess|sid|token|auth|jwt|login|account|user|remember|csrf|xsrf/i
// Third-party analytics/ads cookies carry no app identity — exclude them so they
// don't split one real session into many "principals" (or fabricate one).
const TRACKING_COOKIE = /^(_ga|_gid|_gat|__gads?|_fbp|_fbc|_gcl|ajs_|_hj|mp_|amplitude|__utm|_pk_|optimizely|intercom|_clck|_clsk|_uet|_pin|_scid|datadog|_dd)/i

function principalFingerprint(reqH: Record<string, string>): { fp: string; scheme: string } | null {
  const parts: string[] = []
  let scheme = ""
  const authz = reqH["authorization"]
  if (authz) {
    parts.push(`authz:${authz}`)
    scheme = authz.split(" ")[0] || "Authorization"
  }
  const apiKey = reqH["x-api-key"]
  if (apiKey) {
    parts.push(`apikey:${apiKey}`)
    scheme ||= "ApiKey"
  }
  const cookie = reqH["cookie"]
  if (cookie) {
    const all = cookie
      .split(/;\s*/)
      .filter(Boolean)
      .map((c) => ({ raw: c, name: c.split("=")[0] ?? "" }))
    // Prefer cookies that NAME themselves a session; otherwise fall back to the whole
    // jar minus tracking cookies. A request with only tracking cookies stays anonymous.
    const named = all.filter((c) => SESSION_COOKIE.test(c.name))
    const chosen = named.length ? named : all.filter((c) => !TRACKING_COOKIE.test(c.name))
    if (chosen.length) {
      parts.push(`cookie:${chosen.map((c) => c.raw).sort().join(";")}`)
      scheme ||= "Cookie"
    }
  }
  if (parts.length === 0) return null
  return { fp: hashHex(parts.join("|")), scheme }
}

// ── SPG: endpoint templating ──────────────────────────────────────────────────
// Collapse id-bearing path segments so /orders/1 and /orders/2 share one family.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONGHEX_RE = /^[0-9a-f]{16,}$/i

function idClassOf(seg: string): string | null {
  if (/^\d+$/.test(seg)) return "{id}"
  if (UUID_RE.test(seg)) return "{uuid}"
  if (LONGHEX_RE.test(seg)) return "{hash}"
  return null
}
function templatePath(path: string): { template: string; hasId: boolean } {
  let hasId = false
  const template = path
    .split("/")
    .map((s) => {
      const c = s ? idClassOf(s) : null
      if (c) {
        hasId = true
        return c
      }
      return s
    })
    .join("/")
  return { template, hasId }
}

// ── SPG: parameter value-class ────────────────────────────────────────────────
const JWT_RE = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function valueClassOf(v: string): string {
  if (/^\d+$/.test(v)) return "numeric-id"
  if (UUID_RE.test(v)) return "uuid"
  if (JWT_RE.test(v)) return "jwt"
  if (EMAIL_RE.test(v)) return "email"
  if (/^https?:\/\//i.test(v) || v.startsWith("//")) return "url"
  return "opaque"
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

// ── capture → node resolution (one source of truth) ───────────────────────────
// handleRequest/handlePage AND the taint pass must agree on which node a capture
// maps to. Both go through here so node ids never drift between the two passes.
export interface ResolvedNode {
  id: string
  kind: NodeKind
  firstParty: boolean
}
function resolveNorm(n: Norm): ResolvedNode {
  if (n.isNav) return { id: nodeId("Page", n.url), kind: "Page", firstParty: true }
  if (isExternal(n)) return { id: nodeId("ExternalService", hostnameOf(n.url)), kind: "ExternalService", firstParty: false }
  if (isDataEndpoint(n)) return { id: nodeId("Endpoint", n.url), kind: "Endpoint", firstParty: true }
  return { id: nodeId("Resource", n.url), kind: "Resource", firstParty: true }
}
/** The SPG node id a capture maps to — used by the taint pass to align with the build. */
export function resolveCaptureNode(c: CaptureRecord): ResolvedNode {
  return resolveNorm(normCapture(c))
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

// ── SPG attach helpers — fold the security layer onto an instance node ─────────

/** Principal that made this observation → ACCESSED_BY the target. First-party only. */
function attachPrincipal(b: Builder, n: Norm, targetId: string, now: number): void {
  const pf = principalFingerprint(n.reqH)
  const id = pf ? `principal-${pf.fp}` : "principal-anon"
  const scheme = pf?.scheme ?? "none"
  b.node({
    id,
    kind: "Principal",
    label: pf ? `${pf.scheme} · ${pf.fp.slice(0, 6)}` : "anonymous",
    risk: "none",
    description: pf
      ? `Distinct ${scheme} session (fingerprint ${pf.fp}). Credential not stored.`
      : "Unauthenticated / anonymous requests.",
    tags: pf ? ["principal", `auth:${scheme.toLowerCase()}`] : ["principal", "anonymous"],
    firstSeen: now,
    lastSeen: now,
    metadata: { fingerprint: pf?.fp ?? "anon", scheme },
  })
  b.edge({ id: edgeId(id, "ACCESSED_BY", targetId), kind: "ACCESSED_BY", source: id, target: targetId, label: "accessed", weight: 1, firstSeen: now, lastSeen: now })
}

/** id-bearing instance → INSTANCE_OF an EndpointTemplate. Returns true if templated. */
function attachTemplate(b: Builder, method: string | undefined, url: string, instanceId: string, now: number): boolean {
  const { template, hasId } = templatePath(pathOf(url))
  if (!hasId) return false
  const host = hostnameOf(url)
  const m = (method ?? "GET").toUpperCase()
  const tid = nodeId("EndpointTemplate", `${m} ${host}${template}`)
  b.node({
    id: tid,
    kind: "EndpointTemplate",
    label: `${m} ${template}`,
    method: m,
    risk: "none",
    description: `Endpoint family ${m} ${template} on ${host}.`,
    tags: ["template", "object-id"],
    firstSeen: now,
    lastSeen: now,
    metadata: { template, host },
  })
  b.edge({ id: edgeId(instanceId, "INSTANCE_OF", tid), kind: "INSTANCE_OF", source: instanceId, target: tid, label: "instance of", weight: 1, firstSeen: now, lastSeen: now })
  return true
}

/** Query parameters → Parameter nodes (HAS_PARAM). Also tags the owning node with
 *  each value-class so candidatesFor (which reads the node's tags) sees the signal. */
function attachQueryParams(b: Builder, url: string, ownerId: string, now: number): string[] {
  const u = safeUrlObj(url)
  if (!u) return []
  const classes: string[] = []
  for (const [name, value] of u.searchParams) {
    const cls = valueClassOf(value)
    classes.push(`param:${cls}`)
    const pid = nodeId("Parameter", `${ownerId}?${name}`)
    b.node({
      id: pid,
      kind: "Parameter",
      label: name,
      risk: "none",
      description: `Query parameter '${name}' (value-class ${cls}).`,
      tags: ["param", `param:${cls}`],
      firstSeen: now,
      lastSeen: now,
      metadata: { name, location: "query", valueClass: cls },
    })
    b.edge({ id: edgeId(ownerId, "HAS_PARAM", pid), kind: "HAS_PARAM", source: ownerId, target: pid, label: "param", weight: 1, firstSeen: now, lastSeen: now })
  }
  return classes
}

/** Push tags onto an already-upserted node (post-pass cross-request signals). */
function addTags(b: Builder, id: string, ...tags: string[]): void {
  const n = b.nodes.get(id)
  if (!n) return
  n.tags = Array.from(new Set([...n.tags, ...tags]))
}
function bumpRisk(b: Builder, id: string, to: RiskLevel): void {
  const n = b.nodes.get(id)
  if (n) n.risk = higherRisk(n.risk, to)
}

// ── SPG cross-request annotation ──────────────────────────────────────────────
// Signals only visible across the whole capture set: an endpoint family with many
// instances is enumerable; a resource (or family) reached by ≥2 principals is the
// IDOR/access-control smell. Runs once after all observations are folded in.
function annotateCrossRequest(b: Builder): void {
  const principalsByTarget = new Map<string, Set<string>>()
  const instancesByTemplate = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k)
    if (!s) m.set(k, (s = new Set()))
    s.add(v)
  }
  for (const e of b.edges.values()) {
    if (e.kind === "ACCESSED_BY") add(principalsByTarget, e.target, e.source)
    else if (e.kind === "INSTANCE_OF") add(instancesByTemplate, e.target, e.source)
  }

  // instance-level: a single resource served to multiple principals.
  for (const [target, principals] of principalsByTarget) {
    if (principals.size >= 2) {
      addTags(b, target, "multi-principal")
      if (b.nodes.get(target)?.tags.includes("object-id")) bumpRisk(b, target, "high")
    }
  }

  // template-level: enumerable families, and families touched by multiple principals.
  for (const [tid, instances] of instancesByTemplate) {
    if (instances.size >= 2) {
      addTags(b, tid, "enumerable")
      bumpRisk(b, tid, "medium")
    }
    const principalUnion = new Set<string>()
    for (const inst of instances) for (const p of principalsByTarget.get(inst) ?? []) principalUnion.add(p)
    if (principalUnion.size >= 2) {
      addTags(b, tid, "multi-principal")
      bumpRisk(b, tid, "high")
    }
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

  annotateCrossRequest(b)
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

  // SPG layer
  attachPrincipal(b, n, pageId, now)
  const params = attachQueryParams(b, n.url, pageId, now)
  const templated = attachTemplate(b, "GET", n.url, pageId, now)
  if (templated || params.length) addTags(b, pageId, ...(templated ? ["object-id"] : []), ...params)
}

function handleRequest(b: Builder, n: Norm): void {
  const tags = detectTags(n)
  const risk = inferRisk(n, tags)
  const now = n.ts
  const metadata = n.captureId ? { captureIds: [n.captureId] } : undefined

  const { id: targetId, kind } = resolveNorm(n)
  const label =
    kind === "ExternalService"
      ? hostnameOf(n.url)
      : kind === "Endpoint"
        ? `${n.method ?? "GET"} ${pathOf(n.url)}`
        : pathOf(n.url).split("/").pop() || pathOf(n.url)

  b.node({ id: targetId, kind, label, url: n.url, method: kind === "Endpoint" ? n.method : undefined, statusCode: n.status, risk, description: buildDescription(n, tags), tags, firstSeen: now, lastSeen: now, metadata })

  if (n.initiator) {
    const src = nodeId("Page", n.initiator)
    const ek = isExternal(n) ? "CROSS_ORIGIN_CALL" : isDataEndpoint(n) ? "CALLS" : "LOADS"
    b.edge({ id: edgeId(src, ek, targetId), kind: ek, source: src, target: targetId, label: ek.toLowerCase().replace("_", " "), weight: 1, firstSeen: now, lastSeen: now })
  }

  // SPG layer — first-party testable surface only (skip third-party services).
  if (!isExternal(n)) {
    attachPrincipal(b, n, targetId, now)
    const params = attachQueryParams(b, n.url, targetId, now)
    const templated = attachTemplate(b, n.method, n.url, targetId, now)
    if (templated || params.length) addTags(b, targetId, ...(templated ? ["object-id"] : []), ...params)
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

  // SPG layer — body inputs as Parameter nodes (value-class inferred from the name,
  // since form captures carry input names, not values), plus template the action.
  for (const name of f.inputs) {
    const cls = classFromName(name)
    const pid = nodeId("Parameter", `${formId}#${name}`)
    b.node({ id: pid, kind: "Parameter", label: name, risk: "none", description: `Body field '${name}' (value-class ${cls}).`, tags: ["param", `param:${cls}`], firstSeen: now, lastSeen: now, metadata: { name, location: "body", valueClass: cls } })
    b.edge({ id: edgeId(formId, "HAS_PARAM", pid), kind: "HAS_PARAM", source: formId, target: pid, label: "param", weight: 1, firstSeen: now, lastSeen: now })
    addTags(b, formId, `param:${cls}`)
  }
  if (attachTemplate(b, method, f.action, formId, now)) addTags(b, formId, "object-id")
}

/** Best-effort value-class for a form field from its NAME (values aren't captured). */
function classFromName(name: string): string {
  const n = name.toLowerCase()
  if (/(^|_)(url|uri|link|redirect|next|callback|return|dest)($|_)/.test(n)) return "url"
  if (/mail/.test(n)) return "email"
  if (/(^|_)(id|uid|userid|user_id|account|order|pid|doc)($|_|$)/.test(n)) return "numeric-id"
  return "opaque"
}
