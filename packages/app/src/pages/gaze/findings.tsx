import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { decode64 } from "@/utils/base64"
import {
  riskSummary,
  scoreColor,
  SEVERITY_META,
  severityMeta,
  severityRank,
  type MorganaFinding,
  type MorganaNote,
  type Severity,
} from "./findings/scoring"
import { FindingDetail } from "./findings/finding-detail"

// Engagement findings dashboard: replay-proven vulnerabilities the agent filed, with
// a weighted risk score, severity breakdown, filters, and a master-list + detail-panel
// vuln outline. Scoped to the current workspace (project dir).

function RiskBadge(props: { score: number }) {
  return (
    <span
      class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-12-medium text-white"
      style={{ background: scoreColor(props.score) }}
      title="Weighted engagement risk score (0–100)"
    >
      Risk {props.score}
    </span>
  )
}

function FindingRow(props: { f: MorganaFinding; selected: boolean; onClick: () => void }) {
  const meta = () => severityMeta(props.f.severity)
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex w-full flex-col gap-1 border-b border-border-weak-base px-4 py-3 text-left transition-colors hover:bg-surface-base"
      classList={{ "bg-surface-base-active": props.selected }}
      style={{ "border-left": `3px solid ${meta().color}` }}
    >
      <div class="flex items-center gap-2">
        <span class="shrink-0 text-11-medium uppercase" style={{ color: meta().color }}>
          {meta().label}
        </span>
        <span class="shrink-0 text-11-regular text-text-weak">{meta().cvss.toFixed(1)}</span>
        <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{props.f.title}</span>
      </div>
      <div class="flex items-center gap-2 text-11-regular text-text-weak">
        <span>{props.f.vulnClass}</span>
        <span>·</span>
        <span class="uppercase">{props.f.status}</span>
        <span class="min-w-0 flex-1 truncate">· {props.f.signal}</span>
      </div>
    </button>
  )
}

export default function Findings() {
  const location = useLocation()
  const projectDir = () => decode64(location.pathname.split("/").filter(Boolean)[0] ?? "") || ""

  const [findings, setFindings] = createSignal<MorganaFinding[]>([])
  const [notes, setNotes] = createSignal<MorganaNote[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [selectedId, setSelectedId] = createSignal<string>()
  const [sevFilter, setSevFilter] = createSignal<Set<Severity>>(new Set())
  const [classFilter, setClassFilter] = createSignal("")
  const [statusFilter, setStatusFilter] = createSignal("")
  const [sort, setSort] = createSignal<"severity" | "recency">("severity")

  const refresh = async () => {
    const api = window.api?.morgana
    const dir = projectDir()
    if (api && dir) {
      try {
        setFindings(await api.findings(dir))
        setNotes(await api.notes(dir))
      } catch {
        /* db not ready yet — show empty */
      }
    }
    setLoaded(true)
  }
  onMount(refresh)

  const summary = createMemo(() => riskSummary(findings()))
  const vulnClasses = createMemo(() => [...new Set(findings().map((f) => f.vulnClass))].sort())

  const visible = createMemo(() => {
    const sev = sevFilter()
    const cls = classFilter()
    const st = statusFilter()
    const list = findings().filter(
      (f) =>
        (sev.size === 0 || sev.has(severityMeta(f.severity).key)) &&
        (!cls || f.vulnClass === cls) &&
        (!st || f.status === st),
    )
    return list.sort((a, b) =>
      sort() === "recency"
        ? b.createdAt - a.createdAt
        : severityRank(a.severity) - severityRank(b.severity) || b.createdAt - a.createdAt,
    )
  })

  const selected = createMemo(() => findings().find((f) => f.id === selectedId()))

  const toggleSev = (k: Severity) =>
    setSevFilter((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <div class="flex h-full w-full flex-col bg-background-base">
      {/* header */}
      <div class="flex shrink-0 flex-col gap-3 border-b border-border-weak-base px-5 py-3">
        <div class="flex items-center gap-3">
          <Icon name="warning" size="normal" class="text-icon-base" />
          <span class="text-16-medium text-text-strong">Findings</span>
          <span class="text-12-regular text-text-weak">{summary().total} total</span>
          <RiskBadge score={summary().score} />
          <button class="ml-auto text-12-regular text-text-weak hover:text-text-base" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <For each={SEVERITY_META}>
            {(m) => {
              const active = () => sevFilter().has(m.key)
              return (
                <button
                  type="button"
                  onClick={() => toggleSev(m.key)}
                  class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12-medium transition-colors"
                  classList={{
                    "border-transparent text-white": active(),
                    "border-border-weak-base text-text-base hover:bg-surface-base": !active(),
                  }}
                  style={active() ? { background: m.color } : undefined}
                >
                  <span class="size-1.5 rounded-full" style={{ background: active() ? "#fff" : m.color }} />
                  {m.label} <span class="opacity-70">{summary().counts[m.key]}</span>
                </button>
              )
            }}
          </For>
          <select
            class="ml-2 h-7 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
            value={classFilter()}
            onChange={(e) => setClassFilter(e.currentTarget.value)}
          >
            <option value="">All classes</option>
            <For each={vulnClasses()}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
          <select
            class="h-7 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
            value={statusFilter()}
            onChange={(e) => setStatusFilter(e.currentTarget.value)}
          >
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="confirmed">Confirmed</option>
          </select>
          <select
            class="h-7 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
            value={sort()}
            onChange={(e) => setSort(e.currentTarget.value as "severity" | "recency")}
          >
            <option value="severity">Sort: severity</option>
            <option value="recency">Sort: recent</option>
          </select>
        </div>
      </div>

      {/* body */}
      <Show
        when={loaded() ? window.api?.morgana : true}
        fallback={
          <div class="flex flex-1 items-center justify-center px-6 text-center">
            <span class="text-12-regular text-text-weak">Findings are only available in the desktop app.</span>
          </div>
        }
      >
        <div class="flex min-h-0 flex-1">
          <div class="w-[420px] shrink-0 overflow-y-auto border-r border-border-weak-base">
            <Show
              when={visible().length > 0}
              fallback={
                <div class="px-4 py-6 text-12-regular text-text-weak">
                  {findings().length === 0
                    ? "No findings yet — the agent files them after the oracle confirms a vulnerability."
                    : "No findings match the current filters."}
                </div>
              }
            >
              <For each={visible()}>
                {(f) => <FindingRow f={f} selected={selectedId() === f.id} onClick={() => setSelectedId(f.id)} />}
              </For>
            </Show>
          </div>

          <div class="min-w-0 flex-1">
            <Show
              when={selected()}
              fallback={
                <div class="flex h-full flex-col gap-4 overflow-y-auto p-5">
                  <span class="text-13-regular text-text-weak">Select a finding to read its outline.</span>
                  <Show when={notes().length > 0}>
                    <div class="flex flex-col gap-2">
                      <span class="text-11-medium uppercase tracking-wide text-text-weak">Notes ({notes().length})</span>
                      <For each={notes()}>
                        {(n) => (
                          <div class="rounded-lg border border-border-weak-base bg-background-stronger p-3">
                            <span class="text-12-regular text-text-base">{n.text}</span>
                            <Show when={n.tags.length > 0}>
                              <div class="mt-1 font-mono text-11-regular text-text-weak">{n.tags.join(", ")}</div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              }
            >
              {(f) => <FindingDetail finding={f()} />}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
