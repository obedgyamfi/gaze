import { createSignal, For, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { LENSES } from "./lenses/registry"
import { graphState, setGraphState } from "./graph-state"

// The corner "terrain" switcher — like changing a map's layer. Lists the lenses
// (each a projection of the one SPG) plus composable overlays. Selecting a lens
// swaps graphState.activeLens; the canvas eases node positions into the new layout.

const iconName = (s: string) => s as IconProps["name"]

export function LayerSwitcher() {
  const [open, setOpen] = createSignal(false)
  const activeLens = () => LENSES.find((l) => l.id === graphState.activeLens) ?? LENSES[0]

  return (
    <div class="absolute right-3 top-3 z-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch graph layer"
        class="flex h-8 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-base px-2.5 text-12-medium text-text-base shadow-sm transition-colors hover:bg-surface-base-active"
      >
        <Icon name="dot-grid" size="small" class="text-icon-base" />
        {activeLens().label}
        <Icon name="chevron-down" size="small" class="text-icon-weak" />
      </button>

      <Show when={open()}>
        <div class="fixed inset-0 z-10" onClick={() => setOpen(false)} />
        <div class="absolute right-0 top-9 z-20 w-72 overflow-hidden rounded-lg border border-border-weak-base bg-surface-base shadow-lg">
          <div class="px-3 pt-2 pb-1 text-11-medium uppercase tracking-wide text-text-weak">Layers</div>
          <For each={LENSES}>
            {(lens) => (
              <button
                type="button"
                onClick={() => {
                  setGraphState("activeLens", lens.id)
                  setOpen(false)
                }}
                class="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-base-active"
                classList={{ "bg-surface-base-active": graphState.activeLens === lens.id }}
              >
                <Icon name={iconName(lens.icon)} size="small" class="mt-0.5 shrink-0 text-icon-base" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-12-medium text-text-strong">
                    {lens.label}
                    <Show when={graphState.activeLens === lens.id}>
                      <Icon name="check-small" size="small" class="text-icon-base" />
                    </Show>
                  </span>
                  <span class="block text-11-regular text-text-weak">{lens.blurb}</span>
                </span>
              </button>
            )}
          </For>

          <div class="my-1 h-px bg-border-weak-base" />
          <div class="px-3 pt-1 pb-1 text-11-medium uppercase tracking-wide text-text-weak">Overlays</div>
          <button
            type="button"
            onClick={() => setGraphState("overlays", "risk-heat", (v) => !v)}
            class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-base-active"
          >
            <Icon name="eye" size="small" class="shrink-0 text-icon-base" />
            <span class="flex-1 text-12-medium text-text-base">Risk heat</span>
            <span
              class="text-11-medium"
              classList={{
                "text-text-strong": graphState.overlays["risk-heat"],
                "text-text-weak": !graphState.overlays["risk-heat"],
              }}
            >
              {graphState.overlays["risk-heat"] ? "On" : "Off"}
            </span>
          </button>
        </div>
      </Show>
    </div>
  )
}
