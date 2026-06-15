import { createContext, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"

// A session-level "rail" that tools can portal full-height content into so it
// escapes the vertical squeeze of the docked terminal. The graph tool's node
// inspector uses this to stay pinned full-height beside the [tools + terminal]
// stack, exactly like the chat panel is exempt from the terminal push-up.
//
// Used with a tolerant default so tools rendered outside a session (the
// full-page /gaze/:view route, which has no rail) fall back to inline rendering
// instead of crashing.

export type WorkspaceDock = {
  rail: Accessor<HTMLElement | undefined>
  setRail: (el: HTMLElement | undefined) => void
  // Whether a tool currently has content docked in the rail. The rail collapses to
  // zero width (and drops its flex gap) when nothing is docked, so an empty rail
  // never adds dead space between the workspace and the chat.
  active: Accessor<boolean>
  setActive: (value: boolean) => void
}

const noopDock: WorkspaceDock = {
  rail: () => undefined,
  setRail: () => {},
  active: () => false,
  setActive: () => {},
}

const ctx = createContext<WorkspaceDock>(noopDock)

export function WorkspaceDockProvider(props: ParentProps) {
  const [rail, setRail] = createSignal<HTMLElement | undefined>()
  const [active, setActive] = createSignal(false)
  return <ctx.Provider value={{ rail, setRail, active, setActive }}>{props.children}</ctx.Provider>
}

export function useWorkspaceDock() {
  return useContext(ctx)
}
