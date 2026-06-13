import { createEffect, onCleanup, onMount } from "solid-js"
import ForceGraph from "force-graph"
import { statusClassColor, type TreeNode, type WebTree } from "./graph-model"

// Rich tidy-tree renderer. force-graph is used only as the canvas/zoom/pan/
// pointer host — node positions come from the tidy-tree layout (pinned via
// fx/fy, simulation frozen). Glow is drawn from cached sprites; links are bezier
// curves with a flowing pip. Colour encodes node category only.

const TAU = Math.PI * 2
const SPAWN_MS = 520

type FGNode = TreeNode & { fx?: number; fy?: number; appeared?: number; __nbr?: Set<string> }
type FGLink = { source: any; target: any; off: number }

const glowCache = new Map<string, HTMLCanvasElement>()
function glowSprite(color: string): HTMLCanvasElement {
  const hit = glowCache.get(color)
  if (hit) return hit
  const c = document.createElement("canvas")
  c.width = 64
  c.height = 64
  const cx = c.getContext("2d")!
  const g = cx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, rgba(color, 0.5))
  g.addColorStop(0.45, rgba(color, 0.18))
  g.addColorStop(1, rgba(color, 0))
  cx.fillStyle = g
  cx.fillRect(0, 0, 64, 64)
  glowCache.set(color, c)
  return c
}
function hexToRgb(h: string): [number, number, number] {
  let s = h.replace("#", "")
  if (s.length === 3)
    s = s
      .split("")
      .map((c) => c + c)
      .join("")
  const n = parseInt(s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgba(h: string, a: number): string {
  const [r, g, b] = hexToRgb(h)
  return `rgba(${r},${g},${b},${a})`
}
function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}
function radiusOf(n: TreeNode): number {
  if (n.kind === "root") return 9
  if (n.kind === "domain") return 7
  if (n.kind === "directory") return 4.5
  return 5
}

export interface GraphCanvasApi {
  fit: () => void
}

export function GraphCanvas(props: {
  tree: WebTree
  selectedId?: string
  query?: string
  onSelect: (node: TreeNode | undefined) => void
  onToggleCollapse: (id: string) => void
  onReady?: (api: GraphCanvasApi) => void
}) {
  let container!: HTMLDivElement
  let graph: ForceGraph | undefined
  const cache = new Map<string, FGNode>()
  const theme = { label: "#171717", root: "#171717", accent: "#2563eb" }
  let phase = 0
  const view = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
  let lastClick = { id: "", at: 0 }

  const resolveTheme = () => {
    const css = getComputedStyle(document.documentElement)
    theme.label = css.getPropertyValue("--text-strong").trim() || theme.label
    theme.root = css.getPropertyValue("--text-stronger").trim() || theme.label
    theme.accent = css.getPropertyValue("--primary").trim() || css.getPropertyValue("--icon-strong").trim() || theme.accent
  }

  onMount(() => {
    resolveTheme()
    // Re-resolve when the theme flips (light/dark) so canvas labels stay readable.
    const obs = new MutationObserver(resolveTheme)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
    onCleanup(() => obs.disconnect())

    const fg = new ForceGraph(container)
    graph = fg
    fg.nodeId("id")
      .backgroundColor("rgba(0,0,0,0)")
      .cooldownTicks(0)
      .warmupTicks(0)
      .autoPauseRedraw(false)
      .nodeCanvasObjectMode(() => "replace")
      .linkCanvasObjectMode(() => "replace")
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, scale: number) =>
        paintNode(node as FGNode, ctx, scale, props, theme, view),
      )
      .linkCanvasObject((link: any, ctx: CanvasRenderingContext2D, scale: number) =>
        paintLink(link as FGLink, ctx, scale, props, phase, view),
      )
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const n = node as FGNode
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x ?? 0, n.y ?? 0, radiusOf(n) + 3, 0, TAU)
        ctx.fill()
      })
      .onNodeClick((node: any) => {
        const n = node as FGNode
        const now = performance.now()
        const dbl = lastClick.id === n.id && now - lastClick.at < 320
        lastClick = { id: n.id, at: now }
        if (dbl && n.hasKids) props.onToggleCollapse(n.id)
        else props.onSelect(n)
      })
      .onBackgroundClick(() => props.onSelect(undefined))
      .onRenderFramePre((ctx: CanvasRenderingContext2D, scale: number) => {
        void ctx
        void scale
        phase = (phase + 0.0026) % 1
        const tl = fg.screen2GraphCoords(0, 0)
        const br = fg.screen2GraphCoords(container.clientWidth, container.clientHeight)
        view.minX = Math.min(tl.x, br.x) - 120
        view.maxX = Math.max(tl.x, br.x) + 120
        view.minY = Math.min(tl.y, br.y) - 120
        view.maxY = Math.max(tl.y, br.y) + 120
      })

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      fg.width(Math.round(width)).height(Math.round(height))
    })
    ro.observe(container)

    props.onReady?.({ fit: () => fg.zoomToFit(450, 70) })

    onCleanup(() => {
      ro.disconnect()
      fg._destructor?.()
      graph = undefined
    })
  })

  // Push the tidy tree, reusing cached node objects and pinning positions.
  createEffect(() => {
    const tree = props.tree
    if (!graph) return
    const now = performance.now()
    const ids = new Set(tree.nodes.map((n) => n.id))
    for (const id of [...cache.keys()]) if (!ids.has(id)) cache.delete(id)

    const nodes = tree.nodes.map((n) => {
      const existing = cache.get(n.id)
      if (existing) {
        Object.assign(existing, n)
        existing.fx = n.x
        existing.fy = n.y
        return existing
      }
      const fresh: FGNode = { ...n, fx: n.x, fy: n.y, appeared: now }
      cache.set(n.id, fresh)
      return fresh
    })

    // neighbour sets for hover focus
    for (const n of nodes) n.__nbr = new Set([n.id])
    for (const l of tree.links) {
      cache.get(l.source)?.__nbr?.add(l.target)
      cache.get(l.target)?.__nbr?.add(l.source)
    }
    const links: FGLink[] = tree.links.map((l) => ({ source: l.source, target: l.target, off: linkOff(l.id) }))
    graph.graphData({ nodes, links })
  })

  // Repaint on selection/search change (autoPauseRedraw is off, so this is cheap).
  createEffect(() => {
    void props.selectedId
    void props.query
    graph?.nodeRelSize(5)
  })

  return <div ref={container} class="absolute inset-0" data-component="graph-canvas" />
}

function linkOff(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (((h % 1000) + 1000) % 1000) / 1000
}

interface PaintProps {
  selectedId?: string
  query?: string
}
type View = { minX: number; minY: number; maxX: number; maxY: number }

function wrapLabel(label: string, max: number): string[] {
  if (label.length <= max) return [label]
  let cut = -1
  for (const sep of ["/", "_", "-", "."]) {
    const idx = label.lastIndexOf(sep, max)
    if (idx > max * 0.4) {
      cut = sep === "/" ? idx : idx + 1
      break
    }
  }
  if (cut < 0) cut = max
  const line1 = label.slice(0, cut)
  let line2 = label.slice(cut)
  if (line2.length > max) line2 = line2.slice(0, max - 1) + "…"
  return [line1, line2]
}

function paintNode(n: FGNode, ctx: CanvasRenderingContext2D, scale: number, props: PaintProps, theme: { label: string; root: string; accent: string }, view: View) {
  const x = n.x ?? 0
  const y = n.y ?? 0
  if (x < view.minX || x > view.maxX || y < view.minY || y > view.maxY) return

  const now = performance.now()
  const age = now - (n.appeared ?? now)
  const spawn = age < SPAWN_MS ? age / SPAWN_MS : 1
  const selected = n.id === props.selectedId
  const q = props.query?.trim().toLowerCase()
  const match = q ? `${n.label} ${n.url ?? ""} ${n.host}`.toLowerCase().includes(q) : true
  const dim = !!q && !match
  const isDir = n.kind === "directory"
  const base = radiusOf(n)
  const r = age < SPAWN_MS ? base * (0.3 + 0.7 * (1 - (1 - spawn) ** 3)) : base

  ctx.globalAlpha = dim ? 0.18 : age < SPAWN_MS ? spawn : 1

  // glow sprite (skip for plain directories)
  if (!isDir) {
    const gr = selected ? r + 16 : r + (n.kind === "root" ? 10 : n.kind === "domain" ? 6 : 3)
    ctx.drawImage(glowSprite(n.color), x - gr, y - gr, gr * 2, gr * 2)
  }

  // body — directory is a diamond, everything else a disc
  ctx.beginPath()
  if (isDir) {
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
  } else {
    ctx.arc(x, y, r, 0, TAU)
  }
  ctx.fillStyle = isDir ? rgba(n.color, 0.6) : rgba(n.color, 0.95)
  ctx.fill()
  const statusColor = statusClassColor(n.status)
  ctx.lineWidth = (selected ? 1.8 : 1) / scale
  ctx.strokeStyle = selected ? theme.accent : statusColor ?? rgba(n.color, 0.85)
  ctx.stroke()

  // attention ring for redirects / errors
  if (statusColor && (n.status ?? 0) >= 300) {
    ctx.beginPath()
    ctx.arc(x, y, r + 2.6, 0, TAU)
    ctx.strokeStyle = statusColor
    ctx.lineWidth = 1.5 / scale
    ctx.stroke()
  }

  // label — wraps onto a second line instead of truncating from the front.
  // Hidden when zoomed out (incl. root/domain — their large text reads poorly at
  // low zoom and the structure is legible without it); always shown when selected
  // or matched by search.
  if (scale > 0.85 || selected || (q && match)) {
    const strong = n.kind === "root" || n.kind === "domain"
    const fontSize = Math.max(3.5, 11 / scale)
    ctx.font = `${strong ? "600 " : ""}${fontSize}px ui-monospace, monospace`
    ctx.textAlign = "left"
    ctx.textBaseline = "middle"
    ctx.fillStyle = n.collapsed ? "#d99318" : strong ? theme.root : theme.label
    const full = n.label + (n.collapsed && n.descCount > 0 ? `  +${n.descCount}` : "")
    const lines = wrapLabel(full, 26)
    const lh = fontSize * 1.15
    const startY = y - ((lines.length - 1) * lh) / 2
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + r + 4, startY + i * lh)
  }
  ctx.globalAlpha = 1
}

function paintLink(l: FGLink, ctx: CanvasRenderingContext2D, scale: number, props: PaintProps, phase: number, view: View) {
  const s = l.source as FGNode
  const t = l.target as FGNode
  if (!s || !t || s.x == null || t.x == null) return
  const loX = Math.min(s.x, t.x)
  const hiX = Math.max(s.x, t.x)
  const loY = Math.min(s.y!, t.y!)
  const hiY = Math.max(s.y!, t.y!)
  if (hiX < view.minX || loX > view.maxX || hiY < view.minY || loY > view.maxY) return

  const sr = radiusOf(s)
  const tr = radiusOf(t)
  const x0 = s.x + sr
  const y0 = s.y!
  const x3 = t.x - tr
  const y3 = t.y!
  const mx = (x0 + x3) / 2
  const lit = props.selectedId === t.id || props.selectedId === s.id

  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.bezierCurveTo(mx, y0, mx, y3, x3, y3)
  // Edges carry a soft tint of the child's category colour so the tree reads as
  // coloured branches rather than flat grey; the focused edge brightens.
  ctx.strokeStyle = lit ? rgba(t.color, 0.85) : rgba(t.color, 0.32)
  ctx.lineWidth = (lit ? 1.7 : 1) / scale
  ctx.stroke()

  // flow pip
  const tt = (phase + l.off) % 1
  const px = bezier(x0, mx, mx, x3, tt)
  const py = bezier(y0, y0, y3, y3, tt)
  ctx.drawImage(glowSprite(t.color), px - 6, py - 6, 12, 12)
  ctx.beginPath()
  ctx.arc(px, py, 1.6, 0, TAU)
  ctx.fillStyle = rgba(t.color, 0.95)
  ctx.fill()
}
