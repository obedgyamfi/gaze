import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"

export const useSessionKey = () => {
  const params = useParams()
  const server = useServer()
  const scope = createMemo(() => server.scope())
  const workspaceKey = createMemo(() => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir)))
  const sessionKey = createMemo(() => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir, params.id)))
  return { params, sessionKey, workspaceKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey, workspaceKey } = useSessionKey()
  return {
    params,
    sessionKey,
    workspaceKey,
    // Tool/file tabs are scoped to the workspace (the project dir), not the
    // individual chat session, so the same Graph/Proxy/Repeater layout is shared
    // across every session in the workspace — a new session only swaps the chat.
    tabs: createMemo(() => layout.tabs(workspaceKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
