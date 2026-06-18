// ── Knowledge surface — methodology retrieval + candidate seeding ─────────────
// Queries the methodology KB (not the attack graph). web_kb_candidates bridges
// KB + the live graph: deterministic hypotheses to test, never confirmed findings.

import { z } from "zod"
import { NODE_KINDS, defineTool, out, type ToolSpec } from "./tools.js"

const VULN_CLASSES = ["auth", "idor", "access-control", "injection", "xss", "cors", "ssrf", "info-leak", "csrf"] as const

export const KNOWLEDGE_TOOLS: ToolSpec[] = [
  defineTool({
    name: "web_kb_query",
    description: "Retrieve methodology (WSTG-style procedures: steps, what to look for, refs) for a vuln class / node kind / free-text query. Read-only.",
    readOnly: true,
    args: {
      vuln_class: z.enum(VULN_CLASSES).optional(),
      node_kind: z.enum(NODE_KINDS).optional(),
      q: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async handler(args, ctx) {
      return out("kb query", { procedures: ctx.kb.query({ vulnClass: args.vuln_class, nodeKind: args.node_kind, q: args.q, tags: args.tags }) })
    },
  }),

  defineTool({
    name: "web_kb_candidates",
    description:
      "Deterministic candidate seeding: given node ids, return which vuln classes to test HERE and WHY (with confidence + methodology ref). Hypotheses to test, never confirmed. The planner's grounding.",
    readOnly: true,
    args: { node_ids: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const detail = await ctx.store.nodes({ ids: args.node_ids })
      const candidates = detail.nodes.map((n) => ({
        node_id: n.id,
        candidates: ctx.kb.candidatesFor({ kind: n.kind, tags: n.tags, method: n.method, url: n.url, risk: n.risk }),
      }))
      return out("kb candidates", { candidates })
    },
  }),

  defineTool({
    name: "web_kb_payloads",
    description: "Fetch abstract, parameterized payload/exploit templates for a vuln class (authorized testing only). The replay engine instantiates within ROE. Read-only.",
    readOnly: true,
    args: { vuln_class: z.enum(VULN_CLASSES) },
    async handler(args, ctx) {
      return out("kb payloads", { templates: ctx.kb.payloads(args.vuln_class) })
    },
  }),
]
