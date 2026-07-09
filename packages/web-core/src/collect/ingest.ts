// ── Observation → SPG fold ────────────────────────────────────────────────────
// Pure, idempotent merge of collector Observations into the enriched graph, so the
// agent and UI see one attack surface regardless of which collector found a node.
// Secret VALUES can never reach the graph: only the fingerprint ref is folded.

import type { Graph, GraphEdge, GraphNode, NodeKind, RiskLevel } from "../types.js"
import { hashHex } from "../graph/hash.js"
import type { Observation } from "./types.js"

const normUrl = (u: string) => u.split("#")[0]
const RISK_RANK: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }

function upsertNode(
  g: Graph,
  id: string,
  kind: NodeKind,
  label: string,
  now: number,
  extra: Partial<GraphNode> = {},
): GraphNode {
  const existing = g.nodes.get(id)
  if (existing) {
    existing.lastSeen = now
    if (extra.tags) existing.tags = [...new Set([...existing.tags, ...extra.tags])]
    if (extra.metadata) existing.metadata = { ...existing.metadata, ...extra.metadata }
    if (extra.risk && RISK_RANK[extra.risk] > RISK_RANK[existing.risk]) existing.risk = extra.risk
    return existing
  }
  const node: GraphNode = {
    id,
    kind,
    label,
    risk: extra.risk ?? "none",
    description: extra.description ?? "",
    tags: extra.tags ?? [],
    firstSeen: now,
    lastSeen: now,
    ...extra,
  }
  g.nodes.set(id, node)
  return node
}

function upsertEdge(g: Graph, kind: GraphEdge["kind"], source: string, target: string, label: string, now: number): void {
  const id = `${kind}:${source}->${target}`
  const existing = g.edges.get(id)
  if (existing) {
    existing.lastSeen = now
    existing.weight += 1
    return
  }
  g.edges.set(id, { id, kind, source, target, label, weight: 1, firstSeen: now, lastSeen: now })
}

const riskRank: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 } as unknown as Record<
  RiskLevel,
  number
>

/** Fold one observation into the graph. Idempotent: replaying the same observation
 *  updates lastSeen/weight but never duplicates a node or leaks a secret value. */
export function foldObservation(g: Graph, obs: Observation, now: number): void {
  switch (obs.kind) {
    case "endpoint": {
      const id = `ep:${obs.method.toUpperCase()} ${normUrl(obs.url)}`
      upsertNode(g, id, "Endpoint", `${obs.method.toUpperCase()} ${normUrl(obs.url)}`, now, {
        url: normUrl(obs.url),
        method: obs.method.toUpperCase(),
        tags: [`via:${obs.via.collector}`],
      })
      for (const p of obs.params ?? []) {
        const pid = `${id}#${p.loc}:${p.name}`
        upsertNode(g, pid, "Parameter", p.name, now, { metadata: { loc: p.loc } })
        upsertEdge(g, "HAS_PARAM", id, pid, p.loc, now)
      }
      if (obs.via.sourceUrl) upsertEdge(g, "EXPOSES_ENDPOINT", `src:${obs.via.sourceUrl}`, id, obs.via.collector, now)
      break
    }
    case "param": {
      const pid = `${obs.endpointId}#${obs.param.loc}:${obs.param.name}`
      upsertNode(g, pid, "Parameter", obs.param.name, now, { metadata: { loc: obs.param.loc } })
      upsertEdge(g, "HAS_PARAM", obs.endpointId, pid, obs.param.loc, now)
      break
    }
    case "asset": {
      const id = `host:${obs.host.toLowerCase()}`
      upsertNode(g, id, "Host", obs.host.toLowerCase(), now, { tags: [`via:${obs.via.collector}`] })
      for (const r of obs.resolved ?? []) upsertEdge(g, "RESOLVES_TO", id, `host:${r.toLowerCase()}`, "dns", now)
      break
    }
    case "service": {
      const host = `host:${obs.host.toLowerCase()}`
      upsertNode(g, host, "Host", obs.host.toLowerCase(), now)
      const id = `svc:${obs.host.toLowerCase()}:${obs.port}/${obs.proto}`
      upsertNode(g, id, "Service", `${obs.host}:${obs.port} ${obs.proto}`, now, {
        metadata: { port: obs.port, proto: obs.proto, banner: obs.banner },
      })
      upsertEdge(g, "SERVES", host, id, `${obs.port}/${obs.proto}`, now)
      break
    }
    case "cert": {
      const host = `host:${obs.host.toLowerCase()}`
      upsertNode(g, host, "Host", obs.host.toLowerCase(), now)
      const id = `cert:${obs.host.toLowerCase()}:${hashHex(obs.sans.join(","))}`
      upsertNode(g, id, "Certificate", obs.issuer, now, { metadata: { sans: obs.sans, notAfter: obs.notAfter } })
      upsertEdge(g, "SERVES", host, id, "tls", now)
      // SANs are free asset discovery.
      for (const san of obs.sans) upsertEdge(g, "RESOLVES_TO", id, `host:${san.toLowerCase()}`, "san", now)
      break
    }
    case "js": {
      const id = `js:${normUrl(obs.url)}`
      upsertNode(g, id, "JsAsset", normUrl(obs.url), now, { url: normUrl(obs.url) })
      for (const ep of obs.endpoints) {
        const epId = `ep:GET ${normUrl(ep)}`
        upsertNode(g, epId, "Endpoint", `GET ${normUrl(ep)}`, now, { url: normUrl(ep), method: "GET", tags: ["via:js"] })
        upsertEdge(g, "EXPOSES_ENDPOINT", id, epId, "js", now)
      }
      for (const s of obs.secrets) {
        const sid = `secret:${s.hash}`
        upsertNode(g, sid, "SecretRef", s.class, now, {
          risk: "high",
          metadata: { class: s.class, entropy: s.entropy },
        })
        upsertEdge(g, "HOLDS_SECRET", id, sid, s.class, now)
      }
      break
    }
    case "secret": {
      const sid = `secret:${obs.ref.hash}`
      upsertNode(g, sid, "SecretRef", obs.ref.class, now, {
        risk: "high",
        metadata: { class: obs.ref.class, entropy: obs.ref.entropy, location: obs.location },
      })
      break
    }
    case "takeover": {
      const id = `host:${obs.host.toLowerCase()}`
      upsertNode(g, id, "Host", obs.host.toLowerCase(), now, {
        risk: "critical",
        tags: ["takeover"],
        metadata: { takeoverService: obs.service, fingerprint: obs.fingerprint, confidence: obs.confidence },
      })
      upsertEdge(g, "TAKEOVER_CANDIDATE", id, `svc:${obs.service}`, obs.service, now)
      break
    }
  }
}
