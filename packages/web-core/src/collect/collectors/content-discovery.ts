// ── Content discovery collector ───────────────────────────────────────────────
// Wordlist path probing with soft-404 calibration: learn the "not found" fingerprint
// first, then only report paths that deviate from it. Scope-gated + scheduler-rated.

import type { Collector, CollectorCtx, CollectorResult } from "../types.js"

export interface ContentDiscoveryConfig {
  baseUrl: string
  wordlist: string[]
  extensions?: string[]
  maxBytes?: number
}

interface Probe {
  status: number
  bytes: number
}

/** Heuristic: does this response look like a real hit vs the soft-404 baseline? */
export function isHit(res: Probe, soft404: Probe): boolean {
  if (res.status >= 500) return false
  if (soft404.status === 404) return res.status !== 404
  // catch-all baseline (e.g. 200 SPA shell): require a meaningful signal
  if ([301, 302, 307, 308, 401, 403].includes(res.status)) return true
  if (res.status < 300) return Math.abs(res.bytes - soft404.bytes) > Math.max(64, soft404.bytes * 0.2)
  return false
}

export const contentDiscoveryCollector: Collector<ContentDiscoveryConfig> = {
  id: "content-discovery",
  async run(ctx: CollectorCtx, cfg: ContentDiscoveryConfig): Promise<CollectorResult> {
    const base = cfg.baseUrl.endsWith("/") ? cfg.baseUrl : cfg.baseUrl + "/"
    const maxBytes = cfg.maxBytes ?? 400_000
    const probe = async (path: string): Promise<Probe | undefined> => {
      let url: string
      try {
        url = new URL(path, base).toString()
      } catch {
        return undefined
      }
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        return undefined
      }
      if (!ctx.scope.allows({ host })) return undefined
      try {
        const res = await ctx.net.fetch({ method: "GET", url, maxBytes, signal: ctx.signal })
        return { status: res.status, bytes: res.bytes }
      } catch {
        return undefined
      }
    }

    // Calibrate the soft-404 with an unlikely path.
    const soft404 = (await probe(`gaze-not-found-${Math.random().toString(36).slice(2)}`)) ?? { status: 404, bytes: 0 }

    const words = cfg.wordlist.slice(0, ctx.budget?.maxItems ?? cfg.wordlist.length)
    const truncated = words.length < cfg.wordlist.length
    const paths = words.flatMap((w) => [w, ...(cfg.extensions ?? []).map((e) => `${w}${e.startsWith(".") ? e : "." + e}`)])

    let emitted = 0
    const results = await Promise.all(
      paths.map(async (p) => {
        if (ctx.signal.aborted) return false
        const res = await probe(p)
        if (!res || !isHit(res, soft404)) return false
        const url = new URL(p, base).toString()
        ctx.emit({ kind: "endpoint", method: "GET", url, via: { collector: "content-discovery", at: Date.now() } })
        return true
      }),
    )
    emitted = results.filter(Boolean).length
    ctx.log({ collector: "content-discovery", message: `${emitted} paths found of ${paths.length} probed` })
    return { emitted, truncated }
  },
}
