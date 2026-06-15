import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"

import { SortableTerminalTab } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout, type TerminalMode } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { createSizing, focusTerminalById } from "@/pages/session/helpers"
import { getTerminalHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

// How the terminal is docked in the workspace. "bottom"/"under" are height-based
// (resize handle on top, or on the bottom for "chat" so it sits above the docked
// chat); "split" is a width-based column (handle on the right); "max" fills its
// container with no handle. The terminal body is identical across docks — only the
// container chrome differs — so switching docks just re-creates the xterm, which
// safely restores from its serialized buffer.
export type TerminalDock = "bottom" | "under" | "split" | "chat" | "max"

const MODE_ORDER: TerminalMode[] = ["under", "split", "chat"]

export function TerminalPanel(props: { dock?: TerminalDock }) {
  const delays = [120, 240]
  const layout = useLayout()
  const terminal = useTerminal()
  const language = useLanguage()
  const command = useCommand()
  const { params, workspaceKey, view } = useSessionLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const dock = createMemo<TerminalDock>(() => props.dock ?? "bottom")
  const isWidth = createMemo(() => dock() === "split")
  const isMax = createMemo(() => dock() === "max")
  // Split column resizes from its left edge (the tools↔terminal divider) so it
  // never collides with the chat's own left-edge handle on the terminal↔chat
  // divider. "chat" dock resizes from the bottom; bottom/under from the top.
  const handleEdge = createMemo<"start" | "end">(() => (dock() === "chat" ? "end" : "start"))

  const opened = createMemo(() => view().terminal.opened())
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const width = createMemo(() => layout.terminal.width())
  const close = () => view().terminal.close()
  let root: HTMLDivElement | undefined

  const [store, setStore] = createStore({
    autoCreated: false,
    activeDraggable: undefined as string | undefined,
    recovered: {} as Record<string, boolean>,
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
    viewW: typeof window === "undefined" ? 1400 : window.innerWidth,
  })

  const maxH = () => store.view * 0.6
  const maxW = () => store.viewW * 0.6
  // Natural size along the dock's resize axis (height for bottom/under/chat, width for split).
  const pane = () => (isWidth() ? Math.min(width(), maxW()) : Math.min(height(), maxH()))

  const cycleMode = () => {
    const current = layout.terminal.mode()
    const next = MODE_ORDER[(MODE_ORDER.indexOf(current) + 1) % MODE_ORDER.length] ?? "under"
    layout.terminal.setMode(next)
  }
  const modeIcon = createMemo(() => {
    const mode = layout.terminal.mode()
    return mode === "split" ? "layout-right" : mode === "chat" ? "layout-right-partial" : "layout-bottom"
  })
  const modeLabel = createMemo(() => {
    const mode = layout.terminal.mode()
    if (mode === "split") return "Terminal layout: side column"
    if (mode === "chat") return "Terminal layout: above chat"
    return "Terminal layout: docked below"
  })
  const maximized = createMemo(() => layout.terminal.maximized())

  onMount(() => {
    if (typeof window === "undefined") return

    const sync = () => setStore({ view: window.visualViewport?.height ?? window.innerHeight, viewW: window.innerWidth })
    const port = window.visualViewport

    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  createEffect(() => {
    if (!opened()) {
      setStore("autoCreated", false)
      return
    }

    if (!terminal.ready() || terminal.all().length !== 0 || store.autoCreated) return
    terminal.new()
    setStore("autoCreated", true)
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount === undefined || prevCount <= 0 || count !== 0) return
        if (!opened()) return
        close()
      },
    ),
  )

  const focus = (id: string) => {
    focusTerminalById(id)

    const frame = requestAnimationFrame(() => {
      if (!opened()) return
      if (terminal.active() !== id) return
      focusTerminalById(id)
    })

    const timers = delays.map((ms) =>
      window.setTimeout(() => {
        if (!opened()) return
        if (terminal.active() !== id) return
        focusTerminalById(id)
      }, ms),
    )

    return () => {
      cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
    }
  }

  createEffect(
    on(
      () => [opened(), terminal.active()] as const,
      ([next, id]) => {
        if (!next || !id) return
        const stop = focus(id)
        onCleanup(stop)
      },
    ),
  )

  createEffect(() => {
    if (opened()) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    if (!root?.contains(active)) return
    active.blur()
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (!terminal.ready()) return
    language.locale()

    setTerminalHandoff(
      workspaceKey(),
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  const handoff = createMemo(() => {
    const dir = params.dir
    if (!dir) return []
    return getTerminalHandoff(workspaceKey()) ?? []
  })

  const all = terminal.all
  const ids = createMemo(() => all().map((pty) => pty.id))

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key]) return
    setStore("recovered", key, true)
    void clone(id)
  }

  const terminalRecoveryKey = (pty: { id: string; title: string; titleNumber: number }) => {
    return String(pty.titleNumber || pty.title || pty.id)
  }

  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    trim(id)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const terminals = terminal.all()
    const fromIndex = terminals.findIndex((t) => t.id === draggable.id.toString())
    const toIndex = terminals.findIndex((t) => t.id === droppable.id.toString())
    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      terminal.move(draggable.id.toString(), toIndex)
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeDraggable", undefined)

    const activeId = terminal.active()
    if (!activeId) return
    requestAnimationFrame(() => {
      if (terminal.active() !== activeId) return
      focusTerminalById(activeId)
    })
  }

  return (
    <div
      ref={root}
      id="terminal-panel"
      role="region"
      aria-label={language.t("terminal.title")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative shrink-0 overflow-hidden bg-background-stronger"
      classList={{
        "size-full": isMax(),
        "w-full": !isMax() && !isWidth(),
        "h-full": !isMax() && isWidth(),
        "border-t border-border-weak-base": opened() && (dock() === "bottom" || dock() === "under"),
        "border-b border-border-weak-base": opened() && dock() === "chat",
        "border-x border-border-weak-base": opened() && isWidth(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active() && !isWidth() && !isMax(),
        "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
          !size.active() && isWidth() && !isMax(),
      }}
      style={
        isMax()
          ? {}
          : isWidth()
            ? { width: opened() ? `${pane()}px` : "0px" }
            : { height: opened() ? `${pane()}px` : "0px" }
      }
    >
      <div
        class="absolute flex flex-col"
        classList={{
          "inset-0": isMax(),
          "inset-x-0 top-0": !isMax() && !isWidth(),
          "inset-y-0 left-0": !isMax() && isWidth(),
          "pointer-events-none": !opened(),
        }}
        style={isMax() ? {} : isWidth() ? { width: `${pane()}px` } : { height: `${pane()}px` }}
      >
        <Show when={!isMax()}>
          <div class="hidden md:block" onPointerDown={() => size.start()}>
            <ResizeHandle
              direction={isWidth() ? "horizontal" : "vertical"}
              edge={handleEdge()}
              size={pane()}
              min={isWidth() ? 240 : 100}
              max={isWidth() ? maxW() : maxH()}
              collapseThreshold={isWidth() ? 120 : 50}
              onResize={(next) => {
                size.touch()
                if (isWidth()) layout.terminal.resizeWidth(next)
                else layout.terminal.resize(next)
              }}
              onCollapse={close}
            />
          </div>
        </Show>
        <Show
          when={terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weaker-base bg-background-stronger overflow-hidden">
                <For each={handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">{language.t("terminal.loading")}</div>
            </div>
          }
        >
          <DragDropProvider
            onDragStart={handleTerminalDragStart}
            onDragEnd={handleTerminalDragEnd}
            onDragOver={handleTerminalDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <div class="flex flex-col h-full">
              <Tabs
                variant="alt"
                value={terminal.active()}
                onChange={(id) => terminal.open(id)}
                class="!h-auto !flex-none"
              >
                <Tabs.List class="h-10 border-b border-border-weaker-base">
                  <SortableProvider ids={ids()}>
                    <For each={all()}>{(pty) => <SortableTerminalTab terminal={pty} onClose={close} />}</For>
                  </SortableProvider>
                  <div class="h-full flex items-center justify-center">
                    <TooltipKeybind
                      title={language.t("command.terminal.new")}
                      keybind={command.keybind("terminal.new")}
                      class="flex items-center"
                    >
                      <IconButton
                        icon="plus-small"
                        variant="ghost"
                        iconSize="large"
                        onClick={terminal.new}
                        aria-label={language.t("command.terminal.new")}
                      />
                    </TooltipKeybind>
                  </div>
                  <Show when={isDesktop()}>
                    <div class="ml-auto h-full flex items-center justify-center gap-0.5 pr-1">
                      <Show when={!maximized()}>
                        <Tooltip placement="bottom" value={modeLabel()}>
                          <IconButton icon={modeIcon()} variant="ghost" onClick={cycleMode} aria-label={modeLabel()} />
                        </Tooltip>
                      </Show>
                      <Tooltip placement="bottom" value={maximized() ? "Restore terminal" : "Maximize terminal"}>
                        <IconButton
                          icon={maximized() ? "collapse" : "expand"}
                          variant="ghost"
                          onClick={() => layout.terminal.toggleMaximize()}
                          aria-label={maximized() ? "Restore terminal" : "Maximize terminal"}
                          aria-pressed={maximized()}
                        />
                      </Tooltip>
                    </div>
                  </Show>
                </Tabs.List>
              </Tabs>
              <div class="flex-1 min-h-0 relative">
                <Show when={terminal.active()} keyed>
                  {(id) => {
                    const ops = terminal.bind()
                    return (
                      <Show when={all().find((pty) => pty.id === id)}>
                        {(pty) => (
                          <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                            <Terminal
                              pty={pty()}
                              autoFocus={opened()}
                              onConnect={() => markTerminalConnected(terminalRecoveryKey(pty()), id, ops.trim)}
                              onCleanup={ops.update}
                              onConnectError={() => recoverTerminal(terminalRecoveryKey(pty()), id, ops.clone)}
                            />
                          </div>
                        )}
                      </Show>
                    )
                  }}
                </Show>
              </div>
            </div>
            <DragOverlay>
              <Show when={store.activeDraggable} keyed>
                {(id) => (
                  <Show when={all().find((pty) => pty.id === id)}>
                    {(t) => (
                      <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
                        {terminalTabLabel({
                          title: t().title,
                          titleNumber: t().titleNumber,
                          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
                        })}
                      </div>
                    )}
                  </Show>
                )}
              </Show>
            </DragOverlay>
          </DragDropProvider>
        </Show>
      </div>
    </div>
  )
}
