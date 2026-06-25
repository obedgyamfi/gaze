// @morgana/web-core — host-agnostic core for the Morgana web-security toolset.
// Adapters (@morgana/plugin-web, @morgana/mcp-web) consume these exports.

import { READ_TOOLS } from "./tools.js"
import { ACTION_TOOLS } from "./tools-action.js"
import { KNOWLEDGE_TOOLS } from "./tools-knowledge.js"
import { CANVAS_TOOLS } from "./tools-canvas.js"

export * from "./types.js"
export * from "./capture-source.js"
export { buildEnrichedGraph, resolveCaptureNode, nodeId, edgeId, type ResolvedNode } from "./graph/enriched.js"
export { enrichTaint, type TaintObservation } from "./graph/taint.js"
export { buildBaseGraph, categoryOf } from "./graph/base.js"
export { createEnrichedGraphStore, type GraphStore, type EvidenceResult, type CaptureBody } from "./store.js"
export { differential, type OracleRuling } from "./oracle.js"
export {
  stampEvidenceId,
  createInMemoryStores,
  type EvidenceStore,
  type FindingStore,
  type NoteStore,
  type CanvasStore,
  type Stores,
} from "./stores.js"
export {
  createCanvasRecord,
  applyCanvasPatch,
  summarizeCanvas,
  emptyCanvas,
  type JsonCanvas,
  type CanvasNode,
  type CanvasTextNode,
  type CanvasGroupNode,
  type CanvasEdge,
  type CanvasRecord,
  type CanvasSummary,
  type CanvasNodeInput,
  type CanvasEdgeInput,
  type CanvasPatch,
} from "./canvas.js"
export {
  createSeedKnowledgeBase,
  type KnowledgeBase,
  type KbProcedure,
  type KbCandidate,
  type KbPayloadTemplate,
  type KbNode,
} from "./kb.js"
export {
  READ_TOOLS,
  defineTool,
  out,
  type ToolSpec,
  type HandlerCtx,
  type ToolOutput,
  type FireRequest,
  type FireResult,
} from "./tools.js"
export { ACTION_TOOLS } from "./tools-action.js"
export { KNOWLEDGE_TOOLS } from "./tools-knowledge.js"
export { CANVAS_TOOLS } from "./tools-canvas.js"
export { createFetchFire } from "./fire.js"

/** The full tool surface: read + action + knowledge + canvas. Adapters bind this. */
export const ALL_TOOLS = [...READ_TOOLS, ...ACTION_TOOLS, ...KNOWLEDGE_TOOLS, ...CANVAS_TOOLS]
