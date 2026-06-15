import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { gazeTab } from "./tab"

// Opens a gaze view in the right place: as a workspace tab next to the chat when a
// session/workspace route is active, or as a full page otherwise. Tabs are keyed by
// the workspace (project dir) — not the session — so tools are shared across every
// chat session in the workspace and persist via the layout store.
export function useGazeViews() {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const layout = useLayout()
  const server = useServer()

  const key = () => {
    if (!params.dir) return undefined
    return SessionStateKey.from(server.scope(), SessionRouteKey.fromRoute(params.dir))
  }

  const open = (viewId: string) => {
    const workspaceKey = key()
    if (!workspaceKey) {
      navigate(`/gaze/${viewId}`)
      return
    }
    void layout.tabs(() => workspaceKey).open(gazeTab(viewId))
  }

  const active = (viewId: string) => {
    const workspaceKey = key()
    if (!workspaceKey) return location.pathname === `/gaze/${viewId}`
    return layout.tabs(() => workspaceKey).active() === gazeTab(viewId)
  }

  return { open, active }
}
