import type { ToolView } from "./types"

// Core views exist regardless of installed modules. Engagements are
// represented by Projects (engagement ≈ opencode project).
export const CORE_VIEWS: ToolView[] = [
  { id: "projects", label: "Projects", icon: "folder", component: () => import("@/pages/gaze/projects") },
  { id: "findings", label: "Findings", icon: "warning", component: () => import("@/pages/gaze/findings") },
  { id: "reports", label: "Reports", icon: "checklist", component: () => import("@/pages/gaze/reports") },
  { id: "notes", label: "Notes", icon: "pencil-line", component: () => import("@/pages/gaze/notes") },
]
