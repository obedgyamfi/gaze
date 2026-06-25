import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { createCanvasRecord, type CanvasEdge, type CanvasRecord, type CanvasTextNode } from "@morgana/web-core/graph"
import { decode64 } from "@/utils/base64"

// ── Canvas editor ─────────────────────────────────────────────────────────────
// A JSONCanvas (Obsidian-style) board: rectangular cards + labeled edges, free-form
// layout, pan/zoom. Authored by the LLM (web_canvas_* MCP tools) AND edited here by
// a human; both persist to the SAME per-workspace store. The SPG stays the machine
// truth — this is the curated, explained view of it.

export type CanvasSummary = { id: string; title: string; purpose: string; nodeCount: number; edgeCount: number; updatedAt: number }

const PRESET: Record<string, string> = { "1": "#e11d48", "2": "#ea580c", "3": "#d97706", "4": "#16a34a", "5": "#0891b2", "6": "#7c3aed" }
const SWATCHES = ["", "1", "2", "3", "4", "5", "6"]
const colorOf = (c?: string) => (!c ? "#64748b" : (PRESET[c] ?? c))
const rid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const isText = (n: { type: string }): n is CanvasTextNode => n.type === "text"

export default function WebCanvas() {
  const location = useLocation()
  const projectDir = () => decode64(location.pathname.split("/").filter(Boolean)[0] ?? "") || ""
  const api = () => window.api?.morgana

  const [list, setList] = createSignal<CanvasSummary[]>([])
  const [selectedId, setSelectedId] = createSignal<string | undefined>()
  const [state, setState] = createStore<{ doc: CanvasRecord | null }>({ doc: null })
  const [loaded, setLoaded] = createSignal(false)

  // viewport transform
  const [tx, setTx] = createSignal(40)
  const [ty, setTy] = createSignal(40)
  const [scale, setScale] = createSignal(1)
  const [selNode, setSelNode] = createSignal<string | undefined>()
  const [editing, setEditing] = createSignal<string | undefined>()
  const [linkFrom, setLinkFrom] = createSignal<string | undefined>()
  const [linking, setLinking] = createSignal(false)

  let surface: HTMLDivElement | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  // Live-sync bookkeeping: the updatedAt we last loaded, and whether we hold unsaved
  // local edits (so a poll never clobbers a human mid-edit).
  const [lastUpdatedAt, setLastUpdatedAt] = createSignal(0)
  const [dirty, setDirty] = createSignal(false)

  // ── persistence ──
  const scheduleSave = () => {
    setDirty(true)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const doc = unwrap(state.doc)
      if (!doc || !api()) return
      const savedAt = Date.now()
      await api()!.canvasSave(projectDir(), { ...doc, updatedAt: savedAt })
      setLastUpdatedAt(savedAt)
      setDirty(false)
    }, 500)
  }
  const refreshList = async () => {
    if (!api()) return
    setList(await api()!.canvasList(projectDir()))
  }
  const loadDoc = async (id: string) => {
    if (!api()) return
    const doc = await api()!.canvasRead(projectDir(), id)
    setState("doc", doc)
    setLastUpdatedAt(doc?.updatedAt ?? 0)
    setDirty(false)
  }
  const open = async (id: string) => {
    await loadDoc(id)
    setSelectedId(id)
    setSelNode(undefined)
    setEditing(undefined)
    setTx(40)
    setTy(40)
    setScale(1)
  }

  // Poll the store: pick up canvases the agent created/edited, without resetting the
  // viewport or stomping an in-progress edit. Cross-process (the agent writes from a
  // separate process), so polling is the reliable channel; the reads are cheap.
  const poll = async () => {
    if (!api()) return
    const summaries = await api()!.canvasList(projectDir())
    setList(summaries)
    const id = selectedId()
    if (!id) {
      if (summaries.length && !state.doc) await open(summaries[0].id)
      return
    }
    const sum = summaries.find((c) => c.id === id)
    if (!sum) {
      // the open canvas was deleted elsewhere
      setState("doc", null)
      setSelectedId(undefined)
      if (summaries.length) await open(summaries[0].id)
      return
    }
    const busy = dirty() || editing() !== undefined || drag !== undefined || linkFrom() !== undefined
    if (!busy && sum.updatedAt > lastUpdatedAt()) await loadDoc(id)
  }

  onMount(async () => {
    await refreshList()
    if (list().length) await open(list()[0].id)
    setLoaded(true)
    pollTimer = setInterval(() => void poll(), 3000)
  })
  onCleanup(() => {
    clearTimeout(saveTimer)
    clearInterval(pollTimer)
  })

  // ── canvas-level ops ──
  const newCanvas = async () => {
    const rec = createCanvasRecord({ title: "Untitled canvas", purpose: "", nodes: [{ id: rid("n"), text: "New card" }] })
    if (api()) await api()!.canvasSave(projectDir(), rec)
    await refreshList()
    await open(rec.id)
  }
  const deleteCanvas = async () => {
    const id = selectedId()
    if (!id || !api()) return
    await api()!.canvasDelete(projectDir(), id)
    setState("doc", null)
    setSelectedId(undefined)
    await refreshList()
    if (list().length) await open(list()[0].id)
  }
  const setTitle = (title: string) => {
    setState("doc", "title", title)
    scheduleSave()
  }

  // ── node/edge ops ──
  const nodes = () => state.doc?.canvas.nodes ?? []
  const edges = () => state.doc?.canvas.edges ?? []
  const nodeById = (id: string) => nodes().find((n) => n.id === id)

  const moveNode = (id: string, x: number, y: number) => setState("doc", "canvas", "nodes", (n) => n.id === id, { x, y })
  const setText = (id: string, text: string) => {
    setState("doc", "canvas", "nodes", (n) => n.id === id, (prev) => (prev.type === "text" ? { ...prev, text } : prev))
    scheduleSave()
  }
  const setColor = (id: string, color: string) => {
    setState("doc", "canvas", "nodes", (n) => n.id === id, "color", color || undefined)
    scheduleSave()
  }
  const addCard = () => {
    if (!state.doc) return
    const cx = (-tx() + (surface?.clientWidth ?? 600) / 2) / scale()
    const cy = (-ty() + (surface?.clientHeight ?? 400) / 2) / scale()
    const node: CanvasTextNode = { id: rid("n"), type: "text", text: "New card", x: Math.round(cx - 130), y: Math.round(cy - 60), width: 260, height: 120 }
    setState("doc", "canvas", "nodes", (ns) => [...ns, node])
    setSelNode(node.id)
    setEditing(node.id)
    scheduleSave()
  }
  const removeNode = (id: string) => {
    setState("doc", "canvas", (c) => ({ nodes: c.nodes.filter((n) => n.id !== id), edges: c.edges.filter((e) => e.fromNode !== id && e.toNode !== id) }))
    if (selNode() === id) setSelNode(undefined)
    scheduleSave()
  }
  const addEdge = (from: string, to: string) => {
    if (from === to || edges().some((e) => e.fromNode === from && e.toNode === to)) return
    const edge: CanvasEdge = { id: rid("e"), fromNode: from, toNode: to }
    setState("doc", "canvas", "edges", (es) => [...es, edge])
    scheduleSave()
  }
  const removeEdge = (id: string) => {
    setState("doc", "canvas", "edges", (es) => es.filter((e) => e.id !== id))
    scheduleSave()
  }

  const onCardClick = (id: string) => {
    if (linking()) {
      if (!linkFrom()) setLinkFrom(id)
      else {
        addEdge(linkFrom()!, id)
        setLinkFrom(undefined)
        setLinking(false)
      }
      return
    }
    setSelNode(id)
  }

  // ── pointer: pan + drag ──
  type Drag = { mode: "pan"; sx: number; sy: number; otx: number; oty: number } | { mode: "node"; id: string; sx: number; sy: number; ox: number; oy: number }
  let drag: Drag | undefined

  const onSurfaceDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    setSelNode(undefined)
    setEditing(undefined)
    drag = { mode: "pan", sx: e.clientX, sy: e.clientY, otx: tx(), oty: ty() }
    surface?.setPointerCapture(e.pointerId)
  }
  const onCardDown = (e: PointerEvent, n: CanvasTextNode) => {
    if (e.button !== 0 || editing() === n.id || linking()) return
    e.stopPropagation()
    setSelNode(n.id)
    drag = { mode: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y }
    surface?.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!drag) return
    if (drag.mode === "pan") {
      setTx(drag.otx + (e.clientX - drag.sx))
      setTy(drag.oty + (e.clientY - drag.sy))
    } else {
      moveNode(drag.id, Math.round(drag.ox + (e.clientX - drag.sx) / scale()), Math.round(drag.oy + (e.clientY - drag.sy) / scale()))
    }
  }
  const onUp = () => {
    if (drag?.mode === "node") scheduleSave()
    drag = undefined
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = surface!.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const ns = Math.min(3, Math.max(0.2, scale() * factor))
    const wx = (cx - tx()) / scale()
    const wy = (cy - ty()) / scale()
    setTx(cx - wx * ns)
    setTy(cy - wy * ns)
    setScale(ns)
  }

  const center = (n: { x: number; y: number; width: number; height: number }) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 })
  const edgeGeom = createMemo(() =>
    edges()
      .map((e) => {
        const a = nodeById(e.fromNode)
        const b = nodeById(e.toNode)
        if (!a || !b) return null
        const p = center(a)
        const q = center(b)
        return { id: e.id, label: e.label, color: colorOf(e.color), x1: p.x, y1: p.y, x2: q.x, y2: q.y, mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  )

  return (
    <div class="flex h-full w-full flex-col bg-background-base">
      {/* toolbar */}
      <div class="flex shrink-0 items-center gap-2 border-b border-border-weak-base px-3 py-2">
        <Icon name="dot-grid" size="small" class="text-icon-base" />
        <Show when={state.doc} fallback={<span class="text-12-medium text-text-strong">Canvas</span>}>
          <input
            class="w-56 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-12-medium text-text-strong hover:border-border-weak-base focus:border-border-weak-base focus:outline-none"
            value={state.doc!.title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </Show>
        <select
          class="h-7 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
          value={selectedId() ?? ""}
          onChange={(e) => e.currentTarget.value && void open(e.currentTarget.value)}
        >
          <For each={list()}>{(c) => <option value={c.id}>{c.title}</option>}</For>
          <Show when={!list().length}>
            <option value="">No canvases</option>
          </Show>
        </select>
        <button class="flex h-7 items-center gap-1 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-medium text-text-base hover:bg-surface-base-active" onClick={() => void newCanvas()}>
          <Icon name="plus" size="small" /> New
        </button>

        <div class="ml-auto flex items-center gap-1.5">
          <Show when={state.doc}>
            <button class="flex h-7 items-center gap-1 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-medium text-text-base hover:bg-surface-base-active" onClick={addCard}>
              <Icon name="plus" size="small" /> Card
            </button>
            <button
              class="flex h-7 items-center gap-1 rounded-md border px-2 text-12-medium hover:bg-surface-base-active"
              classList={{ "border-border-base bg-surface-base-active text-text-strong": linking(), "border-border-weak-base bg-surface-base text-text-base": !linking() }}
              onClick={() => {
                setLinking((v) => !v)
                setLinkFrom(undefined)
              }}
            >
              <Icon name="share" size="small" /> {linking() ? (linkFrom() ? "Pick target" : "Pick source") : "Connect"}
            </button>
            <button class="flex h-7 items-center rounded-md border border-border-weak-base bg-surface-base px-2 text-12-medium text-text-weak hover:text-text-base" onClick={() => void deleteCanvas()}>
              <Icon name="trash" size="small" />
            </button>
          </Show>
        </div>
      </div>

      {/* surface */}
      <div
        ref={surface}
        class="relative min-h-0 flex-1 overflow-hidden"
        style={{ "background-image": "radial-gradient(circle, var(--border-weak-base) 1px, transparent 1px)", "background-size": "20px 20px", cursor: linking() ? "crosshair" : "grab" }}
        onPointerDown={onSurfaceDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
      >
        <Show
          when={loaded() && api() && state.doc}
          fallback={
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <span class="text-12-regular text-text-weak">
                {!api()
                  ? "Canvas is only available in the desktop app."
                  : !list().length
                    ? "No canvases yet — create one, or ask the agent to compose one from the security graph."
                    : "Select a canvas above."}
              </span>
              <Show when={api() && !list().length}>
                <button class="rounded-md border border-border-weak-base bg-surface-base px-2.5 py-1 text-12-medium text-text-base hover:bg-surface-base-active" onClick={() => void newCanvas()}>
                  New canvas
                </button>
              </Show>
            </div>
          }
        >
          <div class="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})` }}>
            {/* edges */}
            <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
              <defs>
                <marker id="canvas-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--text-weak-base, #94a3b8)" />
                </marker>
              </defs>
              <For each={edgeGeom()}>
                {(e) => (
                  <g>
                    <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={e.color} stroke-width={1.5} marker-end="url(#canvas-arrow)" opacity={0.7} />
                    <g class="pointer-events-auto cursor-pointer" onClick={() => removeEdge(e.id)}>
                      <Show when={e.label} fallback={<circle cx={e.mx} cy={e.my} r={5} fill="var(--background-stronger)" stroke={e.color} />}>
                        <rect x={e.mx - 28} y={e.my - 9} width={56} height={18} rx={4} fill="var(--background-stronger)" stroke={e.color} opacity={0.95} />
                        <text x={e.mx} y={e.my + 3} text-anchor="middle" font-size="10" fill="var(--text-base)">{e.label}</text>
                      </Show>
                    </g>
                  </g>
                )}
              </For>
            </svg>

            {/* cards */}
            <For each={nodes()}>
              {(n) => (
                <Show when={isText(n)}>
                  {(() => {
                    const t = n as CanvasTextNode
                    return (
                      <div
                        class="absolute rounded-lg border bg-background-stronger shadow-sm"
                        classList={{ "ring-2 ring-icon-base": selNode() === t.id, "ring-1 ring-border-base": linkFrom() === t.id }}
                        style={{ left: `${t.x}px`, top: `${t.y}px`, width: `${t.width}px`, height: `${t.height}px`, "border-left": `4px solid ${colorOf(t.color)}`, cursor: linking() ? "crosshair" : "grab" }}
                        onPointerDown={(e) => onCardDown(e, t)}
                        onClick={(e) => {
                          e.stopPropagation()
                          onCardClick(t.id)
                        }}
                        onDblClick={(e) => {
                          e.stopPropagation()
                          setEditing(t.id)
                        }}
                      >
                        <Show
                          when={editing() === t.id}
                          fallback={<div class="h-full w-full overflow-auto whitespace-pre-wrap p-2.5 text-12-regular text-text-base">{t.text}</div>}
                        >
                          <textarea
                            class="h-full w-full resize-none bg-transparent p-2.5 text-12-regular text-text-base focus:outline-none"
                            value={t.text}
                            autofocus
                            onPointerDown={(e) => e.stopPropagation()}
                            onInput={(e) => setText(t.id, e.currentTarget.value)}
                            onBlur={() => setEditing(undefined)}
                          />
                        </Show>
                        <Show when={selNode() === t.id && !editing()}>
                          <div class="absolute -top-8 left-0 flex items-center gap-1 rounded-md border border-border-weak-base bg-surface-base px-1 py-0.5 shadow-sm" onPointerDown={(e) => e.stopPropagation()}>
                            <For each={SWATCHES}>
                              {(s) => (
                                <button class="size-4 rounded-full border border-border-weak-base" style={{ background: s ? colorOf(s) : "transparent" }} title={s ? `color ${s}` : "no color"} onClick={() => setColor(t.id, s)} />
                              )}
                            </For>
                            <button class="ml-1 text-text-weak hover:text-icon-critical-base" title="Delete card" onClick={() => removeNode(t.id)}>
                              <Icon name="trash" size="small" />
                            </button>
                          </div>
                        </Show>
                      </div>
                    )
                  })()}
                </Show>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
