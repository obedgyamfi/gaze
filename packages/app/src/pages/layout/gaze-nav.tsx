import { For } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { CORE_VIEWS } from "@/modules/registry"
import { useGazeViews } from "@/pages/gaze/open"

export function GazeNav(props: { mobile?: boolean }) {
  const gaze = useGazeViews()
  const placement = () => (props.mobile ? "bottom" : "right")

  return (
    <div data-component="gaze-nav" class="shrink-0 w-full flex flex-col items-center gap-3">
      <span class="shrink-0 h-px w-5 bg-border-weak-base" aria-hidden="true" />
      <For each={CORE_VIEWS}>
        {(view) => (
          <Tooltip placement={placement()} value={view.label}>
            <IconButton
              icon={view.icon}
              variant={gaze.active(view.id) ? "secondary" : "ghost"}
              size="large"
              onClick={() => gaze.open(view.id)}
              aria-label={view.label}
              aria-current={gaze.active(view.id) ? "page" : undefined}
            />
          </Tooltip>
        )}
      </For>
    </div>
  )
}
