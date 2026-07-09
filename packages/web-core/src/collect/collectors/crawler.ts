// ── HTTP crawler collector ────────────────────────────────────────────────────
// Scope-bounded BFS over server-rendered HTML: fetches pages via ctx.net, extracts
// links/forms, emits endpoint Observations, and enqueues in-scope links up to the
// page/depth budget. A deduped frontier keeps it from looping. (JS-rendered crawling
// is a desktop/CDP enhancement layered on top later.)

import type { Collector, CollectorCtx, CollectorResult } from "../types.js"
import { extractForms, extractLinks } from "../analyze-html.js"

export interface CrawlerConfig {
  seeds: string[]
  maxPages?: number
  maxDepth?: number
  maxBytes?: number
}

const norm = (u: string) => u.split("#")[0]
const hostOf = (u: string): string | undefined => {
  try {
    return new URL(u).hostname
  } catch {
    return undefined
  }
}

export const crawlerCollector: Collector<CrawlerConfig> = {
  id: "crawler",
  async run(ctx: CollectorCtx, cfg: CrawlerConfig): Promise<CollectorResult> {
    const maxPages = cfg.maxPages ?? ctx.budget?.maxItems ?? 200
    const maxDepth = cfg.maxDepth ?? 3
    const seen = new Set<string>()
    const frontier: { url: string; depth: number }[] = []
    for (const s of cfg.seeds) {
      const u = norm(s)
      if (!seen.has(u)) {
        seen.add(u)
        frontier.push({ url: u, depth: 0 })
      }
    }

    let emitted = 0
    let pages = 0
    while (frontier.length > 0 && pages < maxPages) {
      if (ctx.signal.aborted) break
      const { url, depth } = frontier.shift()!
      const host = hostOf(url)
      if (!host || !ctx.scope.allows({ host })) continue

      let html: string
      try {
        const res = await ctx.net.fetch({ method: "GET", url, maxBytes: cfg.maxBytes ?? 1_500_000, signal: ctx.signal })
        html = res.body
      } catch (e) {
        ctx.log({ collector: "crawler", message: `skip ${url}: ${e instanceof Error ? e.message : String(e)}` })
        continue
      }
      pages++
      ctx.emit({ kind: "endpoint", method: "GET", url, via: { collector: "crawler", at: Date.now() } })
      emitted++

      for (const f of extractForms(html, url)) {
        ctx.emit({
          kind: "endpoint",
          method: f.method,
          url: f.action,
          params: f.params.map((name) => ({ name, loc: f.method === "GET" ? "query" : "body" })),
          via: { collector: "crawler", sourceUrl: url, at: Date.now() },
        })
        emitted++
      }

      if (depth < maxDepth) {
        for (const link of extractLinks(html, url)) {
          const n = norm(link)
          const lh = hostOf(n)
          if (n && lh && ctx.scope.allows({ host: lh }) && !seen.has(n)) {
            seen.add(n)
            frontier.push({ url: n, depth: depth + 1 })
          }
        }
      }
      ctx.log({ collector: "crawler", message: `crawled ${url} (${pages}/${maxPages})`, progress: pages / maxPages })
    }

    return { emitted, truncated: frontier.length > 0 || pages >= maxPages }
  },
}
