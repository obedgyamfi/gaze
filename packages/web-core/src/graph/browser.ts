// ── Browser-safe entry (@morgana/web-core/graph) ──────────────────────────────
// The desktop RENDERER imports from here. It exposes ONLY the pure graph builders
// + types — no node:crypto, no Buffer, no store / tool / oracle code. That keeps
// the Node-only agent surface (the package index) out of the browser bundle, which
// is what `vite` was choking on (node:crypto externalized for the browser).

export { buildEnrichedGraph, resolveCaptureNode, nodeId, edgeId, type ResolvedNode } from "./enriched.js"
export { enrichTaint, type TaintObservation } from "./taint.js"
export { buildBaseGraph, categoryOf } from "./base.js"
export { hashHex } from "./hash.js"
// KB is pure (no node deps) — the renderer queries methodology/refs per vuln class.
export { createSeedKnowledgeBase, type KnowledgeBase, type KbProcedure } from "../kb.js"
// Canvas model is pure (no node deps) — the renderer edits canvases locally with it.
export {
  createCanvasRecord,
  applyCanvasPatch,
  summarizeCanvas,
  emptyCanvas,
  type JsonCanvas,
  type CanvasNode,
  type CanvasTextNode,
  type CanvasEdge,
  type CanvasRecord,
  type CanvasSummary,
  type CanvasNodeInput,
  type CanvasEdgeInput,
  type CanvasPatch,
} from "../canvas.js"
export * from "../types.js"
export { headerMap } from "../capture-source.js"
export type {
  CaptureRecord,
  NavRecord,
  FormRecord,
  HeaderPair,
  BodyData,
  BodyMeta,
  CaptureSource,
} from "../capture-source.js"
