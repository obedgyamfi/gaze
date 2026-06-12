import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { enabledModules } from "@/modules/registry"
import { useGazeViews } from "@/pages/gaze/open"

export function GazeModuleTree() {
  const gaze = useGazeViews()
  const [expanded, setExpanded] = createStore<Record<string, boolean>>(
    Object.fromEntries(enabledModules().map((module) => [module.id, true])),
  )

  return (
    <div data-component="gaze-module-tree" class="shrink-0 flex flex-col gap-0.5 py-2 border-b border-border-weak-base">
      <div class="px-2 pb-1 text-12-regular text-text-weak">Modules</div>
      <For each={enabledModules()}>
        {(module) => (
          <>
            <button
              type="button"
              class="flex items-center gap-1.5 w-full pl-1 pr-2 py-1.5 rounded-md cursor-default transition-colors hover:bg-surface-raised-base-hover"
              onClick={() => setExpanded(module.id, (open) => !open)}
              aria-expanded={expanded[module.id]}
            >
              <Icon name={expanded[module.id] ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
              <Icon name={module.icon} size="small" class="text-icon-base" />
              <span class="text-14-medium text-text-strong">{module.label}</span>
            </button>
            <Show when={expanded[module.id]}>
              <For each={module.tools}>
                {(tool) => (
                  <button
                    type="button"
                    classList={{
                      "flex items-center gap-1.5 w-full pl-6 pr-2 py-1.5 rounded-md cursor-default transition-colors": true,
                      "hover:bg-surface-raised-base-hover text-text-base": !gaze.active(tool.id),
                      "bg-surface-base-active text-text-strong": gaze.active(tool.id),
                    }}
                    onClick={() => gaze.open(tool.id)}
                    aria-current={gaze.active(tool.id) ? "page" : undefined}
                  >
                    <Icon name={tool.icon} size="small" class="text-icon-base" />
                    <span class="text-14-regular">{tool.label}</span>
                  </button>
                )}
              </For>
            </Show>
          </>
        )}
      </For>
    </div>
  )
}
