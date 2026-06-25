// ── Taint pass — data-flow enrichment over the built SPG ──────────────────────
// The async layer the synchronous enriched builder can't do: it reads request +
// response BODIES and correlates VALUES across observations. A value produced in
// one response and later sent in another request is a FLOWS_TO edge; a request
// value echoed un-encoded in its own response is REFLECTS; a secret that reaches a
// different trust zone is a cross-boundary leak. Hosts are bucketed into TrustZone
// nodes (IN_ZONE) so the trust-boundary lens has regions to draw.
//
// Hard rule #1 holds here too: VALUES ARE STORED AS FINGERPRINTS (hashHex) — the raw
// secret/email is used to correlate and then discarded. Pure: graph + observations
// in, graph mutated in place. The store feeds it bodies; tests feed fixtures.

import { hashHex } from "./hash.js"
import { nodeId, edgeId, resolveCaptureNode } from "./enriched.js"
import { headerMap, type CaptureRecord } from "../capture-source.js"
import { type Graph, type GraphEdge, type GraphNode, type RiskLevel, RISK_ORDER } from "../types.js"

export interface TaintObservation {
  capture: CaptureRecord
  /** Request body text, if available. */
  requestText?: string
  /** Response body text, if available. */
  responseText?: string
}

type Zone = "first-party" | "third-party" | "internal"

// ── value extraction ───────────────────────────────────────────────────────────
// Response bodies are scanned only for unambiguous classes (low false-positive).
// Secrets in flight come from request auth material, where we KNOW the role.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SESSION_COOKIE = /sess|sid|token|auth|jwt|login|account/i
const SCAN_CAP = 64 * 1024 // never scan more than 64KB of a body
const PER_CLASS_CAP = 40 // bound matches per class per text

interface FoundValue {
  raw: string
  cls: string
}

function scanText(text: string | undefined): FoundValue[] {
  if (!text) return []
  const t = text.length > SCAN_CAP ? text.slice(0, SCAN_CAP) : text
  const out: FoundValue[] = []
  const collect = (re: RegExp, cls: string) => {
    let m: RegExpExecArray | null
    let count = 0
    re.lastIndex = 0
    while ((m = re.exec(t)) && count < PER_CLASS_CAP) {
      out.push({ raw: m[0], cls })
      count++
    }
  }
  collect(JWT_RE, "jwt")
  collect(EMAIL_RE, "email")
  collect(UUID_RE, "uuid")
  return out
}

function authValues(reqH: Record<string, string>): FoundValue[] {
  const out: FoundValue[] = []
  const authz = reqH["authorization"]
  if (authz) {
    const tok = authz.split(" ").slice(1).join(" ") || authz
    out.push({ raw: tok, cls: JWT_RE.test(tok) ? "jwt" : "secret" })
  }
  const apiKey = reqH["x-api-key"]
  if (apiKey) out.push({ raw: apiKey, cls: "api-key" })
  const cookie = reqH["cookie"]
  if (cookie) {
    for (const c of cookie.split(/;\s*/)) {
      const eq = c.indexOf("=")
      if (eq <= 0) continue
      if (SESSION_COOKIE.test(c.slice(0, eq))) out.push({ raw: c.slice(eq + 1), cls: "secret" })
    }
  }
  return out
}

const SECRET_CLASSES = new Set(["jwt", "api-key", "secret"])
const REFLECT_MIN_LEN = 8 // ignore short values — too common to be a meaningful reflection

/** Param VALUES from the query string + a form-encoded body — the candidates for a
 *  reflected-input check (arbitrary strings, unlike the typed scanText classes). */
function paramValues(url: string, requestText?: string): string[] {
  const out: string[] = []
  try {
    for (const [, v] of new URL(url).searchParams) if (v) out.push(v)
  } catch {
    /* ignore */
  }
  if (requestText && /^[^=&\s]+=[^=&\s]*(&|$)/.test(requestText)) {
    for (const pair of requestText.split("&")) {
      const eq = pair.indexOf("=")
      if (eq > 0) out.push(decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")))
    }
  }
  return out
}

// ── zone classification ──────────────────────────────────────────────────────
const INTERNAL_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|metadata\.|.*\.internal$|.*\.local$|\[::1\])/i

function zoneOf(host: string, firstPartyHosts: Set<string>): Zone {
  if (INTERNAL_HOST.test(host)) return "internal"
  if (firstPartyHosts.has(host)) return "first-party"
  return "third-party"
}

// ── tiny graph mutators (taint works on the built Graph directly) ─────────────
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}
function upsertNode(g: Graph, n: GraphNode): void {
  const e = g.nodes.get(n.id)
  if (!e) {
    g.nodes.set(n.id, n)
    return
  }
  e.risk = higherRisk(e.risk, n.risk)
  e.tags = Array.from(new Set([...e.tags, ...n.tags]))
  e.lastSeen = Math.max(e.lastSeen, n.lastSeen)
  e.firstSeen = Math.min(e.firstSeen, n.firstSeen)
}
function addEdge(g: Graph, e: GraphEdge): void {
  const x = g.edges.get(e.id)
  if (!x) {
    g.edges.set(e.id, e)
    return
  }
  x.weight += e.weight
  if (e.metadata) x.metadata = { ...x.metadata, ...e.metadata }
}
function tagNode(g: Graph, id: string, tag: string): void {
  const n = g.nodes.get(id)
  if (n && !n.tags.includes(tag)) n.tags.push(tag)
}
function bumpRisk(g: Graph, id: string, to: RiskLevel): void {
  const n = g.nodes.get(id)
  if (n) n.risk = higherRisk(n.risk, to)
}

// ── aggregation ───────────────────────────────────────────────────────────────
interface ValAgg {
  fp: string
  cls: string
  len: number
  sources: Set<string> // node ids whose RESPONSE produced the value
  sinks: Set<string> // node ids whose REQUEST carried the value
  sinkZones: Map<string, Zone> // sink node id → its zone
  sourceZones: Set<Zone>
  reflectedAt: Set<string> // node ids where it appeared in BOTH request and response
}

export function enrichTaint(graph: Graph, observations: TaintObservation[]): void {
  const firstPartyHosts = new Set<string>()
  for (const n of graph.nodes.values()) if (n.kind === "Page" && n.url) firstPartyHosts.add(hostnameOf(n.url))

  const vals = new Map<string, ValAgg>()
  const usedZones = new Map<string, Zone>() // host → zone (for IN_ZONE wiring)

  const agg = (v: FoundValue): ValAgg => {
    const fp = hashHex(v.raw)
    let a = vals.get(fp)
    if (!a) {
      a = { fp, cls: v.cls, len: v.raw.length, sources: new Set(), sinks: new Set(), sinkZones: new Map(), sourceZones: new Set(), reflectedAt: new Set() }
      vals.set(fp, a)
    }
    if (SECRET_CLASSES.has(v.cls)) a.cls = v.cls // prefer the most sensitive label
    return a
  }

  for (const o of observations) {
    const { id: nodeIdOf } = resolveCaptureNode(o.capture)
    const host = hostnameOf(o.capture.url)
    const zone = zoneOf(host, firstPartyHosts)
    usedZones.set(host, zone)

    const reqH = headerMap(o.capture.requestHeaders)
    const sent = [...authValues(reqH), ...scanText(`${o.capture.url} ${o.requestText ?? ""}`)]
    const produced = scanText(o.responseText)

    const sentFps = new Set<string>()
    for (const v of sent) {
      const a = agg(v)
      a.sinks.add(nodeIdOf)
      a.sinkZones.set(nodeIdOf, zone)
      sentFps.add(a.fp)
    }
    for (const v of produced) {
      const a = agg(v)
      a.sources.add(nodeIdOf)
      a.sourceZones.add(zone)
      if (sentFps.has(a.fp)) a.reflectedAt.add(nodeIdOf) // typed value echoed un-encoded
    }

    // Reflected arbitrary input: a request param value echoed verbatim in the body.
    if (o.responseText) {
      for (const pv of paramValues(o.capture.url, o.requestText)) {
        if (pv.length < REFLECT_MIN_LEN || !o.responseText.includes(pv)) continue
        const a = agg({ raw: pv, cls: "input" })
        a.reflectedAt.add(nodeIdOf)
        a.sinks.add(nodeIdOf)
        a.sinkZones.set(nodeIdOf, zone)
      }
    }
  }

  const now = Date.now()

  // TrustZone nodes + Domain → zone membership.
  for (const [host, zone] of usedZones) {
    const zid = `zone-${zone}`
    upsertNode(graph, { id: zid, kind: "TrustZone", label: zone, risk: "none", description: `${zone} hosts.`, tags: ["zone", `zone:${zone}`], firstSeen: now, lastSeen: now })
    const did = nodeId("Domain", host)
    if (!graph.nodes.get(did)) {
      upsertNode(graph, { id: did, kind: "Domain", label: host, url: `https://${host}`, risk: "none", description: `Root domain for ${host}`, tags: [], firstSeen: now, lastSeen: now })
    }
    tagNode(graph, did, `zone:${zone}`)
    addEdge(graph, { id: edgeId(did, "IN_ZONE", zid), kind: "IN_ZONE", source: did, target: zid, label: "in zone", weight: 1, firstSeen: now, lastSeen: now })
  }

  // Value nodes + FLOWS_TO / REFLECTS edges + cross-boundary leak detection.
  for (const a of vals.values()) {
    const isSecret = SECRET_CLASSES.has(a.cls)
    const flows = a.sources.size > 0 && a.sinks.size > 0
    const reflected = a.reflectedAt.size > 0
    // Skip lone, non-sensitive values with no flow — pure noise.
    if (!isSecret && !flows && !reflected) continue

    const leakSinks = [...a.sinkZones].filter(([, z]) => z !== "first-party")
    const crossBoundary = isSecret && leakSinks.length > 0
    const vid = `value-${a.fp}`
    const tags = ["value", `value:${a.cls}`]
    if (crossBoundary) tags.push("cross-boundary-leak")
    if (reflected) tags.push("reflected-value")

    upsertNode(graph, {
      id: vid,
      kind: "Value",
      label: `${a.cls} ${a.fp}`,
      risk: crossBoundary ? "high" : isSecret ? "low" : "none",
      description: crossBoundary
        ? `${a.cls} value (fp ${a.fp}, ${a.len} chars) sent to a non-first-party zone — possible secret leak.`
        : `${a.cls} value (fp ${a.fp}, ${a.len} chars). Credential not stored.`,
      tags,
      firstSeen: now,
      lastSeen: now,
      metadata: { fingerprint: a.fp, valueClass: a.cls, length: a.len },
    })

    for (const [sink, z] of a.sinkZones) {
      const cross = isSecret && z !== "first-party"
      addEdge(graph, { id: edgeId(vid, "FLOWS_TO", sink), kind: "FLOWS_TO", source: vid, target: sink, label: "flows to", weight: 1, firstSeen: now, lastSeen: now, metadata: cross ? { crossesBoundary: true, toZone: z } : undefined })
      if (cross) bumpRisk(graph, sink, "medium")
    }
    for (const r of a.reflectedAt) {
      addEdge(graph, { id: edgeId(vid, "REFLECTS", r), kind: "REFLECTS", source: vid, target: r, label: "reflected in", weight: 1, firstSeen: now, lastSeen: now })
      tagNode(graph, r, "reflected")
      bumpRisk(graph, r, "medium")
    }
  }
}
