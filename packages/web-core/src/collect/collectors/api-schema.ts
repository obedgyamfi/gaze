// ── API schema import collector ───────────────────────────────────────────────
// Ingests an OpenAPI/Swagger doc or a GraphQL introspection result (inline or fetched
// scope-gated via ctx.net) and emits an endpoint Observation per operation.

import type { Collector, CollectorCtx, CollectorResult } from "../types.js"
import { detectSchemaKind, parseGraphqlIntrospection, parseOpenApi } from "../api-schema.js"

export interface ApiSchemaConfig {
  /** Fetch the schema from here (scope-gated). */
  url?: string
  /** Or supply a parsed schema object directly. */
  schema?: unknown
  /** GraphQL operations POST here (defaults to `url`). */
  graphqlUrl?: string
  maxBytes?: number
}

export const apiSchemaCollector: Collector<ApiSchemaConfig> = {
  id: "api-schema",
  async run(ctx: CollectorCtx, cfg: ApiSchemaConfig): Promise<CollectorResult> {
    let doc = cfg.schema
    if (doc == null && cfg.url) {
      const host = (() => {
        try {
          return new URL(cfg.url).hostname
        } catch {
          return undefined
        }
      })()
      if (!host || !ctx.scope.allows({ host })) return { emitted: 0, truncated: false }
      try {
        const res = await ctx.net.fetch({ method: "GET", url: cfg.url, maxBytes: cfg.maxBytes ?? 5_000_000, signal: ctx.signal })
        doc = JSON.parse(res.body)
      } catch (e) {
        ctx.log({ collector: "api-schema", message: `fetch/parse failed: ${e instanceof Error ? e.message : String(e)}` })
        return { emitted: 0, truncated: false }
      }
    }
    if (doc == null) return { emitted: 0, truncated: false }

    const kind = detectSchemaKind(doc)
    const endpoints =
      kind === "graphql"
        ? parseGraphqlIntrospection(doc, cfg.graphqlUrl ?? cfg.url ?? "graphql://endpoint")
        : kind === "openapi"
          ? parseOpenApi(doc, cfg.url)
          : []

    for (const ep of endpoints) {
      ctx.emit({
        kind: "endpoint",
        method: ep.method,
        url: ep.url,
        params: ep.params,
        via: { collector: "api-schema", sourceUrl: cfg.url, at: Date.now() },
      })
    }
    ctx.log({ collector: "api-schema", message: `${kind}: ${endpoints.length} operations` })
    return { emitted: endpoints.length, truncated: false }
  },
}
