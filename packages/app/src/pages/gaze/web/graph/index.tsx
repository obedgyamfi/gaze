import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { useWebCapture } from "@/context/web-capture"
import { buildTree, CATEGORY_META, defaultFilters, type Category, type TreeNode } from "./graph-model"
import { GraphCanvas, type GraphCanvasApi } from "./graph-canvas"
import { NodeInspector } from "./node-inspector"

// The Graph tool — a live tidy tree of the captured attack surface: domains →
// path directories → page / endpoint / resource leaves. Colour encodes
// category; double-click collapses; click inspects every capture behind a node.

export default function GraphTool() {
  const capture = useWebCapture()
  const [selectedId, setSelectedId] = createSignal<string | undefined>()
  const [query, setQuery] = createSignal("")
  const [showFilters, setShowFilters] = createSignal(false)
  const [filters, setFilters] = createStore<Record<Category, boolean>>(defaultFilters())
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  let api: GraphCanvasApi | undefined

  const tree = createMemo(() =>
    buildTree({
      captures: capture.records(),
      navs: capture.navs(),
      forms: capture.forms(),
      filters: { ...filters },
      collapsed: collapsed(),
    }),
  )

  const selected = createMemo(() => {
    const id = selectedId()
    return id ? tree().nodes.find((n) => n.id === id) : undefined
  })

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onSelect = (node: TreeNode | undefined) => setSelectedId(node?.id)

  const enabledCount = createMemo(() => CATEGORY_META.filter((c) => filters[c.key]).length)

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
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="search nodes…"
              spellcheck={false}
              class="h-full flex-1 bg-transparent text-12-regular text-text-base outline-none placeholder:text-text-weak"
            />
            <Show when={query()}>
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <Icon name="close-small" size="small" class="text-icon-weak" />
              </button>
            </Show>
          </div>
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-md border px-2 text-12-medium transition-colors"
            classList={{
              "border-border-base bg-surface-base-active text-text-strong": showFilters(),
              "border-border-weak-base text-text-base hover:bg-surface-base": !showFilters(),
            }}
            onClick={() => setShowFilters((v) => !v)}
          >
            <Icon name="sliders" size="small" />
            {enabledCount()}/{CATEGORY_META.length}
          </button>
          <Show when={collapsed().size > 0}>
            <IconButton
              icon="chevron-grabber-vertical"
              variant="ghost"
              onClick={() => setCollapsed(new Set())}
              aria-label="Expand all"
            />
          </Show>
          <IconButton icon="expand" variant="ghost" onClick={() => api?.fit()} aria-label="Fit to view" />
        </div>
      </div>

      <Show when={showFilters()}>
        <div class="shrink-0 flex flex-wrap items-center gap-1.5 border-b border-border-weak-base px-3 py-2">
          <For each={CATEGORY_META}>
            {(cat) => (
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-11-medium transition-colors"
                classList={{
                  "border-border-base bg-surface-base text-text-strong": filters[cat.key],
                  "border-border-weak-base text-text-weak opacity-60": !filters[cat.key],
                }}
                onClick={() => setFilters(cat.key, (v) => !v)}
              >
                <span class="size-2 rounded-full" style={{ background: cat.color, opacity: filters[cat.key] ? 1 : 0.4 }} />
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
              selectedId={selectedId()}
              query={query()}
              onSelect={onSelect}
              onToggleCollapse={toggleCollapse}
              onReady={(a) => (api = a)}
            />
            <div class="pointer-events-none absolute bottom-3 left-3 text-10-regular text-text-weak">
              double-click a node to collapse · click to inspect
            </div>
          </Show>
        </div>

        <Show when={selected()} keyed>
          {(node) => <NodeInspector node={node} onClose={() => setSelectedId(undefined)} />}
        </Show>
      </div>
    </div>
  )
}
