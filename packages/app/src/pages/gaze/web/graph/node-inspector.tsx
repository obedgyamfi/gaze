import { createMemo, createSignal, For, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useWebCapture } from "@/context/web-capture"
import type { CaptureRecord } from "@/web/capture-types"
import { HttpMessageView } from "../http/http-message-view"
import { statusClassColor, type TreeNode } from "./graph-model"

// Full node detail — identity plus every capture that mapped to this node,
// shown verbatim through the shared HTTP viewer. The graph is a visual layer;
// the truth lives here, unredacted.

function statusTextColor(status?: number): string {
  const c = statusClassColor(status)
  if (!c) return "text-text-weak"
  if (status! < 300) return "text-text-success"
  if (status! < 400) return "text-text-base"
  if (status! < 500) return "text-text-warning"
  return "text-text-danger"
}

export function NodeInspector(props: { node: TreeNode; onClose: () => void }) {
  const capture = useWebCapture()
  const [selectedId, setSelectedId] = createSignal<string | undefined>(props.node.captureIds[0])

  const records = createMemo(() =>
    props.node.captureIds.map((id) => capture.record(id)).filter((r): r is CaptureRecord => !!r),
  )
  const selected = createMemo(() => records().find((r) => r.id === selectedId()) ?? records()[0])

  return (
    <div class="flex h-full w-[440px] shrink-0 flex-col border-l border-border-weak-base bg-background-stronger">
      <div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-weak-base">
        <span class="size-2 shrink-0 rounded-full" style={{ background: props.node.color }} />
        <span class="min-w-0 flex-1 truncate text-12-medium text-text-strong" title={props.node.url ?? props.node.label}>
          {props.node.label}
        </span>
        <IconButton icon="close-small" variant="ghost" class="size-6" onClick={props.onClose} aria-label="Close" />
      </div>

      <div class="shrink-0 flex flex-wrap gap-1.5 px-3 py-2 border-b border-border-weak-base">
        <Badge label={props.node.category ?? props.node.kind} color={props.node.color} />
        <Show when={props.node.method}>
          <Badge label={props.node.method!} />
        </Show>
        <Show when={props.node.status != null}>
          <Badge label={String(props.node.status)} color={statusClassColor(props.node.status) ?? undefined} />
        </Show>
        <Show when={props.node.resourceType}>
          <Badge label={props.node.resourceType!} />
        </Show>
      </div>

      <Show when={props.node.url}>
        <div class="shrink-0 px-3 py-2 border-b border-border-weak-base">
          <span class="break-all font-mono text-12-regular text-text-base">{props.node.url}</span>
        </div>
      </Show>

      <Show
        when={records().length > 0}
        fallback={<div class="p-3 text-12-regular text-text-weak">No captured requests for this node.</div>}
      >
        <div class="shrink-0 px-3 py-1.5 text-10-medium uppercase tracking-wider text-text-weak">
          {records().length} {records().length === 1 ? "capture" : "captures"}
        </div>
        <div class="shrink-0 max-h-36 overflow-y-auto border-b border-border-weak-base">
          <For each={records()}>
            {(r) => (
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-12-regular cursor-default transition-colors"
                classList={{
                  "bg-surface-base-active": r.id === selected()?.id,
                  "hover:bg-surface-raised-base-hover": r.id !== selected()?.id,
                }}
                onClick={() => setSelectedId(r.id)}
              >
                <span class="w-12 shrink-0 text-text-strong">{r.method}</span>
                <span class={`w-8 shrink-0 ${statusTextColor(r.status)}`}>{r.status ?? "—"}</span>
                <span class="min-w-0 flex-1 truncate text-text-base">{r.path}</span>
              </button>
            )}
          </For>
        </div>
        <div class="min-h-0 flex-1 overflow-hidden">
          <Show when={selected()} keyed>
            {(record) => <HttpMessageView record={record} layout="stacked" />}
          </Show>
        </div>
      </Show>
    </div>
  )
}

function Badge(props: { label: string; color?: string }) {
  return (
    <span
      class="rounded px-1.5 py-0.5 text-10-medium uppercase tracking-wider"
      style={{
        color: props.color ?? "var(--text-weak)",
        background: props.color ? `color-mix(in srgb, ${props.color} 16%, transparent)` : "var(--surface-base)",
      }}
    >
      {props.label}
    </span>
  )
}
