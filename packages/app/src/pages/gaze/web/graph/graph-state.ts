import { createStore } from "solid-js/store"
import { defaultFilters } from "./graph-model"
import { DEFAULT_LENS_ID } from "./lenses/registry"

// Persistent, view-independent graph state. It lives at module scope (not inside
// GraphTool) so selection, collapsed nodes, filters, search and the camera all
// survive the tool tab unmounting on a tab switch — the same approach the proxy
// uses for its own UI state. The graph view is then a cheap, disposable renderer:
// it can unmount when hidden (no wasted work) and restore exactly on return.

export type GraphView = { k: number; x: number; y: number }

export const [graphState, setGraphState] = createStore({
  selectedId: undefined as string | undefined,
  query: "",
  showFilters: false,
  // Active lens (terrain) + composable overlays — the layer switcher drives these.
  activeLens: DEFAULT_LENS_ID as string,
  overlays: { "risk-heat": false } as Record<string, boolean>,
  // Category -> enabled. Seeded with the default high-signal set.
  filters: defaultFilters() as Record<string, boolean>,
  // Node id -> collapsed. A record (not a Set) so the store tracks it granularly.
  collapsed: {} as Record<string, boolean>,
  // Last camera (force-graph zoom + centre), restored when the tab is reopened.
  view: null as GraphView | null,
})

export function collapsedSet(): Set<string> {
  const out = new Set<string>()
  for (const [id, on] of Object.entries(graphState.collapsed)) if (on) out.add(id)
  return out
}
