import { createEffect, on, onCleanup, onMount } from "solid-js"
import ForceGraph from "force-graph"
import { statusClassColor, type TreeLink, type TreeNode, type WebTree } from "./graph-model"
import type { GraphView } from "./graph-state"

// Tidy-tree renderer. force-graph is used only as the canvas / zoom / pan / pointer
// host — node positions come straight from the deterministic tidy-tree layout, so
// the same captures always yield the same picture. The simulation is frozen; we
// drive x/y ourselves. Updates are handled by a single reconcile against a stable
// node cache, so a stream of captures never tears the graph down:
//   • a node's position eases toward its new tidy-tree slot (no snapping),
//   • a brand-new node pops in (scale 0 → 1),
//   • a node that disappears pops out (scale → 0) and is then dropped.
// force-graph's dataset is only re-handed over when the node/link SET changes.

const TAU = Math.PI * 2
const POP_IN_MS = 260
const POP_OUT_MS = 170
// Per-frame easing toward the tidy-tree target — quick enough to never feel laggy.
const EASE = 0.25

type FGNode = TreeNode & {
  fx?: number
  fy?: number
  // tidy-tree target; x/y ease toward it each frame
  tx: number
  ty: number
  // pop animation: 0 (gone) → 1 (full). `exit` set when the node is leaving.
  scale: number
  born: number
  exit?: number
  __nbr?: Set<string>
}
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
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

export interface GraphCanvasApi {
  fit: () => void
}

export function GraphCanvas(props: {
  tree: WebTree
  selectedId?: string
  query?: string
  initialView?: GraphView | null
  onSelect: (node: TreeNode | undefined) => void
  onToggleCollapse: (id: string) => void
  onView?: (view: GraphView) => void
  onReady?: (api: GraphCanvasApi) => void
}) {
  let container!: HTMLDivElement
  let graph: ForceGraph | undefined
  const cache = new Map<string, FGNode>()
  let links: TreeLink[] = []
  const theme = { label: "#171717", root: "#171717", accent: "#2563eb" }
  let phase = 0
  const view = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
  let lastClick = { id: "", at: 0 }
  let loaded = false
  let dirty = false

  const resolveTheme = () => {
    const css = getComputedStyle(document.documentElement)
    theme.label = css.getPropertyValue("--text-strong").trim() || theme.label
    theme.root = css.getPropertyValue("--text-stronger").trim() || theme.label
    theme.accent =
      css.getPropertyValue("--primary").trim() || css.getPropertyValue("--icon-strong").trim() || theme.accent
  }

  // Hand the current cache (minus fully-gone nodes) to force-graph. Only called when
  // the node/link set actually changes, so steady-state captures don't reset it.
  const pushData = () => {
    if (!graph) return
    const nodes = [...cache.values()]
    const present = new Set(nodes.map((n) => n.id))
    for (const n of nodes) n.__nbr = new Set([n.id])
    const out: FGLink[] = []
    for (const l of links) {
      if (!present.has(l.source) || !present.has(l.target)) continue
      cache.get(l.source)?.__nbr?.add(l.target)
      cache.get(l.target)?.__nbr?.add(l.source)
      out.push({ source: l.source, target: l.target, off: linkOff(l.id) })
    }
    graph.graphData({ nodes, links: out })
  }

  const restoreView = () => {
    const v = props.initialView
    if (!graph || !v) return
    try {
      graph.zoom(v.k, 0)
      graph.centerAt(v.x, v.y, 0)
    } catch {
      /* force-graph camera API differs across versions — best effort */
    }
  }

  const persistView = () => {
    if (!graph || !props.onView) return
    try {
      const c = graph.centerAt()
      props.onView({ k: graph.zoom(), x: c.x, y: c.y })
    } catch {
      /* ignore */
    }
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
        if (n.exit !== undefined) return
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x ?? 0, n.y ?? 0, radiusOf(n) + 3, 0, TAU)
        ctx.fill()
      })
      .onNodeClick((node: any) => {
        const n = node as FGNode
        if (n.exit !== undefined) return
        const now = performance.now()
        const dbl = lastClick.id === n.id && now - lastClick.at < 320
        lastClick = { id: n.id, at: now }
        if (dbl && n.hasKids) props.onToggleCollapse(n.id)
        else props.onSelect(n)
      })
      .onBackgroundClick(() => props.onSelect(undefined))
      .onZoomEnd(persistView)
      .onRenderFramePre((ctx: CanvasRenderingContext2D, scale: number) => {
        void ctx
        void scale
        phase = (phase + 0.0026) % 1
        const now = performance.now()
        // Advance every node: ease toward its slot, run the pop in / out, and retire
        // nodes whose pop-out has finished (then re-hand the trimmed set to force-graph).
        for (const n of cache.values()) {
          if (n.exit !== undefined) {
            n.scale = Math.max(0, 1 - (now - n.exit) / POP_OUT_MS)
            if (n.scale <= 0) {
              cache.delete(n.id)
              dirty = true
              continue
            }
          } else if (n.scale < 1) {
            n.scale = Math.min(1, easeOutCubic((now - n.born) / POP_IN_MS))
          }
          const dx = n.tx - (n.x ?? n.tx)
          const dy = n.ty - (n.y ?? n.ty)
          if (Math.abs(dx) < 0.06 && Math.abs(dy) < 0.06) {
            n.x = n.tx
            n.y = n.ty
          } else {
            n.x = (n.x ?? n.tx) + dx * EASE
            n.y = (n.y ?? n.ty) + dy * EASE
          }
          n.fx = n.x
          n.fy = n.y
        }
        if (dirty) {
          dirty = false
          pushData()
        }
        const tl = fg.screen2GraphCoords(0, 0)
        const br = fg.screen2GraphCoords(container.clientWidth, container.clientHeight)
        view.minX = Math.min(tl.x, br.x) - 120
        view.maxX = Math.max(tl.x, br.x) + 120
        view.minY = Math.min(tl.y, br.y) - 120
        view.maxY = Math.max(tl.y, br.y) + 120
      })

    reconcile(props.tree)
    restoreView()

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      fg.width(Math.round(width)).height(Math.round(height))
    })
    ro.observe(container)

    // The renderer redraws every frame for the flow particles; pause it whenever the
    // canvas is offscreen (window backgrounded) so it doesn't burn frames.
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) fg.resumeAnimation()
      else fg.pauseAnimation()
    })
    io.observe(container)

    props.onReady?.({ fit: () => fg.zoomToFit(450, 70) })

    onCleanup(() => {
      persistView()
      ro.disconnect()
      io.disconnect()
      fg._destructor?.()
      graph = undefined
    })
  })

  // Reconcile the incoming tidy tree into the stable node cache.
  const reconcile = (tree: WebTree) => {
    if (!graph) return
    const now = performance.now()
    links = tree.links
    const incoming = new Set(tree.nodes.map((n) => n.id))
    let setChanged = false

    // Nodes that vanished start popping out (kept around until the pop-out finishes).
    for (const n of cache.values()) {
      if (n.exit === undefined && !incoming.has(n.id)) {
        n.exit = now
        setChanged = true
      }
    }

    for (const tn of tree.nodes) {
      const ex = cache.get(tn.id)
      if (ex) {
        const reviving = ex.exit !== undefined
        const px = ex.x
        const py = ex.y
        Object.assign(ex, tn) // refresh label/status/etc (overwrites x/y with the target)
        ex.exit = undefined
        ex.tx = tn.x
        ex.ty = tn.y
        ex.x = px ?? tn.x // keep the rendered position; the frame loop eases it to the target
        ex.y = py ?? tn.y
        if (reviving) {
          ex.born = now
          setChanged = true
        }
        continue
      }
      // New node: appears in place, pops in. The very first load shows everything
      // already settled (born in the past, full scale) so reopening the tab is instant.
      cache.set(tn.id, {
        ...tn,
        tx: tn.x,
        ty: tn.y,
        x: tn.x,
        y: tn.y,
        fx: tn.x,
        fy: tn.y,
        born: loaded ? now : 0,
        scale: loaded ? 0 : 1,
      })
      setChanged = true
    }

    if (setChanged || !loaded) {
      loaded = true
      pushData()
    }
  }

  // Initial reconcile happens in onMount (once force-graph exists); this only handles
  // later tree changes as captures stream in.
  createEffect(
    on(
      () => props.tree,
      (tree) => reconcile(tree),
      { defer: true },
    ),
  )

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

function paintNode(
  n: FGNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  props: PaintProps,
  theme: { label: string; root: string; accent: string },
  view: View,
) {
  const x = n.x ?? 0
  const y = n.y ?? 0
  if (x < view.minX || x > view.maxX || y < view.minY || y > view.maxY) return

  const pop = n.scale
  const selected = n.id === props.selectedId
  const q = props.query?.trim().toLowerCase()
  const match = q ? `${n.label} ${n.url ?? ""} ${n.host}`.toLowerCase().includes(q) : true
  const dim = !!q && !match
  const isDir = n.kind === "directory"
  const base = radiusOf(n)
  const r = base * (0.35 + 0.65 * pop)

  ctx.globalAlpha = (dim ? 0.18 : 1) * pop

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
  ctx.strokeStyle = selected ? theme.accent : (statusColor ?? rgba(n.color, 0.85))
  ctx.stroke()

  // attention ring for redirects / errors
  if (statusColor && (n.status ?? 0) >= 300) {
    ctx.beginPath()
    ctx.arc(x, y, r + 2.6, 0, TAU)
    ctx.strokeStyle = statusColor
    ctx.lineWidth = 1.5 / scale
    ctx.stroke()
  }

  // label — wraps onto a second line instead of truncating from the front. Hidden
  // when zoomed out; always shown when selected or matched by search. Faded with the
  // pop so it doesn't flash in ahead of the node.
  if (pop > 0.6 && (scale > 0.85 || selected || (q && match))) {
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

function paintLink(
  l: FGLink,
  ctx: CanvasRenderingContext2D,
  scale: number,
  props: PaintProps,
  phase: number,
  view: View,
) {
  const s = l.source as FGNode
  const t = l.target as FGNode
  if (!s || !t || s.x == null || t.x == null) return
  const loX = Math.min(s.x, t.x)
  const hiX = Math.max(s.x, t.x)
  const loY = Math.min(s.y!, t.y!)
  const hiY = Math.max(s.y!, t.y!)
  if (hiX < view.minX || loX > view.maxX || hiY < view.minY || loY > view.maxY) return

  const alpha = Math.min(s.scale ?? 1, t.scale ?? 1)
  if (alpha <= 0) return
  const sr = radiusOf(s)
  const tr = radiusOf(t)
  const x0 = s.x + sr
  const y0 = s.y!
  const x3 = t.x - tr
  const y3 = t.y!
  const mx = (x0 + x3) / 2
  const lit = props.selectedId === t.id || props.selectedId === s.id

  ctx.globalAlpha = alpha
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
  ctx.globalAlpha = 1
}
