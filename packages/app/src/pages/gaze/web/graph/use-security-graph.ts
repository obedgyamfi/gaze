import { createMemo, type Accessor } from "solid-js"
import { buildEnrichedGraph, type Graph } from "@morgana/web-core/graph"
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
}

export function useSecurityGraph(input: Accessor<SecurityGraphInput>): Accessor<Graph> {
  return createMemo(() => buildEnrichedGraph(input()))
}
