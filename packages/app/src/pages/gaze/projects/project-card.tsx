import { createMemo, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { LocalProject } from "@/context/layout"
import { cumulativeSeries, riskSummary, scoreColor, SEVERITY_META, type MorganaFinding } from "../findings/scoring"
import { LinearMeter, TrendCurve } from "../viz"

// One project card on the engagement dashboard: identity + a findings summary (the
// headline stat) — risk score + meter, severity dots, and a finding-activity curve —
// plus open / close. Findings are supplied by the parent (one fetch pass).

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function ProjectCard(props: {
  project: LocalProject
  findings: MorganaFinding[]
  onOpen: () => void
  onClose: () => void
}) {
  const dir = () => props.project.worktree
  const summary = createMemo(() => riskSummary(props.findings))
  const series = createMemo(() => cumulativeSeries(props.findings, 12))
  const color = () => scoreColor(summary().score)
  const lastActivity = createMemo(() =>
    props.findings.length ? Math.max(...props.findings.map((f) => f.createdAt)) : undefined,
  )

  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="group flex flex-col gap-3.5 rounded-xl border border-border-weak-base bg-background-stronger p-4 text-left transition-colors hover:border-border-strong-base"
    >
      {/* identity */}
      <div class="flex items-start gap-2.5">
        <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-base">
          <Icon name="folder" size="small" class="text-icon-base" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-14-medium text-text-strong" title={dir()}>
            {basename(dir())}
          </div>
          <div class="truncate text-12-regular text-text-weak" title={dir()}>
            {dir()}
          </div>
        </div>
        <span
          role="button"
          tabindex="0"
          class="shrink-0 rounded p-0.5 text-text-weak opacity-0 transition-opacity hover:text-icon-critical-base group-hover:opacity-100"
          title="Close project"
          onClick={(e) => {
            e.stopPropagation()
            props.onClose()
          }}
        >
          <Icon name="close-small" size="small" />
        </span>
      </div>

      <Show
        when={summary().total > 0}
        fallback={
          <div class="flex items-center gap-2 rounded-lg bg-surface-base px-3 py-4 text-12-regular text-text-weak">
            <Icon name="shield" size="small" class="text-icon-weak-base" />
            No findings yet
          </div>
        }
      >
        {/* score + curve */}
        <div class="flex items-end justify-between gap-3">
          <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline gap-1.5">
              <span class="text-20-medium tabular-nums" style={{ color: color() }}>
                {summary().score}
              </span>
              <span class="text-12-regular text-text-weak">risk</span>
            </div>
            <div class="flex items-center gap-2">
              <For each={SEVERITY_META}>
                {(m) => (
                  <Show when={summary().counts[m.key] > 0}>
                    <span class="flex items-center gap-1 text-12-regular text-text-weak">
                      <span class="size-1.5 rounded-full" style={{ background: m.color }} />
                      {summary().counts[m.key]}
                    </span>
                  </Show>
                )}
              </For>
            </div>
          </div>
          <TrendCurve points={series()} color={color()} width={116} height={40} />
        </div>

        <LinearMeter value={summary().score} color={color()} />
      </Show>

      {/* footer */}
      <div class="flex items-center gap-2">
        <Show
          when={lastActivity()}
          fallback={<span class="text-12-regular text-text-weak">Ready</span>}
        >
          <span class="text-12-regular text-text-weak" title="Last finding filed">
            updated {new Date(lastActivity()!).toLocaleDateString()}
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-1 text-12-medium text-text-base opacity-0 transition-opacity group-hover:opacity-100">
          Open <Icon name="arrow-right" size="small" />
        </span>
      </div>
    </button>
  )
}
