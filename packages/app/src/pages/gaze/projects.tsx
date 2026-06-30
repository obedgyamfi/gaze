import { createMemo, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobal } from "@/context/global"
import { useDirectoryPicker } from "@/components/directory-picker"
import { ProjectCard } from "./projects/project-card"

// Engagement home: one card per opened project (≈ engagement), each with its findings
// summary, plus open / add-folder / close. Findings live per-workspace, so the card
// pulls its own summary from that project's store. Projects + actions come from the
// active server context (the same source the sidebar/home use).

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
      <div class="flex shrink-0 items-center gap-3 border-b border-border-weak-base px-5 py-3">
        <Icon name="folder" size="normal" class="text-icon-base" />
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

      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <Show
          when={projects().length > 0}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Icon name="folder" size="large" class="text-icon-weak" />
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
          <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            <For each={projects()}>
              {(p) => <ProjectCard project={p} onOpen={() => open(p.worktree)} onClose={() => close(p.worktree)} />}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
