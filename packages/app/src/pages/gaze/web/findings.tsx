import { createSignal, For, onMount, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

// Wire shapes from the desktop morgana IPC (see preload FindingSummary/NoteSummary).
export type MorganaFinding = {
  id: string
  status: string
  vulnClass: string
  severity: string
  title: string
  detail: string
  evidenceId: string
  verdict: string
  signal: string
  createdAt: number
}
export type MorganaNote = {
  id: string
  nodeId?: string
  text: string
  tags: string[]
  createdAt: number
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: "text-text-strong",
  high: "text-text-strong",
  medium: "text-text-base",
  low: "text-text-weak",
  info: "text-text-weak",
}

export default function WebFindings() {
  const [findings, setFindings] = createSignal<MorganaFinding[]>([])
  const [notes, setNotes] = createSignal<MorganaNote[]>([])
  const [loaded, setLoaded] = createSignal(false)

  const refresh = async () => {
    const api = window.api?.morgana
    if (api) {
      try {
        setFindings(await api.findings())
        setNotes(await api.notes())
      } catch {
        /* db not ready yet — show empty */
      }
    }
    setLoaded(true)
  }
  onMount(refresh)

  return (
    <div class="h-full w-full overflow-y-auto bg-background-base">
      <div class="mx-auto max-w-3xl px-6 py-10 flex flex-col gap-8">
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <Icon name="shield" size="normal" class="text-icon-base" />
              <span class="text-16-medium text-text-strong">Findings</span>
            </div>
            <button class="text-12-regular text-text-weak hover:text-text-base" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <span class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
            Replay-proven findings the agent filed — each gated on a positive oracle verdict — plus investigative notes,
            read from the persisted engagement store.
          </span>
        </div>

        <Show when={loaded() && !window.api?.morgana}>
          <span class="text-12-regular text-text-weak">Findings are only available in the desktop app.</span>
        </Show>

        <div class="flex flex-col gap-3">
          <span class="text-14-medium text-text-strong">Findings ({findings().length})</span>
          <Show
            when={findings().length > 0}
            fallback={<span class="text-12-regular text-text-weak">No findings yet — the agent files them after the oracle confirms.</span>}
          >
            <For each={findings()}>
              {(f) => (
                <div class="rounded-xl border border-border-weak-base bg-background-stronger p-4 flex flex-col gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class={`shrink-0 text-12-medium uppercase ${SEVERITY_CLASS[f.severity] ?? "text-text-base"}`}>{f.severity}</span>
                    <span class="text-14-medium text-text-strong truncate">{f.title}</span>
                    <span class="shrink-0 text-12-regular text-text-weak">· {f.vulnClass}</span>
                  </div>
                  <span class="text-12-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                    {f.detail}
                  </span>
                  <span class="text-12-regular text-text-weak font-mono break-all">
                    oracle: {f.verdict} — {f.signal} · {f.evidenceId}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="flex flex-col gap-3">
          <span class="text-14-medium text-text-strong">Notes ({notes().length})</span>
          <Show when={notes().length > 0} fallback={<span class="text-12-regular text-text-weak">No notes yet.</span>}>
            <For each={notes()}>
              {(n) => (
                <div class="rounded-lg border border-border-weak-base bg-background-stronger p-3 flex flex-col gap-1">
                  <span class="text-12-regular text-text-base">{n.text}</span>
                  <Show when={n.tags.length > 0}>
                    <span class="text-12-regular text-text-weak font-mono">{n.tags.join(", ")}</span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
