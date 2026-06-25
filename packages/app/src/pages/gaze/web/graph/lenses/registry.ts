import { attackSurfaceLens } from "./attack-surface"
import type { Lens } from "./types"

// The declarative catalog the layer switcher renders. Adding a terrain = appending
// a Lens here (data, not a rewrite) — the same pattern as CATEGORY_META. The SPG
// itself still powers the risk-heat overlay and the agent's tools; the curated
// "who-reaches-what" view now lives in the Canvas editor, not a force-graph lens.
export const LENSES: Lens[] = [attackSurfaceLens]

export const DEFAULT_LENS_ID = attackSurfaceLens.id

export function lensById(id: string): Lens {
  return LENSES.find((l) => l.id === id) ?? LENSES[0]
}

export type { Lens, LensContext } from "./types"
