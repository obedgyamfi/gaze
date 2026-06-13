import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useWebCapture } from "@/context/web-capture"
import type { CaptureRecord, HeaderPair, HttpSide } from "@/web/capture-types"
import { formatBody, formatSize } from "./body-format"

// Full request/response viewer — the shared HTTP primitive used by the node
// inspector, the proxy detail, and the repeater. Bodies are loaded lazily from
// the capture store. Nothing is redacted: every header and the full body show.

function statusColor(status?: number): string {
  if (status == null) return "text-text-weak"
  if (status < 300) return "text-text-success"
  if (status < 400) return "text-text-base"
  if (status < 500) return "text-text-warning"
  return "text-text-danger"
}

export function HttpMessageView(props: { record: CaptureRecord; layout?: "stacked" | "split" }) {
  const layout = () => props.layout ?? "stacked"
  return (
    <div
      classList={{
        "flex h-full min-h-0 w-full": true,
        "flex-col divide-y divide-border-weak-base": layout() === "stacked",
        "flex-row divide-x divide-border-weak-base": layout() === "split",
      }}
    >
      <Side title="Request" record={props.record} side="request" />
      <Side title="Response" record={props.record} side="response" />
    </div>
  )
}

function Side(props: { title: string; record: CaptureRecord; side: HttpSide }) {
  const isRequest = props.side === "request"
  const headers = () => (isRequest ? props.record.requestHeaders : props.record.responseHeaders) ?? []
  const bodyMeta = () => (isRequest ? props.record.requestBody : props.record.responseBody)

  const firstLine = createMemo(() => {
    const r = props.record
    if (isRequest) return `${r.method} ${r.path}${r.query ? `?${r.query}` : ""}`
    return `${r.httpVersion ?? "HTTP"} ${r.status ?? ""} ${r.statusText ?? ""}`.trim()
  })

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-base">
        <span class="text-10-medium uppercase tracking-wider text-text-weak">{props.title}</span>
        <Show when={!isRequest}>
          <span class={`text-12-medium ${statusColor(props.record.status)}`}>{props.record.status ?? "—"}</span>
        </Show>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-12-regular">
        <div class="text-text-base opacity-80 break-all">{firstLine()}</div>
        <HeadersBlock headers={headers()} />
        <Show when={bodyMeta()?.present}>
          <BodyBlock recordId={props.record.id} side={props.side} contentType={bodyMeta()?.contentType} size={bodyMeta()?.size ?? 0} />
        </Show>
      </div>
    </div>
  )
}

function HeadersBlock(props: { headers: HeaderPair[] }) {
  return (
    <div class="mt-1">
      <For each={props.headers}>
        {(h) => (
          <div class="break-all">
            <span class="text-text-info">{h.name}</span>
            <span class="text-text-weak">: {h.value}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function BodyBlock(props: { recordId: string; side: HttpSide; contentType?: string; size: number }) {
  const capture = useWebCapture()
  const [pretty, setPretty] = createSignal(true)
  const [body] = createResource(
    () => [props.recordId, props.side] as const,
    ([id, side]) => capture.getBody(id, side),
  )

  return (
    <div class="mt-3">
      <div class="mb-1 flex items-center gap-2">
        <span class="text-10-medium uppercase tracking-wider text-text-weak">Body</span>
        <span class="text-10-regular text-text-weak">{formatSize(props.size)}</span>
        <span class="flex-1" />
        <button
          type="button"
          class="text-10-medium"
          classList={{ "text-text-strong": pretty(), "text-text-weak": !pretty() }}
          onClick={() => setPretty(true)}
        >
          Pretty
        </button>
        <button
          type="button"
          class="text-10-medium"
          classList={{ "text-text-strong": !pretty(), "text-text-weak": pretty() }}
          onClick={() => setPretty(false)}
        >
          Raw
        </button>
      </div>
      <Show
        when={body()}
        fallback={<div class="text-text-weak">{body.loading ? "Loading…" : "No body."}</div>}
      >
        {(data) => (
          <Show
            when={data().text !== undefined}
            fallback={
              <div class="text-text-weak">
                {data().contentType ?? "binary"} · {formatSize(data().size)} (binary, not shown)
                <Show when={data().truncated}> · truncated</Show>
              </div>
            }
          >
            <pre class="whitespace-pre-wrap break-all rounded-md bg-surface-base p-2 text-text-base">
              {formatBody(data().text!, data().contentType, pretty())}
              <Show when={data().truncated}>
                <div class="mt-2 text-text-weak">… truncated</div>
              </Show>
            </pre>
          </Show>
        )}
      </Show>
    </div>
  )
}
