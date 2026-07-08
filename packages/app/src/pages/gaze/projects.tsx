import { createMemo, createResource, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobal } from "@/context/global"
import { useDirectoryPicker } from "@/components/directory-picker"
import { riskSummary, scoreColor, type MorganaFinding } from "./findings/scoring"
import { RiskGauge, SeverityBar } from "./viz"
import { ProjectCard } from "./projects/project-card"

// Engagement home: portfolio header (aggregate risk across every open project) + one
// card per project with its own findings summary. Findings for all projects are
// fetched once here and passed down. Projects + actions come from the active server
// context (the same source the sidebar/home use).

function Stat(props: { label: string; value: string | number; color?: string }) {
  return (
    <div class="flex flex-col gap-0.5">
      <span class="text-20-medium tabular-nums" style={{ color: props.color }}>
        {props.value}
      </span>
      <span class="uppercase text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.04em" }}>
        {props.label}
      </span>
    </div>
  )
}

export default function Projects() {
  const global = useGlobal()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()

  const conn = () => global.settings.server.selected()
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.createServerCtx(c) : undefined
  })
  const projects = createMemo(() => ctx()?.projects.list() ?? [])

  // One fetch pass for every project's findings, keyed on the set of worktrees.
  const dirsKey = () => projects().map((p) => p.worktree).join("\n")
  const [findingsMap] = createResource(dirsKey, async (key) => {
    const api = window.api?.morgana
    const dirs = key ? key.split("\n") : []
    const map: Record<string, MorganaFinding[]> = {}
    if (api) {
      for (const d of dirs) {
        try {
          map[d] = await api.findings(d)
        } catch {
          map[d] = []
        }
      }
    }
    return map
  })
  const findingsFor = (dir: string) => findingsMap()?.[dir] ?? []
  const aggregate = createMemo(() => riskSummary(projects().flatMap((p) => findingsFor(p.worktree))))
  const critHigh = () => aggregate().counts.critical + aggregate().counts.high

  const open = (dir: string) => {
    ctx()?.projects.touch(dir)
    navigate(`/${base64Encode(dir)}/session`)
  }
  const close = (dir: string) => ctx()?.projects.close(dir)
  const add = () => {
    const c = conn()
    if (!c) return
    pickDirectory({
      server: c,
      title: "Open project",
      multiple: false,
      onSelect: (result) => {
        const dir = Array.isArray(result) ? result[0] : result
        if (!dir) return
        ctx()?.projects.open(dir)
        open(dir)
      },
    })
  }

  return (
    <div class="flex h-full w-full flex-col bg-background-base">
      {/* header */}
      <div class="flex shrink-0 flex-col gap-4 border-b border-border-weak-base px-5 py-4">
        <div class="flex items-center gap-3">
          <Icon name="folder" size="small" class="text-icon-base" />
          <span class="text-16-medium text-text-strong">Projects</span>
          <span class="text-12-regular text-text-weak">
            {projects().length} engagement{projects().length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            class="ml-auto flex items-center gap-1.5 rounded-md border border-border-weak-base px-2.5 py-1 text-12-medium text-text-base transition-colors hover:bg-surface-base"
            onClick={add}
          >
            <Icon name="plus" size="small" /> Add project
          </button>
        </div>

        {/* portfolio summary */}
        <Show when={projects().length > 0 && aggregate().total > 0}>
          <div class="flex items-center gap-6 rounded-xl border border-border-weak-base bg-background-stronger p-4">
            <RiskGauge value={aggregate().score} color={scoreColor(aggregate().score)} size={92} caption="PORTFOLIO" />
            <div class="flex items-center gap-8">
              <Stat label="Engagements" value={projects().length} />
              <Stat label="Findings" value={aggregate().total} />
              <Stat
                label="Critical + High"
                value={critHigh()}
                color={critHigh() > 0 ? "#dc2626" : undefined}
              />
            </div>
            <div class="ml-auto hidden min-w-0 max-w-xs flex-1 flex-col gap-2 sm:flex">
              <span class="uppercase text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.04em" }}>
                Severity mix
              </span>
              <SeverityBar counts={aggregate().counts} height={10} />
            </div>
          </div>
        </Show>
      </div>

      {/* grid */}
      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <Show
          when={projects().length > 0}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div class="grid size-14 place-items-center rounded-2xl bg-surface-base">
                <Icon name="folder" size="large" class="text-icon-weak-base" />
              </div>
              <span class="text-13-regular text-text-weak">Open a project to start an engagement.</span>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md border border-border-weak-base px-3 py-1.5 text-12-medium text-text-base transition-colors hover:bg-surface-base"
                onClick={add}
              >
                <Icon name="plus" size="small" /> Add project
              </button>
            </div>
          }
        >
          <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            <For each={projects()}>
              {(p) => (
                <ProjectCard
                  project={p}
                  findings={findingsFor(p.worktree)}
                  onOpen={() => open(p.worktree)}
                  onClose={() => close(p.worktree)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
