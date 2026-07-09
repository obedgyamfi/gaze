// ── GraphStore — read logic over the enriched graph + capture evidence ────────
// Builds the enriched LPG from the CaptureSource (cached by version) and answers
// the read surface: overview / search / neighbors / paths / node / evidence /
// diff. Handlers stay thin; the algorithms live here.

import { createHash } from "node:crypto"
import { buildEnrichedGraph } from "./graph/enriched.js"
import { enrichTaint, type TaintObservation } from "./graph/taint.js"
import { foldObservations } from "./collect/ingest.js"
import type { Observation } from "./collect/types.js"
import type { CaptureRecord, CaptureSource, HeaderPair } from "./capture-source.js"
import {
  type CaptureSummaryRow,
  type DiffInput,
  type DiffResult,
  type EdgeRow,
  type EvidenceInput,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NeighborsInput,
  type NodeDetail,
  type NodeKind,
  type NodeRow,
  type OverviewResult,
  type Page,
  type PathsInput,
  type PathResult,
  type RiskLevel,
  RISK_ORDER,
  type SearchInput,
} from "./types.js"

const SENSITIVE = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"])

export interface CaptureBody {
  hash: string
  length: number
  contentType?: string
  truncated: boolean
  text?: string
}
export type EvidenceResult =
  | { mode: "list"; page: Page<CaptureSummaryRow> }
  | { mode: "detail"; capture: CaptureRecord; body?: CaptureBody }

export interface GraphStore {
  overview(input: { rootNodeIds?: string[]; hosts?: string[] }): Promise<OverviewResult>
  search(input: SearchInput): Promise<Page<NodeRow>>
  neighbors(input: NeighborsInput): Promise<{ nodes: NodeRow[]; edges: EdgeRow[]; graphVersion: number }>
  paths(input: PathsInput): Promise<{ paths: PathResult[]; graphVersion: number }>
  nodes(input: { ids: string[]; verbosity?: "compact" | "full" }): Promise<{ nodes: NodeDetail[]; graphVersion: number }>
  evidence(input: EvidenceInput): Promise<EvidenceResult>
  diff(input: DiffInput): Promise<DiffResult>
}

// ── helpers ───────────────────────────────────────────────────────────────────
function hostnameOf(url?: string): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}
function row(n: GraphNode): NodeRow {
  return { id: n.id, kind: n.kind, label: n.label, url: n.url, risk: n.risk, tags: n.tags }
}
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64")
}
function decodeCursor(cursor?: string): number {
  if (!cursor) return 0
  const n = Number(Buffer.from(cursor, "base64").toString("utf8"))
  return Number.isFinite(n) && n >= 0 ? n : 0
}
function paginate<T>(items: T[], limit: number, cursor: string | undefined, version: number): Page<T> {
  const offset = decodeCursor(cursor)
  const slice = items.slice(offset, offset + limit)
  const next = offset + limit
  return { items: slice, total: items.length, hasMore: next < items.length, nextCursor: next < items.length ? encodeCursor(next) : null, graphVersion: version }
}
function redact(pairs: HeaderPair[] | undefined): HeaderPair[] {
  return (pairs ?? []).map((p) => (SENSITIVE.has(p.name.toLowerCase()) ? { name: p.name, value: "[redacted]" } : p))
}
function captureIdsOf(n: GraphNode | undefined): string[] {
  const ids = n?.metadata?.["captureIds"]
  return Array.isArray(ids) ? (ids as string[]) : []
}
function summary(c: CaptureRecord): CaptureSummaryRow {
  return {
    id: c.id,
    tsRequest: c.tsRequest,
    method: c.method,
    host: c.host,
    path: c.path,
    query: c.query,
    status: c.status,
    contentType: c.responseBody?.contentType,
    responseSize: c.responseBody?.size ?? 0,
    durationMs: c.durationMs,
    source: c.source,
    starred: c.starred ?? false,
  }
}

// directed/undirected adjacency over edges
function adjacency(edges: Iterable<GraphEdge>, direction: "in" | "out" | "both"): Map<string, { to: string; edge: GraphEdge }[]> {
  const adj = new Map<string, { to: string; edge: GraphEdge }[]>()
  const push = (from: string, to: string, edge: GraphEdge) => {
    const l = adj.get(from)
    if (l) l.push({ to, edge })
    else adj.set(from, [{ to, edge }])
  }
  for (const e of edges) {
    if (direction === "out" || direction === "both") push(e.source, e.target, e)
    if (direction === "in" || direction === "both") push(e.target, e.source, e)
  }
  return adj
}

/** Read seam over the persisted ObservationStore — just enough for the graph build to
 *  re-fold discovered surface. `ObservationStore` satisfies this structurally. */
export interface ObservationSource {
  list(): Observation[] | Promise<Observation[]>
}

export function createEnrichedGraphStore(src: CaptureSource, observations?: ObservationSource): GraphStore {
  let cache: { key: string; graph: Graph } | null = null

  async function graph(): Promise<Graph> {
    const captures = await src.list()
    const navs = src.navs ? await src.navs() : []
    const forms = src.forms ? await src.forms() : []
    const version = src.version ? await src.version() : captures.length
    const obs = observations ? await observations.list() : []
    // Cache key spans BOTH inputs: a newly-persisted observation (obs.length grows)
    // invalidates the cache so discovered surface is re-folded even when captures are
    // unchanged. The store is append-only + content-addressed, so length is a faithful,
    // monotonic version for the observation set.
    const key = `${version}#${obs.length}`
    if (cache && cache.key === key) return cache.graph
    const g = buildEnrichedGraph({ captures, navs, forms })
    // graphVersion reflects both inputs (both monotonic non-decreasing) so a client sees
    // a bump when EITHER captures or discovered observations change.
    g.version = version + obs.length
    // Taint pass (async, body-correlated). Best-effort — never blocks the build.
    try {
      await enrichTaint(g, await taintObservations(captures))
    } catch {
      /* taint enrichment is additive; a body-read failure must not break reads */
    }
    // Fold persisted discovery AFTER the captured build + taint: ingest keys endpoints/
    // params with the same nodeId/edgeId helpers, so discovered nodes merge onto captured
    // ones (no parallel node) and survive this rebuild. Discovered-only nodes carry no
    // taint/risk enrichment until later captured — expected.
    if (obs.length) foldObservations(g, obs)
    cache = { key, graph: g }
    return g
  }

  // Assemble taint observations: fetch a bounded set of texty request/response
  // bodies. Bounded by recency so a huge engagement doesn't read every body.
  const TAINT_BODY_LIMIT = 300
  const TEXTY = /(json|text|xml|html|javascript|x-www-form-urlencoded|csv|graphql)/i
  async function bodyText(id: string, side: "request" | "response"): Promise<string | undefined> {
    try {
      const b = await src.getBody(id, side)
      if (!b) return undefined
      return b.text ?? Buffer.from(b.base64, "base64").toString("utf8")
    } catch {
      return undefined
    }
  }
  async function taintObservations(captures: CaptureRecord[]): Promise<TaintObservation[]> {
    const recent = captures.slice(-TAINT_BODY_LIMIT)
    const out: TaintObservation[] = []
    for (const c of recent) {
      const rct = c.responseBody?.contentType ?? ""
      const qct = c.requestBody?.contentType ?? ""
      const responseText = c.responseBody?.present && (!rct || TEXTY.test(rct)) ? await bodyText(c.id, "response") : undefined
      const requestText = c.requestBody?.present && (!qct || TEXTY.test(qct)) ? await bodyText(c.id, "request") : undefined
      out.push({ capture: c, responseText, requestText })
    }
    return out
  }

  function degreeMap(g: Graph): Map<string, { in: number; out: number }> {
    const d = new Map<string, { in: number; out: number }>()
    const bump = (id: string, k: "in" | "out") => {
      const e = d.get(id) ?? { in: 0, out: 0 }
      e[k]++
      d.set(id, e)
    }
    for (const e of g.edges.values()) {
      bump(e.source, "out")
      bump(e.target, "in")
    }
    return d
  }

  return {
    async overview(input) {
      const g = await graph()
      const countsByKind: Partial<Record<NodeKind, number>> = {}
      const countsByRisk: Partial<Record<RiskLevel, number>> = {}
      const countsByHost: Record<string, number> = {}
      const tagCounts = new Map<string, number>()
      const hostFilter = input.hosts && input.hosts.length ? new Set(input.hosts) : null
      for (const n of g.nodes.values()) {
        const host = hostnameOf(n.url)
        if (hostFilter && (!host || !hostFilter.has(host))) continue
        countsByKind[n.kind] = (countsByKind[n.kind] ?? 0) + 1
        countsByRisk[n.risk] = (countsByRisk[n.risk] ?? 0) + 1
        if (host) countsByHost[host] = (countsByHost[host] ?? 0) + 1
        for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
      }
      const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count }))
      const topRiskNodes = [...g.nodes.values()]
        .filter((n) => RISK_ORDER[n.risk] > 0)
        .sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk] || b.lastSeen - a.lastSeen)
        .slice(0, 12)
        .map((n) => ({ id: n.id, kind: n.kind, label: n.label, risk: n.risk }))
      return { countsByKind, countsByRisk, countsByHost, topTags, topRiskNodes, graphVersion: g.version }
    },

    async search(input) {
      const g = await graph()
      const deg = input.sort === "degree" ? degreeMap(g) : null
      const hostSet = input.hosts && input.hosts.length ? new Set(input.hosts) : null
      const tagSet = input.tags && input.tags.length ? new Set(input.tags) : null
      const q = input.q?.toLowerCase()
      let nodes = [...g.nodes.values()].filter((n) => {
        if (input.kinds && !input.kinds.includes(n.kind)) return false
        if (input.riskMin && RISK_ORDER[n.risk] < RISK_ORDER[input.riskMin]) return false
        if (tagSet && !n.tags.some((t) => tagSet.has(t))) return false
        if (hostSet) {
          const h = hostnameOf(n.url)
          if (!h || !hostSet.has(h)) return false
        }
        if (input.method && n.method !== input.method) return false
        if (input.statusClass && (!n.statusCode || `${Math.floor(n.statusCode / 100)}xx` !== input.statusClass)) return false
        if (q) {
          const hay = `${n.label} ${n.url ?? ""} ${n.description} ${n.tags.join(" ")}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      const sort = input.sort ?? "risk"
      nodes = nodes.sort((a, b) => {
        if (sort === "recency") return b.lastSeen - a.lastSeen
        if (sort === "degree") {
          const da = (deg!.get(a.id)?.in ?? 0) + (deg!.get(a.id)?.out ?? 0)
          const db = (deg!.get(b.id)?.in ?? 0) + (deg!.get(b.id)?.out ?? 0)
          return db - da
        }
        return RISK_ORDER[b.risk] - RISK_ORDER[a.risk] || b.lastSeen - a.lastSeen
      })
      return paginate(nodes.map(row), input.limit ?? 25, input.cursor, g.version)
    },

    async neighbors(input) {
      const g = await graph()
      const adj = adjacency(g.edges.values(), input.direction ?? "both")
      const edgeKinds = input.edgeKinds && input.edgeKinds.length ? new Set(input.edgeKinds) : null
      const hops = Math.min(Math.max(input.hops ?? 1, 1), 2)
      const selected = new Set<string>(input.nodeIds)
      const keptEdges = new Map<string, GraphEdge>()
      let frontier = [...input.nodeIds]
      for (let h = 0; h < hops; h++) {
        const next: string[] = []
        for (const id of frontier) {
          for (const { to, edge } of adj.get(id) ?? []) {
            if (edgeKinds && !edgeKinds.has(edge.kind)) continue
            keptEdges.set(edge.id, edge)
            if (!selected.has(to)) {
              selected.add(to)
              next.push(to)
            }
          }
        }
        frontier = next
      }
      const nodeKinds = input.nodeKinds && input.nodeKinds.length ? new Set(input.nodeKinds) : null
      const limit = input.limit ?? 50
      const nodes: NodeRow[] = []
      for (const id of selected) {
        const n = g.nodes.get(id)
        if (!n) continue
        if (nodeKinds && !input.nodeIds.includes(id) && !nodeKinds.has(n.kind)) continue
        nodes.push(row(n))
        if (nodes.length >= limit) break
      }
      const keepIds = new Set(nodes.map((n) => n.id))
      const edges: EdgeRow[] = [...keptEdges.values()]
        .filter((e) => keepIds.has(e.source) && keepIds.has(e.target))
        .map((e) => ({ kind: e.kind, source: e.source, target: e.target }))
      return { nodes, edges, graphVersion: g.version }
    },

    async paths(input) {
      const g = await graph()
      const adj = adjacency(g.edges.values(), "both")
      const edgeKinds = input.edgeKinds && input.edgeKinds.length ? new Set(input.edgeKinds) : null
      const maxHops = input.maxHops ?? 5
      const matches = (id: string): boolean => {
        if (input.toNodeId) return id === input.toNodeId
        const p = input.toPredicate
        if (!p) return false
        const n = g.nodes.get(id)
        if (!n) return false
        if (p.kinds && !p.kinds.includes(n.kind)) return false
        if (p.tags && !p.tags.some((t) => n.tags.includes(t))) return false
        if (p.riskMin && RISK_ORDER[n.risk] < RISK_ORDER[p.riskMin]) return false
        return true
      }
      // BFS with parent reconstruction
      const parent = new Map<string, { via: GraphEdge; from: string }>()
      const seen = new Set<string>([input.fromNodeId])
      let frontier = [input.fromNodeId]
      let found: string | null = input.fromNodeId !== undefined && matches(input.fromNodeId) ? input.fromNodeId : null
      for (let h = 0; h < maxHops && !found && frontier.length; h++) {
        const next: string[] = []
        for (const id of frontier) {
          for (const { to, edge } of adj.get(id) ?? []) {
            if (edgeKinds && !edgeKinds.has(edge.kind)) continue
            if (seen.has(to)) continue
            seen.add(to)
            parent.set(to, { via: edge, from: id })
            if (matches(to)) {
              found = to
              break
            }
            next.push(to)
          }
          if (found) break
        }
        frontier = next
      }
      const paths: PathResult[] = []
      if (found) {
        const nodeSeq: string[] = [found]
        const edgeSeq: EdgeRow[] = []
        let cur = found
        while (cur !== input.fromNodeId) {
          const p = parent.get(cur)
          if (!p) break
          edgeSeq.unshift({ kind: p.via.kind, source: p.via.source, target: p.via.target })
          nodeSeq.unshift(p.from)
          cur = p.from
        }
        paths.push({ nodes: nodeSeq, edges: edgeSeq })
      }
      return { paths, graphVersion: g.version }
    },

    async nodes(input) {
      const g = await graph()
      const deg = degreeMap(g)
      const out: NodeDetail[] = []
      for (const id of input.ids) {
        const n = g.nodes.get(id)
        if (!n) continue
        const d = deg.get(id) ?? { in: 0, out: 0 }
        out.push({
          ...row(n),
          method: n.method,
          statusCode: n.statusCode,
          description: input.verbosity === "full" ? n.description : n.description.slice(0, 600),
          firstSeen: n.firstSeen,
          lastSeen: n.lastSeen,
          recentCaptureIds: captureIdsOf(n).slice(0, 8),
          degree: d,
        })
      }
      return { nodes: out, graphVersion: g.version }
    },

    async evidence(input) {
      const g = await graph()
      const all = await src.list()
      const byId = new Map(all.map((c) => [c.id, c]))

      if (input.captureId) {
        const c = byId.get(input.captureId)
        if (!c) throw new Error(`No capture '${input.captureId}'. Use web_graph_evidence with a node_id to list capture ids first.`)
        const detail: CaptureRecord = { ...c, requestHeaders: redact(c.requestHeaders), responseHeaders: redact(c.responseHeaders) }
        if (!input.includeBody || input.includeBody === "none") return { mode: "detail", capture: detail }
        const raw = await src.getBody(c.id, "response")
        if (!raw) return { mode: "detail", capture: detail }
        const cap = input.maxBytes ?? 8192
        const text = raw.text ?? Buffer.from(raw.base64, "base64").toString("utf8")
        const truncated = input.includeBody === "head" && text.length > cap
        return {
          mode: "detail",
          capture: detail,
          body: { hash: createHash("sha256").update(raw.base64).digest("hex").slice(0, 16), length: raw.size, contentType: raw.contentType, truncated, text: truncated ? text.slice(0, cap) : text },
        }
      }

      let candidates: CaptureRecord[]
      if (input.nodeId) {
        const ids = captureIdsOf(g.nodes.get(input.nodeId))
        candidates = ids.map((id) => byId.get(id)).filter((c): c is CaptureRecord => Boolean(c))
      } else if (input.captureIds) {
        candidates = input.captureIds.map((id) => byId.get(id)).filter((c): c is CaptureRecord => Boolean(c))
      } else {
        candidates = all
      }
      candidates = candidates.sort((a, b) => b.tsRequest - a.tsRequest)
      return { mode: "list", page: paginate(candidates.map(summary), input.limit ?? 25, input.cursor, g.version) }
    },

    async diff(input) {
      const g = await graph()
      const all = await src.list()
      const byId = new Map(all.map((c) => [c.id, c]))
      let a: CaptureRecord | undefined
      let b: CaptureRecord | undefined
      if (input.nodeId) {
        const ids = captureIdsOf(g.nodes.get(input.nodeId))
        a = ids[0] ? byId.get(ids[0]) : undefined
        b = ids[1] ? byId.get(ids[1]) : undefined
      } else {
        a = input.captureIdA ? byId.get(input.captureIdA) : undefined
        b = input.captureIdB ? byId.get(input.captureIdB) : undefined
      }
      if (!a || !b) throw new Error("diff needs two captures: pass capture_id_a + capture_id_b, or a node_id with at least two captures.")

      const [ba, bb] = await Promise.all([src.getBody(a.id, "response"), src.getBody(b.id, "response")])
      const hashA = ba ? createHash("sha256").update(ba.base64).digest("hex") : ""
      const hashB = bb ? createHash("sha256").update(bb.base64).digest("hex") : ""
      const ha = Object.fromEntries(redact(a.responseHeaders).map((p) => [p.name.toLowerCase(), p.value]))
      const hb = Object.fromEntries(redact(b.responseHeaders).map((p) => [p.name.toLowerCase(), p.value]))
      const names = new Set([...Object.keys(ha), ...Object.keys(hb)])
      const headerDiff = [...names].filter((n) => ha[n] !== hb[n]).map((n) => ({ name: n, a: ha[n], b: hb[n] }))
      return {
        statusDelta: { a: a.status ?? 0, b: b.status ?? 0 },
        lengthDelta: (b.responseBody?.size ?? 0) - (a.responseBody?.size ?? 0),
        bodyHashEqual: hashA !== "" && hashA === hashB,
        headerDiff,
        graphVersion: g.version,
      }
    },
  }
}
