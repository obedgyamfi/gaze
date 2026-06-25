import { buildTree } from "../graph-model"
import type { Lens } from "./types"

// The original tidy attack-surface tree, now one terrain among many. Builds the
// path-directory hierarchy from capture URLs (directories are display scaffolding,
// not SPG entities) — so this lens owns its own tree, independent of the SPG.

export const attackSurfaceLens: Lens = {
  id: "attack-surface",
  label: "Attack Surface",
  icon: "file-tree",
  blurb: "Domain → path → leaf. What the browser loaded.",
  project: (ctx) =>
    buildTree({ captures: ctx.captures, navs: ctx.navs, forms: ctx.forms, filters: ctx.filters, collapsed: ctx.collapsed }),
}
