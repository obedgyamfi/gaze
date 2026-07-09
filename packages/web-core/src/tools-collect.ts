// ── Collection tool surface ───────────────────────────────────────────────────
// Binds the discovery collectors to the agent as MCP tools. Each runs a collector
// over the host-supplied CollectRuntime (scope/net/scheduler), folding every
// Observation into the live attack-surface graph via ctx.collect.ingest. These make
// scoped network requests, so they are NOT read-only and refuse without a runtime.

import { z } from "zod"
import { defineTool, out, type HandlerCtx, type ToolOutput, type ToolSpec } from "./tools.js"
import type { CollectorCtx, Observation } from "./collect/types.js"
import { crawlerCollector } from "./collect/collectors/crawler.js"
import { jsAnalyzerCollector } from "./collect/collectors/js-analyzer.js"
import { contentDiscoveryCollector } from "./collect/collectors/content-discovery.js"
import { paramMinerCollector } from "./collect/collectors/param-miner.js"
import { subdomainTakeoverCollector } from "./collect/collectors/subdomain-takeover.js"
import { apiSchemaCollector } from "./collect/collectors/api-schema.js"

function collectorCtx(ctx: HandlerCtx, onEmit: (o: Observation) => void): CollectorCtx {
  const c = ctx.collect!
  return {
    scope: c.scope,
    net: c.net,
    scheduler: c.scheduler,
    emit: (o) => {
      c.ingest(o)
      onEmit(o)
    },
    workspace: { evidence: ctx.evidence, findings: ctx.findings, notes: ctx.notes, canvases: ctx.canvases, observations: ctx.observations, scope: ctx.scope },
    signal: ctx.signal ?? new AbortController().signal,
    log: () => {},
  }
}

const noRuntime = (name: string) =>
  out(name, { error: "collection runtime unavailable in this host (read-only / autonomous mode)" })

/** Gate every active discovery/recon tool on a usable runtime AND a defined scope.
 *  Returns an error ToolOutput to short-circuit, or null to proceed. Deny-by-default:
 *  with no in-scope host, egress is refused — the operator must authorize targets first. */
function scopeGate(ctx: HandlerCtx, name: string): ToolOutput | null {
  if (!ctx.collect) return noRuntime(name)
  if (ctx.collect.scope.rules.hosts.length === 0)
    return out(name, {
      error:
        "No scope defined for this engagement. Add in-scope host(s) in the desktop Web → Overview → Scope panel (e.g. acme.test, *.acme.test) before running discovery or recon tools.",
    })
  return null
}

export const COLLECT_TOOLS: ToolSpec[] = [
  defineTool({
    name: "web_crawl",
    description:
      "Crawl in-scope, server-rendered pages from the given seeds, folding discovered pages and forms (with params) into the attack-surface graph. Deduped, scope-gated, budget-bounded. Makes network requests — not read-only.",
    readOnly: false,
    args: {
      seeds: z.array(z.string().url()).min(1),
      max_pages: z.number().int().positive().max(2000).optional(),
      max_depth: z.number().int().min(0).max(10).optional(),
    },
    async handler(args, ctx) {
      const gate = scopeGate(ctx, "web_crawl")
      if (gate) return gate
      let emitted = 0
      const res = await crawlerCollector.run(collectorCtx(ctx, () => emitted++), {
        seeds: args.seeds,
        maxPages: args.max_pages,
        maxDepth: args.max_depth,
      })
      return out("web_crawl", { emitted: res.emitted, truncated: res.truncated })
    },
  }),
  defineTool({
    name: "web_analyze_js",
    description:
      "Fetch and statically analyze script assets for hidden endpoints and secret references (fingerprints only — never raw values), folding them into the graph. Not read-only.",
    readOnly: false,
    args: { urls: z.array(z.string().url()).min(1), base_url: z.string().url().optional() },
    async handler(args, ctx) {
      const gate = scopeGate(ctx, "web_analyze_js")
      if (gate) return gate
      let emitted = 0
      const res = await jsAnalyzerCollector.run(collectorCtx(ctx, () => emitted++), {
        urls: args.urls,
        baseUrl: args.base_url,
      })
      return out("web_analyze_js", { scripts: res.emitted, truncated: res.truncated })
    },
  }),
  defineTool({
    name: "web_discover_content",
    description:
      "Probe a wordlist of paths under a base URL with soft-404 calibration, folding real hits into the graph as endpoints. Not read-only.",
    readOnly: false,
    args: {
      base_url: z.string().url(),
      wordlist: z.array(z.string()).min(1),
      extensions: z.array(z.string()).optional(),
    },
    async handler(args, ctx) {
      const gate = scopeGate(ctx, "web_discover_content")
      if (gate) return gate
      let emitted = 0
      const res = await contentDiscoveryCollector.run(collectorCtx(ctx, () => emitted++), {
        baseUrl: args.base_url,
        wordlist: args.wordlist,
        extensions: args.extensions,
      })
      return out("web_discover_content", { found: res.emitted, truncated: res.truncated })
    },
  }),
  defineTool({
    name: "web_mine_params",
    description:
      "Probe candidate query params against an endpoint; report those that influence the response (reflected canary or length delta), folding them onto the endpoint. Reflected params are XSS/injection candidates. Not read-only.",
    readOnly: false,
    args: { url: z.string().url(), params: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const gate = scopeGate(ctx, "web_mine_params")
      if (gate) return gate
      let emitted = 0
      const res = await paramMinerCollector.run(collectorCtx(ctx, () => emitted++), { url: args.url, params: args.params })
      return out("web_mine_params", { found: res.emitted, truncated: res.truncated })
    },
  }),
  defineTool({
    name: "recon_takeover_check",
    description:
      "Probe hosts for known unclaimed-service (subdomain-takeover) signatures, folding candidates into the graph as critical hosts. Not read-only.",
    readOnly: false,
    args: { hosts: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const gate = scopeGate(ctx, "recon_takeover_check")
      if (gate) return gate
      let emitted = 0
      const res = await subdomainTakeoverCollector.run(collectorCtx(ctx, () => emitted++), { hosts: args.hosts })
      return out("recon_takeover_check", { candidates: res.emitted, truncated: res.truncated })
    },
  }),
  defineTool({
    name: "web_import_schema",
    description:
      "Import an OpenAPI/Swagger doc or a GraphQL introspection result (fetched scope-gated) and fold every operation into the graph as an endpoint — surfacing non-UI API surface (BOLA/BFLA). Not read-only.",
    readOnly: false,
    args: { url: z.string().url(), graphql_url: z.string().url().optional() },
    async handler(args, ctx) {
      const gate = scopeGate(ctx, "web_import_schema")
      if (gate) return gate
      let emitted = 0
      const res = await apiSchemaCollector.run(collectorCtx(ctx, () => emitted++), {
        url: args.url,
        graphqlUrl: args.graphql_url,
      })
      return out("web_import_schema", { operations: res.emitted })
    },
  }),
]
