import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useWebCapture } from "@/context/web-capture"
import { useWorkspaceDock } from "@/context/workspace-dock"
import { buildTree, CATEGORY_META } from "./graph-model"
import { GraphCanvas, type GraphCanvasApi } from "./graph-canvas"
import { NodeInspector } from "./node-inspector"
import { collapsedSet, graphState, setGraphState } from "./graph-state"

// The Graph tool — a live tidy tree of the captured attack surface: domains →
// path directories → page / endpoint / resource leaves. Colour encodes category;
// double-click collapses; click inspects every capture behind a node.
//
// All interaction state (selection, collapsed nodes, filters, search, camera) lives
// in the module-level graphState store, so it survives the tab unmounting — moving
// away and back restores exactly what you had.

export default function GraphTool() {
  const capture = useWebCapture()
  const dock = useWorkspaceDock()
  let api: GraphCanvasApi | undefined

  // Coalesce the streamed capture inputs into the layout: rebuilding the whole tidy
  // tree on every request is wasteful, so batch to ~3 rebuilds/sec. Filters and
  // collapse still apply immediately — they read this snapshot.
  const [snapshot, setSnapshot] = createSignal(
    { captures: capture.records(), navs: capture.navs(), forms: capture.forms() },
    { equals: false },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    capture.records()
    capture.navs()
    capture.forms()
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      setSnapshot({ captures: capture.records(), navs: capture.navs(), forms: capture.forms() })
    }, 350)
  })
  onCleanup(() => timer && clearTimeout(timer))

  const tree = createMemo(() => {
    const s = snapshot()
    return buildTree({
      captures: s.captures,
      navs: s.navs,
      forms: s.forms,
      filters: { ...graphState.filters },
      collapsed: collapsedSet(),
    })
  })

  const deselect = () => setGraphState("selectedId", undefined)

  const toggleCollapse = (id: string) => setGraphState("collapsed", id, (v) => !v)

  // Collapse every node that has children (except the root) — derived from the
  // fully-expanded tree so deeply-nested nodes are included too.
  const collapseAll = () => {
    const full = buildTree({
      captures: capture.records(),
      navs: capture.navs(),
      forms: capture.forms(),
      filters: { ...graphState.filters },
      collapsed: new Set(),
    })
    const next: Record<string, boolean> = {}
    for (const n of full.nodes) if (n.hasKids && n.kind !== "root") next[n.id] = true
    setGraphState("collapsed", next)
  }

  const enabledCount = createMemo(() => CATEGORY_META.filter((c) => graphState.filters[c.key]).length)

  return (
    <div class="flex h-full w-full flex-col bg-background-base">
      <div class="shrink-0 flex h-11 items-center gap-2 border-b border-border-weak-base px-3">
        <Icon name="fork" size="small" class="text-icon-base" />
        <span class="text-14-medium text-text-strong">Graph</span>
        <span class="h-4 w-px bg-border-weak-base" />
        <span class="text-12-regular text-text-weak">{tree().nodes.length} nodes</span>
        <div class="ml-auto flex items-center gap-1.5">
          <div class="flex h-7 w-56 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-base px-2">
            <Icon name="magnifying-glass" size="small" class="text-icon-weak" />
            <input
              value={graphState.query}
              onInput={(e) => setGraphState("query", e.currentTarget.value)}
              placeholder="search nodes…"
              spellcheck={false}
              class="h-full flex-1 bg-transparent text-12-regular text-text-base outline-none placeholder:text-text-weak"
            />
            <Show when={graphState.query}>
              <button type="button" onClick={() => setGraphState("query", "")} aria-label="Clear search">
                <Icon name="close-small" size="small" class="text-icon-weak" />
              </button>
            </Show>
          </div>
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-md border px-2 text-12-medium transition-colors"
            classList={{
              "border-border-base bg-surface-base-active text-text-strong": graphState.showFilters,
              "border-border-weak-base text-text-base hover:bg-surface-base": !graphState.showFilters,
            }}
            onClick={() => setGraphState("showFilters", (v) => !v)}
          >
            <Icon name="sliders" size="small" />
            {enabledCount()}/{CATEGORY_META.length}
          </button>
          <Tooltip placement="bottom" value="Collapse all">
            <IconButton icon="collapse" variant="ghost" onClick={collapseAll} aria-label="Collapse all" />
          </Tooltip>
          <Tooltip placement="bottom" value="Expand all">
            <IconButton
              icon="chevron-grabber-vertical"
              variant="ghost"
              onClick={() => setGraphState("collapsed", {})}
              aria-label="Expand all"
            />
          </Tooltip>
          <Tooltip placement="bottom" value="Fit to view">
            <IconButton icon="expand" variant="ghost" onClick={() => api?.fit()} aria-label="Fit to view" />
          </Tooltip>
          <span class="h-4 w-px bg-border-weak-base" />
          <Tooltip placement="bottom" value="Clear graph">
            <IconButton icon="trash" variant="ghost" onClick={() => void capture.clear()} aria-label="Clear graph" />
          </Tooltip>
        </div>
      </div>

      <Show when={graphState.showFilters}>
        <div class="shrink-0 flex flex-wrap items-center gap-1.5 border-b border-border-weak-base px-3 py-2">
          <For each={CATEGORY_META}>
            {(cat) => (
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12-medium transition-colors"
                classList={{
                  "border-border-base bg-surface-base text-text-strong": graphState.filters[cat.key],
                  "border-border-weak-base text-text-weak opacity-60": !graphState.filters[cat.key],
                }}
                onClick={() => setGraphState("filters", cat.key, (v) => !v)}
              >
                <span
                  class="size-2 rounded-full"
                  style={{ background: cat.color, opacity: graphState.filters[cat.key] ? 1 : 0.4 }}
                />
                {cat.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="flex min-h-0 flex-1">
        <div
          class="relative min-w-0 flex-1 overflow-hidden"
          style={{
            "background-image": "radial-gradient(circle, var(--border-weak-base) 1px, transparent 1px)",
            "background-size": "18px 18px",
          }}
        >
          <Show
            when={tree().nodes.length > 1}
            fallback={
              <div class="absolute inset-0 flex items-center justify-center px-6 text-center">
                <span class="text-12-regular text-text-weak">
                  {capture.available
                    ? "Launch the browser and navigate — the attack-surface tree builds as traffic is captured."
                    : "Capture is only available in the desktop app."}
                </span>
              </div>
            }
          >
            <GraphCanvas
              tree={tree()}
              selectedId={graphState.selectedId}
              query={graphState.query}
              initialView={graphState.view}
              onSelect={(node) => setGraphState("selectedId", node?.id)}
              onToggleCollapse={toggleCollapse}
              onView={(v) => setGraphState("view", v)}
              onReady={(a) => (api = a)}
            />
            <div class="pointer-events-none absolute bottom-3 left-3 text-12-regular text-text-weak">
              double-click a node to collapse · click to inspect
            </div>
          </Show>
        </div>

        {/* Keyed on the selected id (a stable string), not the node object — so the
            inspector mounts once per selection and updates in place as new captures
            arrive, instead of remounting on every tree rebuild. */}
        <Show when={graphState.selectedId} keyed>
          {(id) => {
            const node = createMemo(() => tree().nodes.find((n) => n.id === id))
            return (
              <Show when={node()}>
                {(n) => (
                  <Show when={dock.rail()} fallback={<NodeInspector node={n()} onClose={deselect} />}>
                    {(rail) => {
                      dock.setActive(true)
                      onCleanup(() => dock.setActive(false))
                      return (
                        <Portal mount={rail()}>
                          <NodeInspector node={n()} onClose={deselect} />
                        </Portal>
                      )
                    }}
                  </Show>
                )}
              </Show>
            )
          }}
        </Show>
      </div>
    </div>
  )
}
