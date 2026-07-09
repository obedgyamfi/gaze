// ── Evidence / Finding / Note stores ──────────────────────────────────────────
// In-memory by default; the interfaces let a host back them with SQLite (the
// capture-store) for durability. The evidence id is content-addressed so identical
// adjudications collapse and a finding can't reference mutated evidence.

import { createHash } from "node:crypto"
import type { Finding, Note, OracleEvidence, OracleVerdict } from "./types.js"
import { type CanvasRecord, type CanvasSummary, summarizeCanvas } from "./canvas.js"
import type { Observation } from "./collect/types.js"
import { observationId } from "./collect/ingest.js"

/** `ev-<sha1(baselineCaptureId:testCaptureId:verdict:signal)>` — immutable checksum id. */
export function stampEvidenceId(baselineCaptureId: string, testCaptureId: string, verdict: OracleVerdict, signal: string): string {
  return "ev-" + createHash("sha1").update(`${baselineCaptureId}:${testCaptureId}:${verdict}:${signal}`).digest("hex").slice(0, 16)
}

export interface EvidenceStore {
  put(e: OracleEvidence): void
  get(id: string): OracleEvidence | undefined
  list(): OracleEvidence[]
}
export interface FindingStore {
  put(f: Finding): void
  get(id: string): Finding | undefined
  list(): Finding[]
}
export interface NoteStore {
  put(n: Note): void
  list(nodeId?: string): Note[]
}
/** Thin persistence for curated canvases — create/patch logic lives in canvas.ts. */
export interface CanvasStore {
  put(rec: CanvasRecord): void
  get(id: string): CanvasRecord | undefined
  list(): CanvasSummary[]
  remove(id: string): void
}
/** Durable collector Observations, so discovered attack surface survives capture-driven
 *  graph rebuilds (and restarts). Keyed by the content-addressed `observationId`, so
 *  `put` is idempotent — re-emitting the same finding never duplicates a row. Fold the
 *  whole set back in after buildEnrichedGraph via `foldObservations`. */
export interface ObservationStore {
  put(obs: Observation): void
  list(): Observation[]
}
/** The engagement's Rules of Engagement: the in-scope host allow-list for active tools.
 *  Per-workspace and durable (set in the desktop UI, read live by the MCP's ScopeGuard),
 *  so discovery/recon tools egress ONLY to hosts the operator authorized. Empty ⇒ every
 *  active tool refuses (deny-by-default). Host globs, e.g. "acme.test", "*.acme.test". */
export interface ScopeStore {
  get(): string[]
  set(hosts: string[]): void
}

export interface Stores {
  evidence: EvidenceStore
  findings: FindingStore
  notes: NoteStore
  canvases: CanvasStore
  observations: ObservationStore
  scope: ScopeStore
}

export function createInMemoryStores(): Stores {
  const evidence = new Map<string, OracleEvidence>()
  const findings = new Map<string, Finding>()
  const notes: Note[] = []
  const canvases = new Map<string, CanvasRecord>()
  const observations = new Map<string, Observation>()
  let scopeHosts: string[] = []
  return {
    evidence: {
      put: (e) => void evidence.set(e.id, e),
      get: (id) => evidence.get(id),
      list: () => [...evidence.values()],
    },
    findings: {
      put: (f) => void findings.set(f.id, f),
      get: (id) => findings.get(id),
      list: () => [...findings.values()],
    },
    notes: {
      put: (n) => void notes.push(n),
      list: (nodeId) => (nodeId ? notes.filter((n) => n.nodeId === nodeId) : [...notes]),
    },
    canvases: {
      put: (r) => void canvases.set(r.id, r),
      get: (id) => canvases.get(id),
      list: () => [...canvases.values()].map(summarizeCanvas).sort((a, b) => b.updatedAt - a.updatedAt),
      remove: (id) => void canvases.delete(id),
    },
    observations: {
      put: (o) => void observations.set(observationId(o), o),
      list: () => [...observations.values()],
    },
    scope: {
      get: () => [...scopeHosts],
      set: (h) => void (scopeHosts = [...new Set(h.map((s) => s.trim()).filter(Boolean))]),
    },
  }
}
