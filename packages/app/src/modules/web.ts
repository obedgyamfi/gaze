import type { SecurityModule } from "./types"

export const webModule: SecurityModule = {
  id: "web",
  label: "Web",
  icon: "window-cursor",
  tools: [
    { id: "web-overview", label: "Overview", icon: "window-cursor", component: () => import("@/pages/gaze/web/overview") },
    { id: "graph", label: "Graph", icon: "fork", component: () => import("@/pages/gaze/web/graph") },
    { id: "proxy", label: "Proxy", icon: "server", component: () => import("@/pages/gaze/web/proxy") },
    { id: "repeater", label: "Repeater", icon: "reset", component: () => import("@/pages/gaze/web/repeater") },
    { id: "interceptor", label: "Interceptor", icon: "shield" },
  ],
}
