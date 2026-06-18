// @morgana/web-core — host-agnostic core for the Morgana web-security toolset.
// Adapters (@morgana/plugin-web, @morgana/mcp-web) consume these exports.

import { READ_TOOLS } from "./tools.js"
import { ACTION_TOOLS } from "./tools-action.js"
import { KNOWLEDGE_TOOLS } from "./tools-knowledge.js"

export * from "./types.js"
export * from "./capture-source.js"
export { buildEnrichedGraph } from "./graph/enriched.js"
export { buildBaseGraph, categoryOf } from "./graph/base.js"
export { createEnrichedGraphStore, type GraphStore, type EvidenceResult, type CaptureBody } from "./store.js"
export { differential, type OracleRuling } from "./oracle.js"
export {
  stampEvidenceId,
  createInMemoryStores,
  type EvidenceStore,
  type FindingStore,
  type NoteStore,
  type Stores,
} from "./stores.js"
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
export { createFetchFire } from "./fire.js"

/** The full tool surface: read + action + knowledge. Adapters bind this. */
export const ALL_TOOLS = [...READ_TOOLS, ...ACTION_TOOLS, ...KNOWLEDGE_TOOLS]
