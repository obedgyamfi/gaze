// ── Host-neutral tool specs ───────────────────────────────────────────────────
// The single definition of the read surface — name, description, Zod args, and a
// pure handler (args + ctx → ToolOutput). Both @morgana/plugin-web (opencode
// Hooks.tool) and @morgana/mcp-web (MCP server) bind THESE; neither redefines a
// tool. See gaze/docs/MCP_READ_SURFACE.md.

import { z } from "zod"
import type { CaptureSource } from "./capture-source.js"
import type { GraphStore } from "./store.js"
import type { EvidenceStore, FindingStore, NoteStore } from "./stores.js"
import type { KnowledgeBase } from "./kb.js"

/** A host-fired, scoped HTTP request (assisted mode). The host attaches the live
 *  session — by replaying a capture's real auth server-side when `replayCaptureId`
 *  is set — and returns observable signals only. The credential never reaches the
 *  model. Absent on `ctx` ⇒ the firing tools refuse (e.g. autonomous mode). */
export interface FireRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  replayCaptureId?: string
  substitutions?: { from: string; to: string }[]
  /** Canary to look for in the fired response (sets FireResult.marker if echoed). */
  marker?: string
}
export interface FireResult {
  captureId: string
  status: number
  ms: number
  bodyHash?: string
  marker?: string
}

export interface HandlerCtx {
  store: GraphStore
  captureSource: CaptureSource
  scopeHosts: string[]
  signal?: AbortSignal
  /** Host permission prompt for write-arming (action surface). Reads don't use it. */
  ask?: (req: { permission: string; reason: string }) => Promise<boolean>
  // ── action surface ──
  evidence: EvidenceStore
  findings: FindingStore
  notes: NoteStore
  kb: KnowledgeBase
  /** Host-fired scoped HTTP; absent ⇒ web_http_send / web_replay refuse. */
  fire?: (req: FireRequest) => Promise<FireResult>
}

export interface ToolOutput {
  title: string
  text: string
  data: Record<string, unknown>
}

export interface ToolSpec {
  name: string
  description: string
  args: z.ZodRawShape
  readOnly: boolean
  handler: (args: Record<string, unknown>, ctx: HandlerCtx) => Promise<ToolOutput>
}

export function defineTool<A extends z.ZodRawShape>(s: {
  name: string
  description: string
  args: A
  readOnly: boolean
  handler: (args: z.infer<z.ZodObject<A>>, ctx: HandlerCtx) => Promise<ToolOutput>
}): ToolSpec {
  return s as unknown as ToolSpec
}

export function out(title: string, data: unknown): ToolOutput {
  return { title, text: `**${title}**\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``, data: data as Record<string, unknown> }
}

export const NODE_KINDS = ["Domain", "Page", "Endpoint", "Resource", "Form", "Script", "ExternalService"] as const
export const EDGE_KINDS = ["NAVIGATES_TO", "CALLS", "LOADS", "SUBMITS_TO", "REDIRECTS_TO", "CROSS_ORIGIN_CALL", "HOSTS", "AUTHENTICATES_VIA", "LINKED_FROM"] as const
export const RISK = ["critical", "high", "medium", "low", "none"] as const

export const shared = {
  verbosity: z.enum(["compact", "full"]).optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
}

export const READ_TOOLS: ToolSpec[] = [
  defineTool({
    name: "web_graph_overview",
    description:
      "Orientation for the attack-surface graph: counts by kind/risk/host, top tags, and the highest-risk nodes. Cheap, ~constant size — call FIRST to orient before searching. Read-only.",
    readOnly: true,
    args: { root_node_ids: z.array(z.string()).optional(), hosts: z.array(z.string()).optional() },
    async handler(args, ctx) {
      return out("graph overview", await ctx.store.overview({ rootNodeIds: args.root_node_ids, hosts: args.hosts }))
    },
  }),
  defineTool({
    name: "web_graph_search",
    description: "Find nodes by filter, ranked (default risk desc). Server-side filtering + pagination. Read-only.",
    readOnly: true,
    args: {
      kinds: z.array(z.enum(NODE_KINDS)).optional(),
      risk_min: z.enum(RISK).optional(),
      tags: z.array(z.string()).optional(),
      hosts: z.array(z.string()).optional(),
      method: z.string().optional(),
      status_class: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]).optional(),
      q: z.string().optional(),
      sort: z.enum(["risk", "recency", "degree"]).optional(),
      ...shared,
    },
    async handler(args, ctx) {
      return out(
        "graph search",
        await ctx.store.search({
          kinds: args.kinds,
          riskMin: args.risk_min,
          tags: args.tags,
          hosts: args.hosts,
          method: args.method,
          statusClass: args.status_class,
          q: args.q,
          sort: args.sort,
          limit: args.limit,
          cursor: args.cursor,
        }),
      )
    },
  }),
  defineTool({
    name: "web_graph_neighbors",
    description: "Expand 1–2 hops around anchor node(s): neighbor nodes + connecting edges. Incremental traversal. Read-only.",
    readOnly: true,
    args: {
      node_ids: z.array(z.string()).min(1),
      hops: z.number().int().min(1).max(2).optional(),
      direction: z.enum(["in", "out", "both"]).optional(),
      edge_kinds: z.array(z.enum(EDGE_KINDS)).optional(),
      node_kinds: z.array(z.enum(NODE_KINDS)).optional(),
      ...shared,
    },
    async handler(args, ctx) {
      return out(
        "graph neighbors",
        await ctx.store.neighbors({
          nodeIds: args.node_ids,
          hops: args.hops,
          direction: args.direction,
          edgeKinds: args.edge_kinds,
          nodeKinds: args.node_kinds,
          limit: args.limit,
        }),
      )
    },
  }),
  defineTool({
    name: "web_graph_paths",
    description: "Attack-path: ordered route(s) between two nodes, or from a node to the nearest node matching a predicate. Read-only.",
    readOnly: true,
    args: {
      from_node_id: z.string(),
      to_node_id: z.string().optional(),
      to_predicate: z.object({ kinds: z.array(z.enum(NODE_KINDS)).optional(), tags: z.array(z.string()).optional(), risk_min: z.enum(RISK).optional() }).optional(),
      max_hops: z.number().int().positive().max(12).optional(),
      edge_kinds: z.array(z.enum(EDGE_KINDS)).optional(),
    },
    async handler(args, ctx) {
      return out(
        "graph paths",
        await ctx.store.paths({
          fromNodeId: args.from_node_id,
          toNodeId: args.to_node_id,
          toPredicate: args.to_predicate ? { kinds: args.to_predicate.kinds, tags: args.to_predicate.tags, riskMin: args.to_predicate.risk_min } : undefined,
          maxHops: args.max_hops,
          edgeKinds: args.edge_kinds,
        }),
      )
    },
  }),
  defineTool({
    name: "web_graph_node",
    description: "Full detail for one or more node ids: prose description, method/status, tags, recent capture ids, degree. Batched. Read-only.",
    readOnly: true,
    args: { ids: z.array(z.string()).min(1), ...shared },
    async handler(args, ctx) {
      return out("graph node", await ctx.store.nodes({ ids: args.ids, verbosity: args.verbosity }))
    },
  }),
  defineTool({
    name: "web_graph_evidence",
    description:
      "Captures as evidence. Default: summaries for a node/filter. Pass capture_id for one capture's metadata + secret-stripped headers; include_body to read a capped body slice. Read-only.",
    readOnly: true,
    args: {
      node_id: z.string().optional(),
      capture_ids: z.array(z.string()).optional(),
      capture_id: z.string().optional(),
      include_body: z.enum(["none", "head", "full"]).optional(),
      max_bytes: z.number().int().positive().optional(),
      ...shared,
    },
    async handler(args, ctx) {
      return out(
        "graph evidence",
        await ctx.store.evidence({
          nodeId: args.node_id,
          captureIds: args.capture_ids,
          captureId: args.capture_id,
          includeBody: args.include_body,
          maxBytes: args.max_bytes,
          limit: args.limit,
          cursor: args.cursor,
        }),
      )
    },
  }),
  defineTool({
    name: "web_graph_diff",
    description:
      "Deterministic differential between two captures (or a node's two most-recent): status/length deltas, body-hash equality, header diff. Reports signals; does NOT rule a verdict. Read-only.",
    readOnly: true,
    args: { capture_id_a: z.string().optional(), capture_id_b: z.string().optional(), node_id: z.string().optional() },
    async handler(args, ctx) {
      return out("graph diff", await ctx.store.diff({ captureIdA: args.capture_id_a, captureIdB: args.capture_id_b, nodeId: args.node_id }))
    },
  }),
]
