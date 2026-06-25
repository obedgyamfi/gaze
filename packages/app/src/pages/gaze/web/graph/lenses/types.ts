import type { Graph } from "@morgana/web-core/graph"
import type { CaptureRecord, FormRecord, NavRecord } from "@/web/capture-types"
import type { WebTree } from "../graph-model"

// ── Lens system ───────────────────────────────────────────────────────────────
// One model, many lenses. The Security Property Graph (`spg`) is the single source
// of truth; a Lens is a pure projection of it into a positioned, colored topology —
// the "terrain" the layer switcher swaps between. Today every lens emits a WebTree
// (the shape GraphCanvas already renders), so switching is a hard re-layout the
// canvas eases into. RenderGraph regions/shape come when the canvas grows to draw
// them; until then lenses position with x/y and encode meaning with color.

export interface LensContext {
  /** The enriched SPG — principals, parameters, templates, values, zones, edges. */
  spg: Graph
  /** Raw capture inputs — the Attack Surface lens builds its own path tree from these. */
  captures: CaptureRecord[]
  navs: NavRecord[]
  forms: FormRecord[]
  /** Attack-surface view state (category filters + collapsed node ids). */
  filters: Record<string, boolean>
  collapsed: Set<string>
}

export interface Lens {
  id: string
  label: string
  /** @opencode-ai/ui icon name shown in the switcher. */
  icon: string
  /** One-line description of what the terrain shows / the job it serves. */
  blurb: string
  project(ctx: LensContext): WebTree
}
