// ── Parameter miner collector ─────────────────────────────────────────────────
// Probes candidate query params against an endpoint and reports those that visibly
// influence the response (reflected canary or a length delta vs baseline). Reflected
// params are flagged — a direct XSS/injection candidate for the oracle downstream.

import type { Collector, CollectorCtx, CollectorResult, ParamObs } from "../types.js"

export interface ParamMinerConfig {
  url: string
  params: string[]
  canary?: string
  maxBytes?: number
}

export const paramMinerCollector: Collector<ParamMinerConfig> = {
  id: "param-miner",
  async run(ctx: CollectorCtx, cfg: ParamMinerConfig): Promise<CollectorResult> {
    const maxBytes = cfg.maxBytes ?? 600_000
    const canary = cfg.canary ?? `gaze${Math.random().toString(36).slice(2, 10)}`
    let host: string
    try {
      host = new URL(cfg.url).hostname
    } catch {
      return { emitted: 0, truncated: false }
    }
    if (!ctx.scope.allows({ host })) return { emitted: 0, truncated: false }

    const baseline = await ctx.net.fetch({ method: "GET", url: cfg.url, maxBytes, signal: ctx.signal })
    const params = cfg.params.slice(0, ctx.budget?.maxItems ?? cfg.params.length)
    const truncated = params.length < cfg.params.length

    const found: ParamObs[] = []
    const reflected: string[] = []
    await Promise.all(
      params.map(async (name) => {
        if (ctx.signal.aborted) return
        const u = new URL(cfg.url)
        u.searchParams.set(name, canary)
        let res
        try {
          res = await ctx.net.fetch({ method: "GET", url: u.toString(), maxBytes, signal: ctx.signal })
        } catch {
          return
        }
        const isReflected = res.body.includes(canary)
        const changed = Math.abs(res.bytes - baseline.bytes) > 32
        if (isReflected || changed) {
          found.push({ name, loc: "query" })
          if (isReflected) reflected.push(name)
        }
      }),
    )

    if (found.length > 0) {
      ctx.emit({
        kind: "endpoint",
        method: "GET",
        url: cfg.url,
        params: found,
        via: { collector: "param-miner", at: Date.now() },
      })
    }
    if (reflected.length > 0) {
      ctx.log({ collector: "param-miner", message: `reflected params (xss candidates): ${reflected.join(", ")}` })
    }
    return { emitted: found.length, truncated }
  },
}
