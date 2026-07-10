import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform, type BrowserStatus, type ProxyStatus } from "@/context/platform"
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
  const morgana = () => window.api?.morgana

  onMount(() => {
    if (!browser) return
    void browser.status(projectDir()).then(setStatus)
    const unsubscribe = browser.subscribe(projectDir(), setStatus)
    onCleanup(unsubscribe)
  })

  // ── Engagement scope (ROE) — gates the agent's active MCP tools ─────────────
  const [scope, setScope] = createSignal<string[]>([])
  const [scopeText, setScopeText] = createSignal("")
  const [savingScope, setSavingScope] = createSignal(false)

  const loadScope = async () => {
    const api = morgana()
    if (!api?.scopeGet) return
    try {
      const hosts = await api.scopeGet(projectDir())
      setScope(hosts)
      setScopeText(hosts.join("\n"))
    } catch {
      /* db not ready yet — leave empty */
    }
  }
  onMount(loadScope)

  // Split on whitespace/commas; dedupe; drop blanks.
  const parseHosts = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]

  const saveScope = async () => {
    const api = morgana()
    if (!api?.scopeSet || savingScope()) return
    setSavingScope(true)
    try {
      const hosts = parseHosts(scopeText())
      await api.scopeSet(projectDir(), hosts)
      setScope(hosts)
      setScopeText(hosts.join("\n"))
      showToast({
        variant: "success",
        title: hosts.length ? "Scope saved" : "Scope cleared",
        description: hosts.length
          ? `${hosts.length} in-scope host${hosts.length === 1 ? "" : "s"} — discovery tools enabled.`
          : "Active discovery/recon tools are now disabled.",
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save scope",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSavingScope(false)
    }
  }

  const scopeDirty = () => parseHosts(scopeText()).join("\n") !== scope().join("\n")

  // ── Intercepting proxy (device / emulator capture) ──────────────────────────
  const proxy = platform.proxy
  const [proxyStatus, setProxyStatus] = createSignal<ProxyStatus>({ running: false })
  const [proxyPort, setProxyPort] = createSignal(8080)
  const [proxyBusy, setProxyBusy] = createSignal(false)
  const [lanIps, setLanIps] = createSignal<string[]>([])
  const [caPath, setCaPath] = createSignal("")

  onMount(() => {
    if (!proxy) return
    void proxy.status(projectDir()).then((s) => {
      setProxyStatus(s)
      if (s.port) setProxyPort(s.port)
    })
    onCleanup(proxy.subscribe(projectDir(), setProxyStatus))
    void proxy.lanIps().then(setLanIps)
    void proxy.caInfo().then((i) => setCaPath(i.path)).catch(() => {})
  })

  const toggleProxy = async () => {
    if (!proxy || proxyBusy()) return
    setProxyBusy(true)
    try {
      if (proxyStatus().running) {
        await proxy.stop(projectDir())
      } else {
        const s = await proxy.start(projectDir(), { port: proxyPort() })
        setProxyStatus(s)
        if (s.error) showToast({ variant: "error", title: "Could not start proxy", description: s.error })
      }
    } finally {
      setProxyBusy(false)
    }
  }

  const exportCa = async () => {
    if (!proxy) return
    try {
      const path = await proxy.exportCa()
      if (path) showToast({ variant: "success", title: "CA certificate exported", description: path })
    } catch (error) {
      showToast({ variant: "error", title: "Export failed", description: error instanceof Error ? error.message : String(error) })
    }
  }

  const primaryLan = () => lanIps()[0]

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
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-4">
              <span class="text-14-medium text-text-strong">Scope</span>
              <span
                class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-12-medium bg-surface-base"
                classList={{ "text-text-base": scope().length > 0, "text-text-weak": scope().length === 0 }}
              >
                <span
                  class="size-1.5 rounded-full"
                  classList={{ "bg-icon-success-base": scope().length > 0, "bg-icon-warning-base": scope().length === 0 }}
                />
                {scope().length > 0 ? `${scope().length} in scope` : "Not set"}
              </span>
            </div>
            <span class="text-12-regular text-text-weak" style={{ "line-height": "var(--line-height-normal)" }}>
              The Rules of Engagement for this workspace. The agent's active tools (crawl, discover, JS analysis, param
              mining, takeover checks, HTTP send) egress <span class="text-text-base">only</span> to these hosts — with an
              empty scope they refuse. One host glob per line or comma-separated, e.g. <span class="font-mono text-text-base">acme.test</span>,{" "}
              <span class="font-mono text-text-base">*.acme.test</span>.
            </span>
          </div>

          <Show
            when={morgana()?.scopeSet}
            fallback={<span class="text-12-regular text-text-weak">Scope editing is only available in the desktop app.</span>}
          >
            <textarea
              value={scopeText()}
              onInput={(e) => setScopeText(e.currentTarget.value)}
              placeholder={"acme.test\n*.acme.test"}
              spellcheck={false}
              rows={4}
              class="w-full resize-y rounded-md border border-border-weak-base bg-surface-base px-3 py-2 font-mono text-12-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-base"
            />
            <Show when={scope().length > 0}>
              <div class="flex flex-wrap gap-1.5">
                <For each={scope()}>
                  {(h) => (
                    <span class="inline-flex items-center rounded-full bg-surface-base px-2 py-0.5 font-mono text-12-regular text-text-base">
                      {h}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex items-center gap-2">
              <Button size="small" disabled={savingScope() || !scopeDirty()} onClick={saveScope}>
                {savingScope() ? "Saving…" : "Save scope"}
              </Button>
              <Show when={scope().length === 0}>
                <span class="text-12-regular text-text-weak">Active discovery/recon tools are disabled until a scope is set.</span>
              </Show>
            </div>
          </Show>
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

        <div class="rounded-xl border border-border-weak-base bg-background-stronger p-5 flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-4">
              <span class="text-14-medium text-text-strong">Intercepting proxy</span>
              <span
                class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-12-medium bg-surface-base"
                classList={{ "text-text-base": proxyStatus().running, "text-text-weak": !proxyStatus().running }}
              >
                <span
                  class="size-1.5 rounded-full"
                  classList={{ "bg-icon-success-base": proxyStatus().running, "bg-icon-weak-base": !proxyStatus().running }}
                />
                {proxyStatus().running ? `Listening :${proxyStatus().port}` : "Idle"}
              </span>
            </div>
            <span class="text-12-regular text-text-weak" style={{ "line-height": "var(--line-height-normal)" }}>
              A Burp-style HTTP(S) proxy for a phone or emulator (e.g. LDPlayer). Point the device's Wi-Fi proxy at this
              machine and install the GAZE CA — every request flows into this workspace's graph as{" "}
              <span class="font-mono text-text-base">proxy</span> traffic.
            </span>
          </div>

          <Show
            when={proxy}
            fallback={<span class="text-12-regular text-text-weak">The proxy is only available in the desktop app.</span>}
          >
            <div class="flex items-center gap-2">
              <div class="flex h-8 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-base px-2.5">
                <span class="text-12-regular text-text-weak">Port</span>
                <input
                  type="number"
                  value={proxyPort()}
                  disabled={proxyStatus().running}
                  onInput={(e) => setProxyPort(Number(e.currentTarget.value) || 8080)}
                  class="w-16 bg-transparent font-mono text-12-regular text-text-base outline-none disabled:opacity-60"
                />
              </div>
              <Button
                size="large"
                variant={proxyStatus().running ? "ghost" : "primary"}
                icon={proxyStatus().running ? "circle-x" : "shield"}
                disabled={proxyBusy()}
                onClick={toggleProxy}
              >
                {proxyBusy() ? "…" : proxyStatus().running ? "Stop proxy" : "Start proxy"}
              </Button>
            </div>

            <Show when={proxyStatus().running}>
              <div class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2.5 flex flex-col gap-1.5">
                <span class="text-12-medium text-text-strong">On the emulator, set the Wi-Fi proxy to:</span>
                <button
                  type="button"
                  class="self-start font-mono text-14-medium text-text-base hover:text-text-strong"
                  onClick={() => {
                    void navigator.clipboard.writeText(`${primaryLan() ?? "YOUR-IP"}:${proxyStatus().port}`)
                    showToast({ variant: "success", title: "Copied", description: "Proxy address copied to clipboard." })
                  }}
                >
                  {primaryLan() ?? "your-lan-ip"}:{proxyStatus().port} <span class="text-12-regular text-text-weak">— click to copy</span>
                </button>
                <Show when={lanIps().length > 1}>
                  <span class="text-12-regular text-text-weak">Other addresses: {lanIps().slice(1).join(", ")}</span>
                </Show>
              </div>
            </Show>

            <div class="flex items-center justify-between gap-3 border-t border-border-weak-base pt-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-12-medium text-text-strong">HTTPS interception certificate</span>
                <span class="text-12-regular text-text-weak truncate">
                  Install this CA on the device (LDPlayer is rooted → add as a system cert).
                  <Show when={caPath()}> Saved at <span class="font-mono">{caPath()}</span>.</Show>
                </span>
              </div>
              <Button size="small" variant="ghost" icon="download" onClick={exportCa}>
                Export CA
              </Button>
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
