import type { SecurityModule } from "./types"

export const webModule: SecurityModule = {
  id: "web",
  label: "Web",
  icon: "window-cursor",
  tools: [
    { id: "web-overview", label: "Overview", icon: "window-cursor", component: () => import("@/pages/gaze/web/overview") },
    { id: "graph", label: "Graph", icon: "fork" },
    { id: "proxy", label: "Proxy", icon: "server" },
    { id: "repeater", label: "Repeater", icon: "reset" },
    { id: "interceptor", label: "Interceptor", icon: "shield" },
  ],
}
