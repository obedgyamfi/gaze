import { CORE_VIEWS } from "./core"
import { webModule } from "./web"
import type { SecurityModule, ToolView } from "./types"

export type { SecurityModule, ToolView } from "./types"
export { CORE_VIEWS } from "./core"

const MODULES: SecurityModule[] = [webModule]

// Later: filter by the active engagement's enabled plugins and include
// manifest-loaded modules. Today every bundled module is enabled.
export function enabledModules(): SecurityModule[] {
  return MODULES
}

export function allViews(): ToolView[] {
  return [...CORE_VIEWS, ...MODULES.flatMap((module) => module.tools)]
}

export function findView(id: string): ToolView | undefined {
  return allViews().find((view) => view.id === id)
}
