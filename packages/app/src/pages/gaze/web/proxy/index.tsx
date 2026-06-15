import { createMemo, For, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useWebCapture } from "@/context/web-capture"
import { useRepeater } from "@/context/web-repeater"
import { useGazeViews } from "@/pages/gaze/open"
import type { CaptureRecord } from "@/web/capture-types"
import { ResizableSplit } from "../http/resizable-split"
import { HttpMessagePane, statusTextClass } from "../http/http-message-pane"
import { formatSize } from "../http/body-format"

// The proxy log — a Burp-style request history with full request/response
// detail. Every observed request (and repeater send) lands here, unredacted.

type StatusClass = "all" | "2xx" | "3xx" | "4xx" | "5xx"
const STATUS_CLASSES: StatusClass[] = ["all", "2xx", "3xx", "4xx", "5xx"]

const METHOD_CLASS: Record<string, string> = {
  GET: "text-syntax-info",
  POST: "text-syntax-success",
  PUT: "text-syntax-warning",
  PATCH: "text-syntax-warning",
  DELETE: "text-syntax-critical",
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

export default function ProxyView() {
  const capture = useWebCapture()
  const repeater = useRepeater()
  const gaze = useGazeViews()

  // Persisted in the capture context so the selection + filters survive the
  // proxy tool tab unmounting when you switch tabs and come back.
  const statusClass = () => capture.proxyUi.statusClass as StatusClass
  const setStatusClass = (s: StatusClass) => capture.setProxyUi("statusClass", s)
  const query = () => capture.proxyUi.query
  const setQuery = (q: string) => capture.setProxyUi("query", q)
  const starredOnly = () => capture.proxyUi.starredOnly
  const setSelectedId = (id: string | undefined) => capture.setProxyUi("selectedId", id)
  const selectedId = () => capture.proxyUi.selectedId

  const rows = createMemo(() => {
    const q = query().trim().toLowerCase()
    const sc = statusClass()
    return capture
      .records()
      .filter((r) => {
        if (starredOnly() && !r.starred) return false
        if (sc !== "all") {
          const cls = r.status ? `${Math.floor(r.status / 100)}xx` : ""
          if (cls !== sc) return false
        }
        if (q && !`${r.method} ${r.host}${r.path} ${r.status ?? ""} ${r.source}`.toLowerCase().includes(q)) return false
        return true
      })
      .slice()
      .reverse()
  })

  const selected = createMemo(() => {
    const id = selectedId()
    return id ? capture.record(id) : undefined
  })

  const sendToRepeater = async (r: CaptureRecord) => {
    await repeater.openFromRecord(r)
    gaze.open("repeater")
  }

  const table = (
    <div class="flex h-full min-h-0 flex-col">
      <FilterBar
        statusClass={statusClass()}
        onStatusClass={setStatusClass}
        query={query()}
        onQuery={setQuery}
        starredOnly={starredOnly()}
        onStarredOnly={() => capture.setProxyUi("starredOnly", (v) => !v)}
        count={rows().length}
        onClear={() => void capture.clear()}
      />
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full border-collapse text-12-regular">
          <thead class="sticky top-0 z-10 bg-background-stronger text-left text-12-medium uppercase tracking-wider text-text-weak">
            <tr>
              <th class="w-7 px-2 py-1.5" />
              <th class="w-16 px-2 py-1.5 font-medium">Method</th>
              <th class="px-2 py-1.5 font-medium">Host / Path</th>
              <th class="w-14 px-2 py-1.5 font-medium">Status</th>
              <th class="w-28 px-2 py-1.5 font-medium">Type</th>
              <th class="w-16 px-2 py-1.5 text-right font-medium">Size</th>
              <th class="w-12 px-2 py-1.5 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => (
                <tr
                  onClick={() => setSelectedId(r.id)}
                  class="cursor-default border-b border-border-weaker-base transition-colors"
                  classList={{
                    "bg-surface-base-active": selectedId() === r.id,
                    "hover:bg-surface-raised-base-hover": selectedId() !== r.id,
                  }}
                >
                  <td class="px-2 py-1 text-center">
                    <button
                      type="button"
                      aria-label="Star"
                      class="align-middle"
                      classList={{
                        "text-icon-warning-base": r.starred,
                        "text-text-weak opacity-40 hover:opacity-100": !r.starred,
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        void capture.star(r.id, !r.starred)
                      }}
                    >
                      <Icon star={!!r.starred} />
                    </button>
                  </td>
                  <td class="px-2 py-1">
                    <span class={`font-mono text-12-medium ${METHOD_CLASS[r.method] ?? "text-text-base"}`}>
                      {r.method}
                    </span>
                  </td>
                  <td class="max-w-0 px-2 py-1">
                    <div class="flex items-center gap-1.5 truncate">
                      <Show when={r.source === "repeater"}>
                        <span class="shrink-0 rounded-sm bg-surface-base px-1 text-12-medium text-text-weak">RPT</span>
                      </Show>
                      <span class="truncate">
                        <span class="text-text-base">{r.host}</span>
                        <span class="text-text-strong">{r.path}</span>
                      </span>
                    </div>
                  </td>
                  <td class="px-2 py-1">
                    <span class={`font-mono text-12-regular ${statusTextClass(r.status)}`}>{r.status ?? "—"}</span>
                  </td>
                  <td class="px-2 py-1 truncate text-text-base">
                    {r.responseBody?.contentType ?? r.resourceType ?? ""}
                  </td>
                  <td class="px-2 py-1 text-right tabular-nums text-text-weak">
                    {formatSize(r.responseBody?.size ?? 0)}
                  </td>
                  <td class="px-2 py-1 text-right tabular-nums text-text-weak">{ago(r.tsRequest)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={!rows().length}>
          <div class="flex h-40 items-center justify-center text-12-regular text-text-weak">
            No requests captured yet — launch the browser and browse.
          </div>
        </Show>
      </div>
    </div>
  )

  // Keyed on the selected id (stable), not the record object — so live header/body
  // updates (e.g. the wire Cookie/Authorization arriving) refresh the panes in place
  // instead of remounting them and resetting the active tab + scroll.
  const detail = (
    <Show
      when={selectedId()}
      fallback={
        <div class="flex h-full items-center justify-center text-12-regular text-text-weak">
          Select a request to inspect it.
        </div>
      }
      keyed
    >
      {(id) => {
        const rec = createMemo(() => capture.record(id))
        return (
          <Show when={rec()}>
            {(r) => (
              <ResizableSplit
                direction="horizontal"
                initial={50}
                class="h-full"
                first={
                  <HttpMessagePane
                    title="Request"
                    side="request"
                    record={r()}
                    toolbar={
                      <>
                        <Tooltip placement="bottom" value="Send to Repeater">
                          <IconButton
                            icon="reset"
                            variant="ghost"
                            class="size-6"
                            aria-label="Send to Repeater"
                            onClick={() => void sendToRepeater(r())}
                          />
                        </Tooltip>
                        <IconButton
                          icon="close-small"
                          variant="ghost"
                          class="size-6"
                          aria-label="Close"
                          onClick={() => setSelectedId(undefined)}
                        />
                      </>
                    }
                  />
                }
                second={<HttpMessagePane title="Response" side="response" record={r()} />}
              />
            )}
          </Show>
        )
      }}
    </Show>
  )

  return (
    <div class="h-full w-full bg-background-base">
      <Show when={selected()} fallback={table}>
        <ResizableSplit direction="vertical" initial={55} first={table} second={detail} class="h-full" />
      </Show>
    </div>
  )
}

function FilterBar(props: {
  statusClass: StatusClass
  onStatusClass: (s: StatusClass) => void
  query: string
  onQuery: (q: string) => void
  starredOnly: boolean
  onStarredOnly: () => void
  count: number
  onClear: () => void
}) {
  return (
    <div class="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border-weak-base">
      <div class="flex items-center rounded-md bg-surface-base p-0.5">
        <For each={STATUS_CLASSES}>
          {(s) => (
            <button
              type="button"
              class="rounded px-2 py-0.5 text-12-medium cursor-default transition-colors"
              classList={{
                "bg-surface-raised-base-active text-text-strong": props.statusClass === s,
                "text-text-weak hover:text-text-base": props.statusClass !== s,
              }}
              onClick={() => props.onStatusClass(s)}
            >
              {s}
            </button>
          )}
        </For>
      </div>
      <input
        value={props.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
        placeholder="Filter requests"
        spellcheck={false}
        class="h-7 min-w-0 flex-1 rounded-md bg-surface-base px-2.5 text-12-regular text-text-base outline-none placeholder:text-text-weak"
      />
      <Tooltip placement="bottom" value="Starred only">
        <button
          type="button"
          aria-label="Starred only"
          class="grid size-7 place-items-center rounded-md transition-colors"
          classList={{
            "bg-surface-base text-icon-warning-base": props.starredOnly,
            "text-text-weak hover:bg-surface-base hover:text-text-base": !props.starredOnly,
          }}
          onClick={props.onStarredOnly}
        >
          <Icon star={props.starredOnly} />
        </button>
      </Tooltip>
      <span class="tabular-nums text-12-regular text-text-weak">{props.count}</span>
      <Tooltip placement="bottom" value="Clear log">
        <IconButton icon="trash" variant="ghost" class="size-7" aria-label="Clear log" onClick={props.onClear} />
      </Tooltip>
    </div>
  )
}

// Inline star glyph (filled vs outline) — small enough to avoid an icon dep here.
function Icon(props: { star: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill={props.star ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.4"
    >
      <path
        d="M10 2.5l2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.97l-4.7 2.48.9-5.23-3.8-3.7 5.25-.76z"
        stroke-linejoin="round"
      />
    </svg>
  )
}
