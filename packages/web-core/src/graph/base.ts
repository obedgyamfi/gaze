// ── Base graph builder (unenriched, structural) ───────────────────────────────
// The "current graph without enrichment" — host/leaf structure + category only,
// NO risk/prose/semantic-edges. Mirrors the intent of opencode's UI buildTree
// (packages/app/.../graph-model.ts) but headless (no x/y layout, no colors). Pure
// and fully DECOUPLED from the enriched builder: same input, separate output, so
// changing one never forces a rewrite of the other.

import type { CaptureRecord, FormRecord, NavRecord } from "../capture-source.js"
import type { BaseCategory, BaseEdge, BaseGraph, BaseNode } from "../types.js"

const API_TYPES = new Set(["XHR", "Fetch", "EventSource", "WebSocket", "Preflight", "Ping"])
const EXT_STYLE = new Set(["css"])
const EXT_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp"])
const EXT_FONT = new Set(["woff", "woff2", "ttf", "otf", "eot"])
const EXT_MEDIA = new Set(["mp4", "webm", "ogg", "ogv", "mp3", "wav", "m4a", "mov", "avi"])

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}
function extOf(path: string): string {
  const last = path.split("/").pop() ?? ""
  const dot = last.lastIndexOf(".")
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : ""
}

export function categoryOf(record: { resourceType?: string; url: string; contentType?: string }): BaseCategory {
  const t = record.resourceType
  if (t === "Document") return "page"
  if (t && API_TYPES.has(t)) return "api"
  if (t === "Script") return "script"
  const ext = extOf(safeUrl(record.url)?.pathname ?? record.url)
  if (t === "Stylesheet" || EXT_STYLE.has(ext)) return "style"
  if (t === "Image" || EXT_IMAGE.has(ext)) return "image"
  if (t === "Font" || EXT_FONT.has(ext)) return "font"
  if (t === "Media" || EXT_MEDIA.has(ext)) return "media"
  const ct = record.contentType ?? ""
  if (ct.includes("json") || ct.includes("xml")) return "api"
  return "other"
}

export function buildBaseGraph(input: { captures: CaptureRecord[]; navs?: NavRecord[]; forms?: FormRecord[] }): BaseGraph {
  const nodes = new Map<string, BaseNode>()
  const edges = new Map<string, BaseEdge>()
  const pageHosts = new Set<string>()

  const domainNode = (host: string): BaseNode => {
    const id = `dom:${host}`
    let n = nodes.get(id)
    if (!n) {
      n = { id, kind: "domain", label: host, category: null, host, captureIds: [] }
      nodes.set(id, n)
    }
    return n
  }
  const link = (source: string, target: string) => {
    const id = `${source}>${target}`
    if (!edges.has(id)) edges.set(id, { id, source, target })
  }

  const leaf = (url: string, category: BaseCategory, captureId?: string) => {
    const u = safeUrl(url)
    if (!u) return
    const host = u.host
    if (category === "page") pageHosts.add(host)
    const dom = domainNode(host)
    const id = `leaf:${url}`
    let n = nodes.get(id)
    if (!n) {
      n = { id, kind: "leaf", label: u.pathname || "/", category, url, host, captureIds: [] }
      nodes.set(id, n)
    }
    if (captureId) n.captureIds.push(captureId)
    link(dom.id, id)
  }

  for (const c of input.captures) {
    leaf(c.url, categoryOf({ resourceType: c.resourceType, url: c.url, contentType: c.responseBody?.contentType }), c.id)
  }
  for (const nav of input.navs ?? []) leaf(nav.url, "page")
  for (const f of input.forms ?? []) leaf(f.action, "form")

  // External overlay: a leaf whose host never served a page is third-party.
  for (const n of nodes.values()) {
    if (n.kind === "leaf" && n.category && n.category !== "page" && n.category !== "form" && !pageHosts.has(n.host)) {
      n.category = "external"
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], version: input.captures.length }
}
