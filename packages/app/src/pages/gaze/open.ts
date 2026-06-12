import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { gazeTab } from "./tab"

// Opens a gaze view in the right place: as a workspace tab next to the chat
// when a session/workspace route is active, or as a full page otherwise.
export function useGazeViews() {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const layout = useLayout()
  const server = useServer()

  const key = () => {
    if (!params.dir) return undefined
    return SessionStateKey.from(server.scope(), SessionRouteKey.fromRoute(params.dir, params.id))
  }

  const open = (viewId: string) => {
    const sessionKey = key()
    if (!sessionKey) {
      navigate(`/gaze/${viewId}`)
      return
    }
    void layout.tabs(() => sessionKey).open(gazeTab(viewId))
  }

  const active = (viewId: string) => {
    const sessionKey = key()
    if (!sessionKey) return location.pathname === `/gaze/${viewId}`
    return layout.tabs(() => sessionKey).active() === gazeTab(viewId)
  }

  return { open, active }
}
