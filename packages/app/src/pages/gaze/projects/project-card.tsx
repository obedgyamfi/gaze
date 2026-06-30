import { createMemo, createResource, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { LocalProject } from "@/context/layout"
import { riskSummary, scoreColor, SEVERITY_META, type MorganaFinding } from "../findings/scoring"

// One project card on the engagement dashboard: identity + a findings summary pulled
// from that workspace's store (the engagement's headline stat), and open/close.

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function ProjectCard(props: { project: LocalProject; onOpen: () => void; onClose: () => void }) {
  const dir = () => props.project.worktree
  const [findings] = createResource(dir, async (d) => {
    const api = window.api?.morgana
    if (!api || !d) return [] as MorganaFinding[]
    try {
      return await api.findings(d)
    } catch {
      return [] as MorganaFinding[]
    }
  })
  const summary = createMemo(() => riskSummary(findings() ?? []))
  const lastActivity = createMemo(() => {
    const fs = findings() ?? []
    return fs.length ? Math.max(...fs.map((f) => f.createdAt)) : undefined
  })

  return (
    <div class="group flex flex-col gap-3 rounded-xl border border-border-weak-base bg-background-stronger p-4">
      <div class="flex items-start gap-2">
        <Icon name="folder" size="small" class="mt-0.5 shrink-0 text-icon-base" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-14-medium text-text-strong" title={dir()}>
            {basename(dir())}
          </div>
          <div class="truncate text-11-regular text-text-weak" title={dir()}>
            {dir()}
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 text-text-weak opacity-0 transition-opacity hover:text-icon-critical-base group-hover:opacity-100"
          title="Close project"
          onClick={(e) => {
            e.stopPropagation()
            props.onClose()
          }}
        >
          <Icon name="close-small" size="small" />
        </button>
      </div>

      <div class="flex items-center gap-2">
        <Show
          when={summary().total > 0}
          fallback={<span class="text-11-regular text-text-weak">No findings yet</span>}
        >
          <span
            class="inline-flex items-center rounded-md px-1.5 py-0.5 text-11-medium text-white"
            style={{ background: scoreColor(summary().score) }}
            title="Weighted risk score"
          >
            Risk {summary().score}
          </span>
          <For each={SEVERITY_META}>
            {(m) => (
              <Show when={summary().counts[m.key] > 0}>
                <span class="inline-flex items-center gap-1 text-11-regular text-text-weak">
                  <span class="size-1.5 rounded-full" style={{ background: m.color }} />
                  {summary().counts[m.key]}
                </span>
              </Show>
            )}
          </For>
        </Show>
        <Show when={lastActivity()}>
          <span class="ml-auto text-11-regular text-text-weak" title="Last finding filed">
            {new Date(lastActivity()!).toLocaleDateString()}
          </span>
        </Show>
      </div>

      <button
        type="button"
        class="flex items-center justify-center gap-1.5 rounded-md border border-border-weak-base py-1.5 text-12-medium text-text-base transition-colors hover:bg-surface-base"
        onClick={props.onOpen}
      >
        <Icon name="arrow-right" size="small" /> Open
      </button>
    </div>
  )
}
