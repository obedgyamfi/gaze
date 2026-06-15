import { createMemo, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useWebCapture } from "@/context/web-capture"
import { useRepeater, type RepeaterTab } from "@/context/web-repeater"
import type { CaptureRecord } from "@/web/capture-types"
import { ResizableSplit } from "../http/resizable-split"
import { HttpMessagePane } from "../http/http-message-pane"

// Repeater — Burp-style: numbered request tabs, a Send/Target toolbar, and a
// Request | Response split. The request is an editable raw HTTP message; each
// send goes through the main process and is recorded into the proxy log.

export default function RepeaterView() {
  const repeater = useRepeater()
  const capture = useWebCapture()
  const active = createMemo(() => repeater.tabs().find((t) => t.id === repeater.activeId()) ?? repeater.tabs()[0])

  return (
    <div class="flex h-full w-full flex-col bg-background-base">
      {/* request tabs */}
      <div class="shrink-0 flex items-stretch h-8 border-b border-border-weak-base bg-background-stronger">
        <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto no-scrollbar">
          <For each={repeater.tabs()}>
            {(t, i) => (
              <button
                type="button"
                onClick={() => repeater.setActive(t.id)}
                title={t.target + " — " + t.title}
                class="group flex max-w-[180px] shrink-0 items-center gap-2 border-r border-border-weaker-base px-3 text-12-regular cursor-default transition-colors"
                classList={{
                  "bg-background-base text-text-strong": active()?.id === t.id,
                  "text-text-weak hover:bg-surface-raised-base-hover": active()?.id !== t.id,
                }}
              >
                <span class="shrink-0 tabular-nums text-text-weak">{i() + 1}</span>
                <span class="truncate">{t.title}</span>
                <span
                  role="button"
                  aria-label="Close tab"
                  class="grid size-4 shrink-0 place-items-center rounded transition-opacity hover:bg-surface-base"
                  classList={{
                    "opacity-70": active()?.id === t.id,
                    "opacity-0 group-hover:opacity-70": active()?.id !== t.id,
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    repeater.close(t.id)
                  }}
                >
                  ✕
                </span>
              </button>
            )}
          </For>
          <IconButton
            icon="plus"
            variant="ghost"
            class="size-8 shrink-0 rounded-none"
            aria-label="New request"
            onClick={() => repeater.create()}
          />
        </div>
      </div>

      <Show
        when={active()}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-3 text-12-regular text-text-weak">
            No requests yet.
            <Button size="large" icon="plus" onClick={() => repeater.create()}>
              New request
            </Button>
          </div>
        }
        keyed
      >
        {(tab) => (
          <>
            {/* toolbar */}
            <div class="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-border-weak-base">
              <Button
                size="small"
                icon="arrow-right"
                disabled={tab.sending || !tab.target}
                onClick={() => void repeater.send(tab.id)}
              >
                {tab.sending ? "Sending…" : "Send"}
              </Button>
              <span class="flex-1" />
              <span class="text-12-regular text-text-weak">Target</span>
              <input
                value={tab.target}
                onInput={(e) => repeater.update(tab.id, { target: e.currentTarget.value })}
                placeholder="https://host"
                spellcheck={false}
                class="h-7 w-72 rounded-md bg-surface-base px-2.5 font-mono text-12-regular text-text-base outline-none placeholder:text-text-weak"
              />
            </div>

            <div class="min-h-0 flex-1">
              <ResizableSplit
                direction="horizontal"
                initial={50}
                class="h-full"
                first={
                  <HttpMessagePane
                    title="Request"
                    side="request"
                    editable
                    value={tab.raw}
                    onInput={(v) => repeater.update(tab.id, { raw: v })}
                  />
                }
                second={
                  <ResponsePane
                    tab={tab}
                    record={() => (tab.responseId ? capture.record(tab.responseId) : undefined)}
                  />
                }
              />
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function ResponsePane(props: { tab: RepeaterTab; record: () => CaptureRecord | undefined }) {
  // Keyed on the record id (stable), not the record object, so the response refreshes
  // in place as its headers/body land instead of remounting on every update.
  return (
    <Show
      when={props.record()?.id}
      fallback={
        <div class="flex h-full items-center justify-center p-4 text-center text-12-regular">
          <Show
            when={props.tab.error}
            fallback={
              <span class="text-text-weak">
                {props.tab.sending ? "Sending…" : "Send the request to see the response."}
              </span>
            }
          >
            <span class="text-icon-critical-base">{props.tab.error}</span>
          </Show>
        </div>
      }
      keyed
    >
      {(_id) => <HttpMessagePane title="Response" side="response" record={props.record()!} />}
    </Show>
  )
}
