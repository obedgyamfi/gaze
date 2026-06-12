import type { SecurityModule } from "./types"

export const webModule: SecurityModule = {
  id: "web",
  label: "Web",
  icon: "window-cursor",
  tools: [
    { id: "graph", label: "Graph", icon: "fork" },
    { id: "proxy", label: "Proxy", icon: "server" },
    { id: "repeater", label: "Repeater", icon: "reset" },
    { id: "interceptor", label: "Interceptor", icon: "shield" },
  ],
}
