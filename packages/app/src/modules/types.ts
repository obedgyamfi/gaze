import type { Component } from "solid-js"
import type { IconProps } from "@opencode-ai/ui/icon"

export interface ToolView {
  id: string
  label: string
  icon: IconProps["name"]
  component?: () => Promise<{ default: Component }>
}

// Mirrors the future morgana.plugin.json manifest. Today modules are
// statically bundled; later this shape is hydrated from installed plugins.
// Planned manifest contributions: mcp (server command), skills (methodology),
// scope schema, finding classes/locations, report template.
export interface SecurityModule {
  id: string
  label: string
  icon: IconProps["name"]
  tools: ToolView[]
}
