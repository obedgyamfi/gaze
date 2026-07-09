// ── JS analyzer collector ─────────────────────────────────────────────────────
// Fetches script assets (scope-gated, via ctx.net) and statically extracts hidden
// endpoints + secret refs, emitting one `js` Observation per script. Pure
// orchestration over the injected ctx — no direct network, no code execution.

import type { Collector, CollectorCtx, CollectorResult } from "../types.js"
import { detectSecrets, extractEndpoints } from "../analyze-js.js"

export interface JsAnalyzerConfig {
  /** Script URLs to analyze (e.g. from capture or a crawl). */
  urls: string[]
  /** Base URL for resolving relative endpoint paths (defaults to each script's URL). */
  baseUrl?: string
  /** Cap bytes read per script. */
  maxBytes?: number
}

export const jsAnalyzerCollector: Collector<JsAnalyzerConfig> = {
  id: "js-analyzer",
  async run(ctx: CollectorCtx, cfg: JsAnalyzerConfig): Promise<CollectorResult> {
    let emitted = 0
    let truncated = false
    const limit = ctx.budget?.maxItems ?? cfg.urls.length
    const urls = cfg.urls.slice(0, limit)
    if (urls.length < cfg.urls.length) truncated = true

    for (const url of urls) {
      if (ctx.signal.aborted) {
        truncated = true
        break
      }
      let body: string
      try {
        const res = await ctx.net.fetch({ method: "GET", url, maxBytes: cfg.maxBytes ?? 3_000_000, signal: ctx.signal })
        body = res.body
      } catch (e) {
        ctx.log({ collector: "js-analyzer", message: `skip ${url}: ${e instanceof Error ? e.message : String(e)}` })
        continue
      }
      const endpoints = extractEndpoints(body, cfg.baseUrl ?? url)
      const secrets = detectSecrets(body)
      ctx.emit({ kind: "js", url, endpoints, secrets, via: { collector: "js-analyzer", sourceUrl: url, at: Date.now() } })
      emitted++
      ctx.log({ collector: "js-analyzer", message: `${url}: ${endpoints.length} endpoints, ${secrets.length} secrets`, progress: emitted / urls.length })
    }
    return { emitted, truncated }
  },
}
