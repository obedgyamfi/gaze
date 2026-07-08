import { createSeedKnowledgeBase, type KbProcedure } from "@morgana/web-core/graph"

// ── Findings scoring + reference data ─────────────────────────────────────────
// Pure, headless-testable. Findings carry severity + vulnClass (no CVSS vector), so
// the per-finding number is a severity-derived BAND ESTIMATE, not a real score; the
// engagement risk score is a weighted roll-up of the severity counts. Methodology and
// references come from the shared seed KB (one source of truth with the agent).

export type Severity = "critical" | "high" | "medium" | "low" | "info"

/** Wire shape from the desktop morgana IPC (see preload FindingSummary). */
export type MorganaFinding = {
  id: string
  status: string
  vulnClass: string
  severity: string
  title: string
  detail: string
  evidenceId: string
  verdict: string
  signal: string
  createdAt: number
  nodeId?: string
  baseline?: { status: number; ms: number; length: number }
  test?: { status: number; ms: number; length: number }
  baselineCaptureId?: string
  testCaptureId?: string
}
export type MorganaNote = { id: string; nodeId?: string; text: string; tags: string[]; createdAt: number }

export interface SeverityMeta {
  key: Severity
  label: string
  color: string
  /** Representative CVSS band midpoint — an estimate from the severity, not a vector. */
  cvss: number
  /** Weight in the engagement risk-score roll-up. */
  weight: number
}

// Highest → lowest (display + sort order).
export const SEVERITY_META: SeverityMeta[] = [
  { key: "critical", label: "Critical", color: "#dc2626", cvss: 9.8, weight: 25 },
  { key: "high", label: "High", color: "#ea580c", cvss: 8.1, weight: 12 },
  { key: "medium", label: "Medium", color: "#d97706", cvss: 5.4, weight: 5 },
  { key: "low", label: "Low", color: "#2563eb", cvss: 3.1, weight: 1 },
  { key: "info", label: "Info", color: "#64748b", cvss: 0.0, weight: 0 },
]
const META = Object.fromEntries(SEVERITY_META.map((m) => [m.key, m])) as Record<Severity, SeverityMeta>
const FALLBACK = META.info

export function severityMeta(severity: string): SeverityMeta {
  return META[severity as Severity] ?? FALLBACK
}
export function severityRank(severity: string): number {
  const i = SEVERITY_META.findIndex((m) => m.key === severity)
  return i === -1 ? SEVERITY_META.length : i
}

export interface RiskSummary {
  /** Weighted engagement risk score, 0–100 (capped). */
  score: number
  total: number
  counts: Record<Severity, number>
  /** Highest severity present, or undefined when there are no findings. */
  dominant?: Severity
}

/** Colour for a risk score badge (engagement-level), banded like the severities. */
export function scoreColor(score: number): string {
  if (score >= 40) return "#dc2626"
  if (score >= 15) return "#ea580c"
  if (score >= 5) return "#d97706"
  if (score > 0) return "#2563eb"
  return "#16a34a"
}

export function riskSummary(findings: { severity: string }[]): RiskSummary {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) counts[severityMeta(f.severity).key]++
  const raw = SEVERITY_META.reduce((sum, m) => sum + m.weight * counts[m.key], 0)
  const score = Math.min(100, raw)
  const dominant = SEVERITY_META.find((m) => counts[m.key] > 0)?.key
  return { score, total: findings.length, counts, dominant }
}

/**
 * Cumulative finding counts across `buckets` equal time slices spanning the
 * findings' lifetime (first filed → now). A monotonic rising series for a trend
 * curve; empty when there are no findings.
 */
export function cumulativeSeries(findings: { createdAt: number }[], buckets = 12): number[] {
  if (findings.length === 0) return []
  const times = findings.map((f) => f.createdAt)
  const start = Math.min(...times)
  const end = Math.max(Date.now(), ...times)
  const span = end - start || 1
  return Array.from({ length: buckets }, (_, i) => {
    const edge = start + (span * (i + 1)) / buckets
    return times.filter((t) => t <= edge).length
  })
}

// ── methodology + references (reused from the seed KB) ────────────────────────
const kb = createSeedKnowledgeBase()

export interface VulnReference {
  title: string
  steps: string[]
  lookFor: string[]
  refs: string[]
}

/** Methodology + references for a vuln class, for the finding-detail outline. */
export function vulnRef(vulnClass: string): VulnReference | undefined {
  const procs: KbProcedure[] = kb.query({ vulnClass: vulnClass as never })
  const p = procs[0]
  if (!p) return undefined
  return { title: p.title, steps: p.steps, lookFor: p.lookFor, refs: p.refs }
}
