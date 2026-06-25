import { RISK_ORDER, type Graph, type RiskLevel } from "@morgana/web-core/graph"
import type { WebTree } from "../graph-model"

// ── Overlays ──────────────────────────────────────────────────────────────────
// Composable re-styling that stacks on ANY terrain without changing its topology —
// the map "traffic layer" analog. They touch color only, never positions.

const RISK_COLOR: Record<RiskLevel, string | null> = {
  critical: "#dc2626",
  high: "#e11d48",
  medium: "#d97706",
  low: "#2563eb",
  none: null,
}

/** Recolor leaf nodes by their SPG risk. Matches by node id, then falls back to url
 *  (the Attack Surface lens uses its own ids but every leaf carries a url). Mutates
 *  the freshly-projected tree in place and returns it. */
export function applyRiskHeat(tree: WebTree, spg: Graph): WebTree {
  const byId = new Map<string, RiskLevel>()
  const byUrl = new Map<string, RiskLevel>()
  for (const n of spg.nodes.values()) {
    byId.set(n.id, n.risk)
    if (n.url) {
      const prev = byUrl.get(n.url)
      if (!prev || RISK_ORDER[n.risk] > RISK_ORDER[prev]) byUrl.set(n.url, n.risk)
    }
  }
  for (const node of tree.nodes) {
    if (node.kind !== "leaf") continue
    const risk = byId.get(node.id) ?? (node.url ? byUrl.get(node.url) : undefined)
    const color = risk ? RISK_COLOR[risk] : null
    if (color) node.color = color
  }
  return tree
}
