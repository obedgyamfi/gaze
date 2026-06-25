import type { SecurityModule } from "./types"

export const webModule: SecurityModule = {
  id: "web",
  label: "Web",
  icon: "window-cursor",
  tools: [
    { id: "web-overview", label: "Overview", icon: "window-cursor", component: () => import("@/pages/gaze/web/overview") },
    { id: "graph", label: "Graph", icon: "fork", component: () => import("@/pages/gaze/web/graph") },
    { id: "canvas", label: "Canvas", icon: "dot-grid", component: () => import("@/pages/gaze/web/canvas") },
    { id: "proxy", label: "Proxy", icon: "server", component: () => import("@/pages/gaze/web/proxy") },
    { id: "repeater", label: "Repeater", icon: "reset", component: () => import("@/pages/gaze/web/repeater") },
    { id: "findings", label: "Findings", icon: "shield", component: () => import("@/pages/gaze/web/findings") },
    { id: "interceptor", label: "Interceptor", icon: "shield" },
  ],
}
