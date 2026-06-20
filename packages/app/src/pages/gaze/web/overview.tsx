import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform, type BrowserStatus } from "@/context/platform"
import { useWebCapture } from "@/context/web-capture"
import { decode64 } from "@/utils/base64"
import { showToast } from "@/utils/toast"

export default function WebOverview() {
  const platform = usePlatform()
  const browser = platform.browser
  const capture = useWebCapture()
  const location = useLocation()
  // Each workspace (project dir) has its own browser; launch/status are scoped to it.
  const projectDir = () => decode64(location.pathname.split("/").filter(Boolean)[0] ?? "") || ""
  const [status, setStatus] = createSignal<BrowserStatus>({ running: false })
  const [busy, setBusy] = createSignal(false)

  onMount(() => {
    if (!browser) return
    void browser.status(projectDir()).then(setStatus)
    const unsubscribe = browser.subscribe(projectDir(), setStatus)
    onCleanup(unsubscribe)
  })

  const launch = async () => {
    if (!browser || busy()) return
    setBusy(true)
    try {
      const next = await browser.launch(projectDir())
      setStatus(next)
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not launch browser",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    if (!browser || busy()) return
    setBusy(true)
    try {
      await browser.close(projectDir())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="h-full w-full overflow-y-auto bg-background-base">
      <div class="mx-auto max-w-2xl px-6 py-10 flex flex-col gap-8">
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <Icon name="window-cursor" size="normal" class="text-icon-base" />
            <span class="text-16-medium text-text-strong">Web</span>
          </div>
          <span class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
            Launch a Chromium browser for this engagement. Traffic and DOM events from the spawned browser feed the
            attack-surface graph; the agent drives testing through the web module's MCP tools.
          </span>
        </div>

        <div class="rounded-xl border border-border-weak-base bg-background-stronger p-5 flex flex-col gap-4">
          <div class="flex items-center justify-between gap-4">
            <div class="flex flex-col gap-1 min-w-0">
              <span class="text-14-medium text-text-strong">Capture browser</span>
              <Show
                when={status().running}
                fallback={<span class="text-12-regular text-text-weak">Not running</span>}
              >
                <span class="text-12-regular text-text-base">
                  Running
                  <Show when={status().port}> · CDP port {status().port}</Show>
                </span>
              </Show>
            </div>
            <span
              class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-12-medium bg-surface-base"
              classList={{ "text-text-base": status().running, "text-text-weak": !status().running }}
            >
              <span
                class="size-1.5 rounded-full"
                classList={{ "bg-icon-success-base": status().running, "bg-icon-weak-base": !status().running }}
              />
              {status().running ? "Live" : "Idle"}
            </span>
          </div>

          <Show
            when={browser}
            fallback={
              <span class="text-12-regular text-text-weak">
                Browser control is only available in the desktop app.
              </span>
            }
          >
            <div class="flex items-center gap-2">
              <Show
                when={status().running}
                fallback={
                  <Button size="large" icon="window-cursor" disabled={busy()} onClick={launch}>
                    {busy() ? "Launching…" : "Launch Chromium"}
                  </Button>
                }
              >
                <Button size="large" variant="ghost" icon="circle-x" disabled={busy()} onClick={close}>
                  Close browser
                </Button>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={capture.available}>
          <div class="rounded-xl border border-border-weak-base bg-background-stronger p-5 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-4">
              <span class="text-14-medium text-text-strong">Live capture</span>
              <div class="flex items-center gap-3">
                <span class="text-12-regular text-text-weak">{capture.records().length} requests</span>
                <Show when={capture.records().length > 0}>
                  <Button size="small" variant="ghost" onClick={() => void capture.clear()}>
                    Clear
                  </Button>
                </Show>
              </div>
            </div>
            <Show
              when={capture.records().length > 0}
              fallback={
                <span class="text-12-regular text-text-weak">
                  Launch the browser and navigate — captured requests stream in here.
                </span>
              }
            >
              <div class="flex flex-col gap-0.5 max-h-72 overflow-y-auto font-mono text-12-regular">
                <For each={capture.records().slice(0, 50)}>
                  {(r) => (
                    <div class="flex items-center gap-2 py-0.5 min-w-0">
                      <span class="shrink-0 w-12 text-text-strong">{r.method}</span>
                      <span
                        class="shrink-0 w-10 text-right"
                        classList={{
                          "text-text-weak": !r.status,
                          "text-text-base": !!r.status,
                        }}
                      >
                        {r.status ?? "—"}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-text-base">
                        <span class="text-text-weak">{r.host}</span>
                        {r.path}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
