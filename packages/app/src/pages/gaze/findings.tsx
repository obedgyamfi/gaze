import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
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
import { RiskGauge, SeverityBar } from "./viz"

// Findings vulnerability dashboard: a workspace-scoped, replay-proven vulnerability
// list with a weighted risk gauge, severity distribution, filters, and a master-list
// + detail-panel outline. Refined to the OpenCode line/curve aesthetic.

function MicroLabel(props: { children: JSX.Element; color?: string }) {
  return (
    <span
      class="uppercase"
      style={{ "font-size": "10.5px", "letter-spacing": "0.04em", "font-weight": 500, color: props.color ?? "var(--text-weak)" }}
    >
      {props.children}
    </span>
  )
}

function FindingRow(props: { f: MorganaFinding; selected: boolean; onClick: () => void }) {
  const meta = () => severityMeta(props.f.severity)
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="group flex w-full items-center gap-3 border-b border-border-weak-base px-4 py-3 text-left transition-colors hover:bg-surface-base"
      classList={{ "bg-surface-base": props.selected }}
      style={{ "border-left": `3px solid ${props.selected ? meta().color : "transparent"}` }}
    >
      <span class="mt-0.5 size-2 shrink-0 rounded-full" style={{ background: meta().color }} />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex items-center gap-2">
          <MicroLabel color={meta().color}>{meta().label}</MicroLabel>
          <span class="shrink-0 text-12-regular text-text-weak">{meta().cvss.toFixed(1)}</span>
          <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{props.f.title}</span>
        </div>
        <div class="flex items-center gap-2 text-12-regular text-text-weak">
          <span class="shrink-0">{props.f.vulnClass}</span>
          <span class="shrink-0 opacity-50">·</span>
          <span class="shrink-0 uppercase" style={{ "font-size": "10.5px", "letter-spacing": "0.03em" }}>
            {props.f.status}
          </span>
          <span class="min-w-0 flex-1 truncate opacity-80">· {props.f.signal}</span>
        </div>
      </div>
      <Icon
        name="chevron-right"
        size="small"
        class="shrink-0 text-icon-weak-base opacity-0 transition-opacity group-hover:opacity-100"
      />
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
      {/* hero header */}
      <div class="flex shrink-0 flex-col gap-4 border-b border-border-weak-base px-5 py-4">
        <div class="flex items-center gap-5">
          <RiskGauge value={summary().score} color={scoreColor(summary().score)} size={104} caption="RISK" />

          <div class="flex min-w-0 flex-1 flex-col gap-2.5">
            <div class="flex items-center gap-2">
              <Icon name="shield" size="small" class="text-icon-base" />
              <span class="text-16-medium text-text-strong">Findings</span>
              <span class="text-12-regular text-text-weak">
                {summary().total} total
                <Show when={summary().dominant}> · {severityMeta(summary().dominant!).label.toLowerCase()}-dominant</Show>
              </span>
              <button
                class="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-12-regular text-text-weak transition-colors hover:bg-surface-base hover:text-text-base"
                onClick={() => void refresh()}
              >
                <Icon name="reset" size="small" /> Refresh
              </button>
            </div>

            <SeverityBar counts={summary().counts} height={10} />

            {/* severity legend = clickable filters */}
            <div class="flex flex-wrap items-center gap-1.5">
              <For each={SEVERITY_META}>
                {(m) => {
                  const active = () => sevFilter().has(m.key)
                  const n = () => summary().counts[m.key]
                  return (
                    <button
                      type="button"
                      onClick={() => toggleSev(m.key)}
                      class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12-medium transition-all"
                      classList={{
                        "border-transparent text-white": active(),
                        "border-border-weak-base text-text-base hover:bg-surface-base": !active(),
                        "opacity-45": !active() && n() === 0,
                      }}
                      style={active() ? { background: m.color } : undefined}
                    >
                      <span class="size-1.5 rounded-full" style={{ background: active() ? "#fff" : m.color }} />
                      {m.label}
                      <span class="tabular-nums opacity-70">{n()}</span>
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        </div>

        {/* filter row */}
        <div class="flex flex-wrap items-center gap-2">
          <Icon name="sliders" size="small" class="text-icon-weak-base" />
          <select
            class="h-7 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
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
          <Show when={visible().length !== findings().length}>
            <span class="text-12-regular text-text-weak">
              {visible().length} of {findings().length}
            </span>
          </Show>
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
          <div class="w-[440px] shrink-0 overflow-y-auto border-r border-border-weak-base">
            <Show
              when={visible().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
                  <Icon name="shield" size="large" class="text-icon-weak-base" />
                  <span class="text-12-regular text-text-weak">
                    {findings().length === 0
                      ? "No findings yet — the agent files them after the oracle confirms a vulnerability."
                      : "No findings match the current filters."}
                  </span>
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
                      <MicroLabel>Notes ({String(notes().length)})</MicroLabel>
                      <For each={notes()}>
                        {(n) => (
                          <div class="rounded-lg border border-border-weak-base bg-background-stronger p-3">
                            <span class="text-12-regular text-text-base">{n.text}</span>
                            <Show when={n.tags.length > 0}>
                              <div class="mt-1 font-mono text-12-regular text-text-weak">{n.tags.join(", ")}</div>
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
