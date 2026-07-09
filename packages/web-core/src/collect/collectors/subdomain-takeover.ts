// ── Subdomain-takeover collector ──────────────────────────────────────────────
// Probes candidate hosts and flags those serving a known unclaimed-service page as
// takeover candidates. Scope-gated; emits `takeover` Observations (Host → critical).

import type { Collector, CollectorCtx, CollectorResult } from "../types.js"
import { matchTakeover } from "../takeover-fingerprints.js"

export interface TakeoverConfig {
  hosts: string[]
  /** Try https then http per host (default true). */
  tryHttp?: boolean
  maxBytes?: number
}

export const subdomainTakeoverCollector: Collector<TakeoverConfig> = {
  id: "subdomain-takeover",
  async run(ctx: CollectorCtx, cfg: TakeoverConfig): Promise<CollectorResult> {
    const maxBytes = cfg.maxBytes ?? 200_000
    const hosts = cfg.hosts.slice(0, ctx.budget?.maxItems ?? cfg.hosts.length)
    const truncated = hosts.length < cfg.hosts.length
    let emitted = 0

    const results = await Promise.all(
      hosts.map(async (host) => {
        if (ctx.signal.aborted) return false
        if (!ctx.scope.allows({ host })) return false
        const schemes = cfg.tryHttp === false ? ["https"] : ["https", "http"]
        for (const scheme of schemes) {
          let body: string
          try {
            const res = await ctx.net.fetch({ method: "GET", url: `${scheme}://${host}/`, maxBytes, signal: ctx.signal })
            body = res.body
          } catch {
            continue
          }
          const hit = matchTakeover(body)
          if (hit) {
            ctx.emit({
              kind: "takeover",
              host,
              service: hit.service,
              fingerprint: hit.needle,
              confidence: hit.confidence,
              via: { collector: "subdomain-takeover", sourceUrl: `${scheme}://${host}/`, at: Date.now() },
            })
            ctx.log({ collector: "subdomain-takeover", message: `${host}: possible ${hit.service} takeover` })
            return true
          }
        }
        return false
      }),
    )
    emitted = results.filter(Boolean).length
    return { emitted, truncated }
  },
}
