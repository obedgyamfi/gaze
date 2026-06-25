// ── Evidence / Finding / Note stores ──────────────────────────────────────────
// In-memory by default; the interfaces let a host back them with SQLite (the
// capture-store) for durability. The evidence id is content-addressed so identical
// adjudications collapse and a finding can't reference mutated evidence.

import { createHash } from "node:crypto"
import type { Finding, Note, OracleEvidence, OracleVerdict } from "./types.js"
import { type CanvasRecord, type CanvasSummary, summarizeCanvas } from "./canvas.js"

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

export interface Stores {
  evidence: EvidenceStore
  findings: FindingStore
  notes: NoteStore
  canvases: CanvasStore
}

export function createInMemoryStores(): Stores {
  const evidence = new Map<string, OracleEvidence>()
  const findings = new Map<string, Finding>()
  const notes: Note[] = []
  const canvases = new Map<string, CanvasRecord>()
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
  }
}
