// ── Canvas surface — author/curate flowchart-style views over the SPG ─────────
// The LLM reads the SPG via web_graph_* / web_kb_* and then composes a COHERENT,
// human-readable canvas here: rectangular text cards + labeled edges (JSONCanvas).
// Persisted per workspace, editable by the agent AND a human in the desktop. Use
// these to explain an attack chain, map an auth flow, or build a report figure —
// not to replace the SPG (the machine truth), but to narrate it.

import { z } from "zod"
import { applyCanvasPatch, createCanvasRecord, summarizeCanvas, type CanvasEdgeInput, type CanvasNodeInput } from "./canvas.js"
import { defineTool, out, type ToolSpec } from "./tools.js"

const side = z.enum(["top", "right", "bottom", "left"])
const nodeArg = z.object({
  id: z.string().describe("Author-chosen unique id (referenced by edges)."),
  text: z.string().describe("Card content (markdown)."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  color: z.string().optional().describe("JSONCanvas preset '1'..'6' or '#RRGGBB'."),
  ref: z.string().optional().describe("Optional SPG node id this card represents."),
})
const edgeArg = z.object({
  id: z.string().optional(),
  from_node: z.string(),
  to_node: z.string(),
  from_side: side.optional(),
  to_side: side.optional(),
  label: z.string().optional(),
  color: z.string().optional(),
})

type NodeArg = z.infer<typeof nodeArg>
type EdgeArg = z.infer<typeof edgeArg>
const toNode = (n: NodeArg): CanvasNodeInput => ({ id: n.id, text: n.text, x: n.x, y: n.y, width: n.width, height: n.height, color: n.color, ref: n.ref })
const toEdge = (e: EdgeArg): CanvasEdgeInput => ({ id: e.id, fromNode: e.from_node, toNode: e.to_node, fromSide: e.from_side, toSide: e.to_side, label: e.label, color: e.color })

export const CANVAS_TOOLS: ToolSpec[] = [
  defineTool({
    name: "web_canvas_list",
    description: "List the curated canvases in this workspace (id, title, purpose, node/edge counts, updatedAt). Cheap — call to see what already exists before creating another. Read-only.",
    readOnly: true,
    args: {},
    async handler(_args, ctx) {
      return out("canvas list", { canvases: ctx.canvases.list() })
    },
  }),

  defineTool({
    name: "web_canvas_read",
    description: "Read one canvas in full (the JSONCanvas: nodes + edges). Use before editing so you patch against the current state. Read-only.",
    readOnly: true,
    args: { id: z.string() },
    async handler(args, ctx) {
      const rec = ctx.canvases.get(args.id)
      if (!rec) return out("canvas read", { error: `no canvas '${args.id}'; list ids via web_canvas_list` })
      return out("canvas read", rec)
    },
  }),

  defineTool({
    name: "web_canvas_create",
    description:
      "Create a curated, flowchart-style canvas (Obsidian JSONCanvas). Provide text cards (each with your own unique id) + labeled edges between them; omit x/y to auto-grid. Read the SPG first (web_graph_*) and lay out a coherent structure — an attack chain, auth-flow map, or report figure. Returns the new canvas id. Persisted + human-editable.",
    readOnly: false,
    args: {
      title: z.string(),
      purpose: z.string().optional().describe("What this canvas is for (e.g. 'IDOR chain on /api/orders')."),
      nodes: z.array(nodeArg).optional(),
      edges: z.array(edgeArg).optional(),
    },
    async handler(args, ctx) {
      const rec = createCanvasRecord({ title: args.title, purpose: args.purpose, nodes: args.nodes?.map(toNode), edges: args.edges?.map(toEdge) })
      ctx.canvases.put(rec)
      return out("canvas create", { id: rec.id, summary: summarizeCanvas(rec) })
    },
  }),

  defineTool({
    name: "web_canvas_edit",
    description:
      "Patch an existing canvas incrementally: add/update/remove text cards and add/remove edges, or rename title/purpose. Edges referencing missing nodes are dropped. Returns the updated summary. (Human edits in the desktop persist to the same canvas.)",
    readOnly: false,
    args: {
      id: z.string(),
      title: z.string().optional(),
      purpose: z.string().optional(),
      add_nodes: z.array(nodeArg).optional(),
      update_nodes: z.array(nodeArg.partial().extend({ id: z.string() })).optional(),
      remove_nodes: z.array(z.string()).optional(),
      add_edges: z.array(edgeArg).optional(),
      remove_edges: z.array(z.string()).optional(),
    },
    async handler(args, ctx) {
      const rec = ctx.canvases.get(args.id)
      if (!rec) return out("canvas edit", { error: `no canvas '${args.id}'; list ids via web_canvas_list` })
      const updated = applyCanvasPatch(rec, {
        title: args.title,
        purpose: args.purpose,
        addNodes: args.add_nodes?.map(toNode),
        updateNodes: args.update_nodes?.map((n) => ({ id: n.id, text: n.text, x: n.x, y: n.y, width: n.width, height: n.height, color: n.color, ref: n.ref })),
        removeNodes: args.remove_nodes,
        addEdges: args.add_edges?.map(toEdge),
        removeEdges: args.remove_edges,
      })
      ctx.canvases.put(updated)
      return out("canvas edit", { id: updated.id, summary: summarizeCanvas(updated) })
    },
  }),

  defineTool({
    name: "web_canvas_delete",
    description: "Delete a canvas by id. Irreversible. The SPG and findings are unaffected.",
    readOnly: false,
    args: { id: z.string() },
    async handler(args, ctx) {
      ctx.canvases.remove(args.id)
      return out("canvas delete", { id: args.id, deleted: true })
    },
  }),
]
