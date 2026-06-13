// Tidy attack-surface tree. The graph is a VISUAL LAYER of what the browser
// loaded: Root → Domain(host) → path directories → leaf (page / endpoint /
// resource). Single-child directory chains are compressed; colour encodes the
// node category only (no risk/enrichment). Every leaf keeps the capture ids that
// produced it so the inspector can show them verbatim.
//
// Layout is a horizontal tidy tree: depth → X column, leaf order → Y row, each
// parent centred on its children. The geometry guarantees nodes never overlap.

import type { CaptureRecord, FormRecord, NavRecord } from "@/web/capture-types"

export type Category =
  | "page"
  | "api"
  | "form"
  | "script"
  | "style"
  | "image"
  | "font"
  | "media"
  | "external"
  | "other"

export type TreeKind = "root" | "domain" | "directory" | "leaf"

export interface TreeNode {
  id: string
  label: string
  kind: TreeKind
  category: Category | null
  url?: string
  host: string
  method?: string
  status?: number
  resourceType?: string
  depth: number
  x: number
  y: number
  hasKids: boolean
  collapsed: boolean
  descCount: number
  captureIds: string[]
  color: string
}

export interface TreeLink {
  id: string
  source: string
  target: string
}

export interface WebTree {
  nodes: TreeNode[]
  links: TreeLink[]
}

// ── palette ───────────────────────────────────────────────────────────────────
// Deep ~600-weight jewel tones spread across the hue wheel: each category is
// distinguishable, and every one keeps enough contrast to read on both the light
// (#eee) and dark canvas. Structural nodes (root/domain/dir) are neutral slates
// rather than near-white so they don't vanish in light mode.

export const CATEGORY_META: { key: Category; label: string; color: string }[] = [
  { key: "page", label: "Pages", color: "#d97706" }, // amber — the backbone
  { key: "api", label: "API", color: "#2563eb" }, // blue — primary signal
  { key: "form", label: "Forms", color: "#e11d48" }, // rose — attack surface
  { key: "script", label: "Scripts", color: "#16a34a" }, // green
  { key: "style", label: "Styles", color: "#0d9488" }, // teal
  { key: "image", label: "Images", color: "#ea580c" }, // orange
  { key: "font", label: "Fonts", color: "#7c3aed" }, // violet
  { key: "media", label: "Media", color: "#db2777" }, // magenta
  { key: "external", label: "External", color: "#6366f1" }, // indigo
  { key: "other", label: "Other", color: "#64748b" }, // slate
]
export const CATEGORY_COLOR = Object.fromEntries(CATEGORY_META.map((c) => [c.key, c.color])) as Record<Category, string>
const ROOT_COLOR = "#334155" // slate-700 — the hub
const DOMAIN_COLOR = "#475569" // slate-600
const DIR_COLOR = "#94a3b8" // slate-400 — de-emphasized scaffolding

export const STATUS_CLASS_COLOR: Record<string, string> = {
  "2": "#10b981",
  "3": "#60a5fa",
  "4": "#fbbf24",
  "5": "#f43f5e",
}
export function statusClassColor(code: number | undefined): string | null {
  if (!code || code < 100 || code > 599) return null
  return STATUS_CLASS_COLOR[String(Math.floor(code / 100))] ?? null
}

// High-signal categories visible by default; static noise is hidden until asked.
export const DEFAULT_CATEGORIES = new Set<Category>(["page", "api", "form", "external", "other"])
export function defaultFilters(): Record<Category, boolean> {
  return Object.fromEntries(CATEGORY_META.map((c) => [c.key, DEFAULT_CATEGORIES.has(c.key)])) as Record<Category, boolean>
}

const EXT_STYLE = new Set(["css"])
const EXT_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp"])
const EXT_FONT = new Set(["woff", "woff2", "ttf", "otf", "eot"])
const EXT_MEDIA = new Set(["mp4", "webm", "ogg", "ogv", "mp3", "wav", "m4a", "mov", "avi"])
const API_TYPES = new Set(["XHR", "Fetch", "EventSource", "WebSocket", "Preflight", "Ping"])

function extOf(path: string): string {
  const last = path.split("/").pop() ?? ""
  const dot = last.lastIndexOf(".")
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : ""
}

export function categoryOf(record: { resourceType?: string; url: string; responseBody?: { contentType?: string } }): Category {
  const t = record.resourceType
  if (t === "Document") return "page"
  if (t && API_TYPES.has(t)) return "api"
  if (t === "Script") return "script"
  const ext = extOf(safePath(record.url))
  if (t === "Stylesheet" || EXT_STYLE.has(ext)) return "style"
  if (t === "Image" || EXT_IMAGE.has(ext)) return "image"
  if (t === "Font" || EXT_FONT.has(ext)) return "font"
  if (t === "Media" || EXT_MEDIA.has(ext)) return "media"
  const ct = record.responseBody?.contentType ?? ""
  if (ct.includes("json") || ct.includes("xml")) return "api"
  return "other"
}

function categoryColor(category: Category | null): string {
  return category ? CATEGORY_COLOR[category] : "#64748b"
}

// ── raw tree construction ─────────────────────────────────────────────────────

const ROOT_ID = "__root__"
const COL_GAP = 188
const ROW_GAP = 22

interface RawNode {
  id: string
  label: string
  kind: TreeKind
  category: Category | null
  parentId: string | null
  url?: string
  host: string
  method?: string
  status?: number
  resourceType?: string
  captureIds: string[]
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}
function safePath(url: string): string {
  return safeUrl(url)?.pathname ?? url
}

function ensure(nm: Map<string, RawNode>, id: string, base: Omit<RawNode, "id" | "captureIds">): RawNode {
  let n = nm.get(id)
  if (!n) {
    n = { id, captureIds: [], ...base }
    nm.set(id, n)
  }
  return n
}

function addLeafCapture(n: RawNode, record: { id: string; method?: string; status?: number }) {
  n.captureIds.push(record.id)
  if (record.method) n.method = record.method
  if (record.status != null) n.status = record.status
}

export function buildTree(input: {
  captures: CaptureRecord[]
  navs?: NavRecord[]
  forms?: FormRecord[]
  filters?: Record<Category, boolean>
  collapsed?: Set<string>
}): WebTree {
  const filters = input.filters
  const collapsed = input.collapsed ?? new Set<string>()
  const nm = new Map<string, RawNode>()
  const links = new Map<string, TreeLink>()
  const addLink = (source: string, target: string) => {
    const id = `${source}>${target}`
    if (!links.has(id)) links.set(id, { id, source, target })
  }

  nm.set(ROOT_ID, { id: ROOT_ID, label: "ATTACK SURFACE", kind: "root", category: null, parentId: null, host: "", captureIds: [] })

  const pageHosts = new Set<string>()

  const branch = (url: string, category: Category, record?: { id: string; method?: string; status?: number; resourceType?: string }) => {
    const u = safeUrl(url)
    if (!u) return
    const host = u.host
    if (category === "page") pageHosts.add(host)
    const domainId = `dom:${host}`
    ensure(nm, domainId, { label: host, kind: "domain", category: null, parentId: ROOT_ID, host })
    addLink(ROOT_ID, domainId)

    let segs = u.pathname.split("/").filter(Boolean)
    if (segs.length === 0) segs = [""]
    let parent = domainId
    let acc = ""
    for (let i = 0; i < segs.length; i++) {
      acc += "/" + segs[i]
      const isLast = i === segs.length - 1
      const segId = `seg:${host}${acc}`
      const node = ensure(nm, segId, {
        label: "/" + segs[i],
        kind: isLast ? "leaf" : "directory",
        category: isLast ? category : null,
        parentId: parent,
        host,
        url: isLast ? url : undefined,
        resourceType: isLast ? record?.resourceType : undefined,
      })
      if (isLast) {
        node.kind = "leaf"
        node.category = category
        node.url = url
        node.resourceType = record?.resourceType
        if (record) addLeafCapture(node, record)
      }
      addLink(parent, segId)
      parent = segId
    }
  }

  for (const r of input.captures) {
    branch(r.url, categoryOf(r), r)
  }
  for (const nav of input.navs ?? []) {
    branch(nav.url, "page")
  }
  for (const form of input.forms ?? []) {
    branch(form.action, "form")
  }

  // External overlay: a leaf whose host never served a page is third-party.
  for (const n of nm.values()) {
    if (n.kind === "leaf" && n.category && n.category !== "page" && n.category !== "form" && !pageHosts.has(n.host)) {
      n.category = "external"
    }
  }

  compressChains(nm, links)
  if (filters) filterCategories(nm, links, filters)

  return layout(nm, links, collapsed)
}

// Merge single-child directory chains: /a → /b → /c collapses to one "/a/b/c".
function compressChains(nm: Map<string, RawNode>, links: Map<string, TreeLink>): void {
  const kids = childIndex(links)
  const removed = new Set<string>()
  let merged = true
  while (merged) {
    merged = false
    for (const node of nm.values()) {
      if (removed.has(node.id) || node.kind !== "directory") continue
      const ks = (kids.get(node.id) ?? []).filter((k) => !removed.has(k))
      if (ks.length !== 1) continue
      const child = nm.get(ks[0])
      if (!child) continue
      node.label += child.label
      node.kind = child.kind
      node.category = child.category
      node.url = child.url
      node.resourceType = child.resourceType
      node.method = child.method
      node.status = child.status
      node.captureIds = child.captureIds
      const gks = (kids.get(child.id) ?? []).filter((k) => !removed.has(k))
      kids.set(node.id, gks)
      for (const gk of gks) {
        const g = nm.get(gk)
        if (g) g.parentId = node.id
      }
      removed.add(child.id)
      merged = true
    }
  }
  for (const id of removed) nm.delete(id)
  rebuildLinks(nm, links, kids, removed)
}

function filterCategories(nm: Map<string, RawNode>, links: Map<string, TreeLink>, filters: Record<Category, boolean>): void {
  const kids = childIndex(links)
  const removed = new Set<string>()
  const drop = (id: string) => {
    if (removed.has(id)) return
    removed.add(id)
    for (const k of kids.get(id) ?? []) drop(k)
  }
  for (const n of nm.values()) {
    if (n.kind === "leaf" && n.category && !filters[n.category]) drop(n.id)
  }
  // prune now-empty directories/domains
  let pruned = true
  while (pruned) {
    pruned = false
    for (const n of nm.values()) {
      if (removed.has(n.id) || n.id === ROOT_ID) continue
      if (n.kind !== "directory" && n.kind !== "domain") continue
      const ks = (kids.get(n.id) ?? []).filter((k) => !removed.has(k))
      if (ks.length === 0) {
        removed.add(n.id)
        pruned = true
      }
    }
  }
  for (const id of removed) nm.delete(id)
  rebuildLinks(nm, links, kids, removed)
}

// ── tidy layout ───────────────────────────────────────────────────────────────

function layout(nm: Map<string, RawNode>, links: Map<string, TreeLink>, collapsed: Set<string>): WebTree {
  const kids = childIndex(links)
  for (const list of kids.values()) list.sort((a, b) => sortKey(nm.get(a)).localeCompare(sortKey(nm.get(b))))

  const descCount = new Map<string, number>()
  const countDesc = (id: string): number => {
    const cached = descCount.get(id)
    if (cached !== undefined) return cached
    let total = 0
    for (const c of kids.get(id) ?? []) total += 1 + countDesc(c)
    descCount.set(id, total)
    return total
  }
  countDesc(ROOT_ID)

  const nodes: TreeNode[] = []
  let leafCursor = 0
  const walk = (id: string, depth: number): number => {
    const raw = nm.get(id)
    if (!raw) return 0
    const children = collapsed.has(id) ? [] : (kids.get(id) ?? [])
    let y: number
    if (children.length === 0) {
      y = leafCursor * ROW_GAP
      leafCursor++
    } else {
      const ys = children.map((c) => walk(c, depth + 1))
      y = (ys[0] + ys[ys.length - 1]) / 2
    }
    nodes.push({
      id: raw.id,
      label: raw.label,
      kind: raw.kind,
      category: raw.category,
      url: raw.url,
      host: raw.host,
      method: raw.method,
      status: raw.status,
      resourceType: raw.resourceType,
      depth,
      x: depth * COL_GAP,
      y,
      hasKids: (kids.get(id) ?? []).length > 0,
      collapsed: collapsed.has(id),
      descCount: descCount.get(id) ?? 0,
      captureIds: raw.captureIds,
      color: colorOf(raw),
    })
    return y
  }
  walk(ROOT_ID, 0)

  if (nodes.length) {
    let min = Infinity
    let max = -Infinity
    for (const n of nodes) {
      if (n.y < min) min = n.y
      if (n.y > max) max = n.y
    }
    const mid = (min + max) / 2
    for (const n of nodes) n.y -= mid
  }

  const ids = new Set(nodes.map((n) => n.id))
  const outLinks: TreeLink[] = []
  for (const n of nodes) {
    const parent = nm.get(n.id)?.parentId
    if (parent && ids.has(parent)) outLinks.push({ id: `${parent}>${n.id}`, source: parent, target: n.id })
  }
  return { nodes, links: outLinks }
}

function colorOf(raw: RawNode): string {
  if (raw.kind === "root") return ROOT_COLOR
  if (raw.kind === "domain") return DOMAIN_COLOR
  if (raw.kind === "directory") return DIR_COLOR
  return categoryColor(raw.category)
}

function sortKey(n: RawNode | undefined): string {
  if (!n) return "9"
  const rank = n.kind === "directory" || n.kind === "domain" ? 0 : n.category === "page" ? 1 : n.category === "api" || n.category === "form" ? 2 : 3
  return `${rank}${n.label.toLowerCase()}`
}

// ── link helpers ──────────────────────────────────────────────────────────────

function childIndex(links: Map<string, TreeLink>): Map<string, string[]> {
  const kids = new Map<string, string[]>()
  for (const l of links.values()) {
    if (!kids.has(l.source)) kids.set(l.source, [])
    kids.get(l.source)!.push(l.target)
  }
  return kids
}

function rebuildLinks(
  nm: Map<string, RawNode>,
  links: Map<string, TreeLink>,
  kids: Map<string, string[]>,
  removed: Set<string>,
): void {
  links.clear()
  for (const [p, ks] of kids) {
    if (removed.has(p) || !nm.has(p)) continue
    for (const k of ks) {
      if (removed.has(k) || !nm.has(k)) continue
      links.set(`${p}>${k}`, { id: `${p}>${k}`, source: p, target: k })
    }
  }
}
