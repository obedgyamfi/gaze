// ── Canvas model — curated, flowchart-style views (JSONCanvas) ────────────────
// Distinct from the SPG: the SPG is the machine-readable truth (auto-built from
// captures); a Canvas is a HUMAN- and LLM-authored explanation — rectangular text
// cards + labeled edges, free-form layout. The format is JSONCanvas (jsoncanvas.org,
// the open spec Obsidian Canvas uses) so canvases are portable and human-editable.
// Many canvases per workspace, each for a different purpose (an attack chain, an
// auth-flow map, a report figure…). Pure helpers here; persistence is a thin store.

export type CanvasColor = string // JSONCanvas preset "1".."6" or a "#RRGGBB" hex
export type CanvasSide = "top" | "right" | "bottom" | "left"

export interface CanvasTextNode {
  id: string
  type: "text"
  text: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
  /** Our extension: a pointer back to the SPG node this card represents (optional,
   *  preserved through edits; ignored by stock Obsidian). */
  spgRef?: string
}
export interface CanvasGroupNode {
  id: string
  type: "group"
  label?: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
}
export type CanvasNode = CanvasTextNode | CanvasGroupNode

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: CanvasSide
  toSide?: CanvasSide
  label?: string
  color?: CanvasColor
}

/** A JSONCanvas document. */
export interface JsonCanvas {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/** A stored canvas: the JSONCanvas plus workspace metadata. */
export interface CanvasRecord {
  id: string
  title: string
  purpose: string
  canvas: JsonCanvas
  createdAt: number
  updatedAt: number
}

export interface CanvasSummary {
  id: string
  title: string
  purpose: string
  nodeCount: number
  edgeCount: number
  updatedAt: number
}

// ── author-facing inputs (what the tools accept) ──────────────────────────────
export interface CanvasNodeInput {
  id: string
  text: string
  x?: number
  y?: number
  width?: number
  height?: number
  color?: CanvasColor
  ref?: string
}
export interface CanvasEdgeInput {
  id?: string
  fromNode: string
  toNode: string
  fromSide?: CanvasSide
  toSide?: CanvasSide
  label?: string
  color?: CanvasColor
}
export interface CanvasPatch {
  title?: string
  purpose?: string
  addNodes?: CanvasNodeInput[]
  updateNodes?: (Partial<Omit<CanvasNodeInput, "id">> & { id: string })[]
  removeNodes?: string[]
  addEdges?: CanvasEdgeInput[]
  removeEdges?: string[]
}

// ── limits + defaults ─────────────────────────────────────────────────────────
const DEFAULT_W = 260
const DEFAULT_H = 120
const GRID_X = 320
const GRID_Y = 200
const GRID_COLS = 4
const MAX_NODES = 1000
const MAX_TEXT = 8000

let counter = 0
function rid(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function emptyCanvas(): JsonCanvas {
  return { nodes: [], edges: [] }
}

export function summarizeCanvas(rec: CanvasRecord): CanvasSummary {
  return { id: rec.id, title: rec.title, purpose: rec.purpose, nodeCount: rec.canvas.nodes.length, edgeCount: rec.canvas.edges.length, updatedAt: rec.updatedAt }
}

/** Grid-position any node missing coordinates so an LLM can author by content alone. */
function placed(input: CanvasNodeInput, slot: number): CanvasTextNode {
  const node: CanvasTextNode = {
    id: input.id,
    type: "text",
    text: input.text.slice(0, MAX_TEXT),
    x: input.x ?? (slot % GRID_COLS) * GRID_X,
    y: input.y ?? Math.floor(slot / GRID_COLS) * GRID_Y,
    width: input.width ?? DEFAULT_W,
    height: input.height ?? DEFAULT_H,
  }
  if (input.color) node.color = input.color
  if (input.ref) node.spgRef = input.ref
  return node
}

function edgeFrom(input: CanvasEdgeInput): CanvasEdge {
  const e: CanvasEdge = { id: input.id ?? rid("e"), fromNode: input.fromNode, toNode: input.toNode }
  if (input.fromSide) e.fromSide = input.fromSide
  if (input.toSide) e.toSide = input.toSide
  if (input.label) e.label = input.label
  if (input.color) e.color = input.color
  return e
}

/** Keep only edges whose endpoints exist — a canvas never references missing nodes. */
function pruneEdges(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasEdge[] {
  const ids = new Set(nodes.map((n) => n.id))
  return edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
}

export function createCanvasRecord(input: { title: string; purpose?: string; nodes?: CanvasNodeInput[]; edges?: CanvasEdgeInput[] }): CanvasRecord {
  const now = Date.now()
  const nodes = (input.nodes ?? []).slice(0, MAX_NODES).map((n, i) => placed(n, i))
  const edges = pruneEdges(nodes, (input.edges ?? []).map(edgeFrom))
  return { id: rid("canvas"), title: input.title, purpose: input.purpose ?? "", canvas: { nodes, edges }, createdAt: now, updatedAt: now }
}

/** Apply an incremental patch and return the updated record (new updatedAt). Pure —
 *  the caller persists the result. */
export function applyCanvasPatch(rec: CanvasRecord, patch: CanvasPatch): CanvasRecord {
  const byId = new Map(rec.canvas.nodes.map((n) => [n.id, n]))

  for (const id of patch.removeNodes ?? []) byId.delete(id)
  let slot = byId.size
  for (const n of patch.addNodes ?? []) byId.set(n.id, placed(n, slot++))
  for (const u of patch.updateNodes ?? []) {
    const existing = byId.get(u.id)
    if (!existing || existing.type !== "text") continue
    byId.set(u.id, {
      ...existing,
      text: u.text !== undefined ? u.text.slice(0, MAX_TEXT) : existing.text,
      x: u.x ?? existing.x,
      y: u.y ?? existing.y,
      width: u.width ?? existing.width,
      height: u.height ?? existing.height,
      color: u.color ?? existing.color,
      spgRef: u.ref ?? existing.spgRef,
    })
  }

  const removeEdge = new Set(patch.removeEdges ?? [])
  const nodes = [...byId.values()]
  const edges = pruneEdges(nodes, [
    ...rec.canvas.edges.filter((e) => !removeEdge.has(e.id)),
    ...(patch.addEdges ?? []).map(edgeFrom),
  ])

  return {
    ...rec,
    title: patch.title ?? rec.title,
    purpose: patch.purpose ?? rec.purpose,
    canvas: { nodes, edges },
    updatedAt: Date.now(),
  }
}
