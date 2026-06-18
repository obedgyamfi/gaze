// ── Graph taxonomy + wire shapes ──────────────────────────────────────────────
// The labeled-property-graph types (the enriched moat model) plus the compact
// read-surface shapes the tools return. Ported from gaze graph.types.ts.

export type NodeKind = "Domain" | "Page" | "Endpoint" | "Resource" | "Form" | "Script" | "ExternalService"

export type EdgeKind =
  | "NAVIGATES_TO"
  | "CALLS"
  | "LOADS"
  | "SUBMITS_TO"
  | "REDIRECTS_TO"
  | "CROSS_ORIGIN_CALL"
  | "HOSTS"
  | "AUTHENTICATES_VIA"
  | "LINKED_FROM"

export type RiskLevel = "critical" | "high" | "medium" | "low" | "none"
export type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx"
export type Verbosity = "compact" | "full"

// ── LPG entities (enriched graph) ─────────────────────────────────────────────
export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  url?: string
  method?: string
  statusCode?: number
  risk: RiskLevel
  description: string
  tags: string[]
  firstSeen: number
  lastSeen: number
  metadata?: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  kind: EdgeKind
  source: string
  target: string
  label: string
  weight: number
  firstSeen: number
  lastSeen: number
  metadata?: Record<string, unknown>
}

export interface Graph {
  nodes: Map<string, GraphNode>
  edges: Map<string, GraphEdge>
  version: number
}

// ── Base (unenriched) graph — structure only, no risk/prose/semantic edges ────
export type BaseCategory =
  | "page"
  | "api"
  | "form"
  | "script"
  | "style"
  | "image"
  | "font"
  | "media"
  | "external"
  | "other"

export interface BaseNode {
  id: string
  kind: "domain" | "directory" | "leaf"
  label: string
  category: BaseCategory | null
  url?: string
  host: string
  captureIds: string[]
}

export interface BaseEdge {
  id: string
  source: string
  target: string
}

export interface BaseGraph {
  nodes: BaseNode[]
  edges: BaseEdge[]
  version: number
}

// ── Compact read-surface rows ─────────────────────────────────────────────────
export interface NodeRow {
  id: string
  kind: NodeKind
  label: string
  url?: string
  risk: RiskLevel
  tags: string[]
}

export interface EdgeRow {
  kind: EdgeKind
  source: string
  target: string
}

export interface NodeDetail extends NodeRow {
  method?: string
  statusCode?: number
  description: string
  firstSeen: number
  lastSeen: number
  recentCaptureIds: string[]
  degree: { in: number; out: number }
}

export interface CaptureSummaryRow {
  id: string
  tsRequest: number
  method: string
  host: string
  path: string
  query?: string
  status?: number
  contentType?: string
  responseSize: number
  durationMs?: number
  source: string
  starred: boolean
}

// ── Response envelope ─────────────────────────────────────────────────────────
export interface Page<T> {
  items: T[]
  total: number
  hasMore: boolean
  nextCursor: string | null
  graphVersion: number
}

export interface OverviewResult {
  countsByKind: Partial<Record<NodeKind, number>>
  countsByRisk: Partial<Record<RiskLevel, number>>
  countsByHost: Record<string, number>
  topTags: { tag: string; count: number }[]
  topRiskNodes: { id: string; kind: NodeKind; label: string; risk: RiskLevel }[]
  graphVersion: number
}

export interface PathResult {
  nodes: string[]
  edges: EdgeRow[]
}

export interface DiffResult {
  statusDelta: { a: number; b: number }
  lengthDelta: number
  bodyHashEqual: boolean
  headerDiff: { name: string; a?: string; b?: string }[]
  jsonStructuralDiff?: { added: string[]; removed: string[]; changed: string[] }
  graphVersion: number
}

// ── Store inputs ──────────────────────────────────────────────────────────────
export interface SearchInput {
  kinds?: NodeKind[]
  riskMin?: RiskLevel
  tags?: string[]
  hosts?: string[]
  method?: string
  statusClass?: StatusClass
  q?: string
  sort?: "risk" | "recency" | "degree"
  limit?: number
  cursor?: string
}

export interface NeighborsInput {
  nodeIds: string[]
  hops?: number
  direction?: "in" | "out" | "both"
  edgeKinds?: EdgeKind[]
  nodeKinds?: NodeKind[]
  limit?: number
}

export interface PathsInput {
  fromNodeId: string
  toNodeId?: string
  toPredicate?: { kinds?: NodeKind[]; tags?: string[]; riskMin?: RiskLevel }
  maxHops?: number
  edgeKinds?: EdgeKind[]
}

export interface EvidenceInput {
  nodeId?: string
  captureIds?: string[]
  captureId?: string
  includeBody?: "none" | "head" | "full"
  maxBytes?: number
  limit?: number
  cursor?: string
}

export interface DiffInput {
  captureIdA?: string
  captureIdB?: string
  nodeId?: string
}

export const RISK_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }

// ── Action surface — oracle, evidence, findings, notes ────────────────────────
export type VulnClass = "auth" | "idor" | "access-control" | "injection" | "xss" | "cors" | "ssrf" | "info-leak" | "csrf"
export type OracleVerdict = "positive" | "negative" | "inconclusive"
export type Severity = "info" | "low" | "medium" | "high" | "critical"

export interface OracleSnapshot {
  status: number
  ms: number
  length: number
  /** Canary marker echoed in the response body, if one was planted. */
  marker?: string
  /** Hash of the response body — detects content differences without holding bodies. */
  bodyHash?: string
}

/** A frozen, content-addressed adjudication. The `id` is a checksum of its inputs,
 *  so a finding that references it cannot point at mutated evidence. */
export interface OracleEvidence {
  id: string
  verdict: OracleVerdict
  signal: string
  baseline: OracleSnapshot
  test: OracleSnapshot
  baselineCaptureId: string
  testCaptureId: string
  vulnClass?: VulnClass
  nodeId?: string
  createdAt: number
  graphVersion: number
}

export interface Finding {
  id: string
  status: "draft" | "confirmed"
  nodeId?: string
  vulnClass: VulnClass
  severity: Severity
  title: string
  detail: string
  /** Provenance pointer + frozen copy — a finding retains its proof. */
  evidenceId: string
  evidence: OracleEvidence
  createdAt: number
}

export interface Note {
  id: string
  nodeId?: string
  text: string
  tags: string[]
  createdAt: number
}
