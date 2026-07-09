import { createMemo, type Accessor } from "solid-js"
import { buildEnrichedGraph, foldObservations, type Graph, type Observation } from "@morgana/web-core/graph"
import type { CaptureRecord, FormRecord, NavRecord } from "@/web/capture-types"

// ── The seam ──────────────────────────────────────────────────────────────────
// The desktop renderer projects the SAME enriched Security Property Graph the agent
// reasons over — built headless in @morgana/web-core — instead of its own buildTree.
// One source of truth: the UI lenses and the agent's web_graph_* tools see the same
// nodes, edges, risk, and candidate signals. Memoized so it only rebuilds when the
// captured traffic actually changes.
//
// The app's CaptureRecord/NavRecord/FormRecord are the mirror web-core defines its
// own copies of (capture-source.ts), so they pass straight through — no mapping.

export interface SecurityGraphInput {
  captures: CaptureRecord[]
  navs: NavRecord[]
  forms: FormRecord[]
  /** Persisted collector discoveries (crawler / JS / content / recon). Folded onto the
   *  captured graph client-side — the SAME durable fold the agent's GraphStore applies,
   *  so discovered endpoints merge onto captured nodes by id (no parallel node). */
  observations?: Observation[]
}

export function useSecurityGraph(input: Accessor<SecurityGraphInput>): Accessor<Graph> {
  return createMemo(() => {
    const i = input()
    const g = buildEnrichedGraph(i)
    if (i.observations?.length) foldObservations(g, i.observations)
    return g
  })
}
