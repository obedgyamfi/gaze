import { contextBridge, ipcRenderer } from "electron"
import type { BrowserStatus, CaptureStreamEvent, ElectronAPI, WslServersEvent } from "./types"
import type { UpdaterState } from "@opencode-ai/app/updater"

// The workspace project dir keys every per-workspace IPC. With no project open it can
// be "" / undefined — guard so we never invoke a main handler with a bad value (which
// crashes on path.resolve) or hand a non-cloneable reactive value to structuredClone.
const validDir = (d: unknown): d is string => typeof d === "string" && d.length > 0

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeDistro: (name) => ipcRenderer.invoke("wsl-servers-probe-distro", name),
    probeOpencode: (name) => ipcRenderer.invoke("wsl-servers-probe-opencode", name),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  browser: {
    launch: (projectDir, opts) =>
      validDir(projectDir)
        ? ipcRenderer.invoke("browser-launch", projectDir, opts)
        : Promise.reject(new Error("Open a project first — the browser is scoped to a workspace.")),
    close: (projectDir) => (validDir(projectDir) ? ipcRenderer.invoke("browser-close", projectDir) : Promise.resolve()),
    status: (projectDir) =>
      validDir(projectDir) ? ipcRenderer.invoke("browser-status", projectDir) : Promise.resolve({ running: false } as BrowserStatus),
    subscribe: (projectDir, cb) => {
      if (!validDir(projectDir)) return () => {}
      const handler = (_: unknown, status: BrowserStatus) => cb(status)
      ipcRenderer.on("browser-status", handler)
      void ipcRenderer.invoke("browser-subscribe", projectDir)
      return () => ipcRenderer.removeListener("browser-status", handler)
    },
  },
  capture: {
    subscribe: (cb) => {
      const handler = (_: unknown, projectDir: string, event: CaptureStreamEvent) => cb(projectDir, event)
      ipcRenderer.on("capture-event", handler)
      void ipcRenderer.invoke("capture-subscribe")
      return () => ipcRenderer.removeListener("capture-event", handler)
    },
    list: (projectDir, filter) => ipcRenderer.invoke("capture-list", projectDir, filter),
    load: (projectDir) => ipcRenderer.invoke("capture-load", projectDir),
    getBody: (id, side, projectDir) => ipcRenderer.invoke("capture-get-body", id, side, projectDir),
    clear: (projectDir) => ipcRenderer.invoke("capture-clear", projectDir),
    star: (projectDir, id, on) => ipcRenderer.invoke("capture-star", projectDir, id, on),
    comment: (projectDir, id, text) => ipcRenderer.invoke("capture-comment", projectDir, id, text),
    repeaterSend: (projectDir, req) => ipcRenderer.invoke("repeater-send", projectDir, req),
  },
  morgana: {
    findings: (projectDir) => ipcRenderer.invoke("morgana-findings", projectDir),
    notes: (projectDir) => ipcRenderer.invoke("morgana-notes", projectDir),
    observations: (projectDir) => ipcRenderer.invoke("morgana-observations", projectDir),
    scopeGet: (projectDir) => ipcRenderer.invoke("morgana-scope-get", projectDir),
    scopeSet: (projectDir, hosts) => ipcRenderer.invoke("morgana-scope-set", projectDir, hosts),
    canvasList: (projectDir) => ipcRenderer.invoke("morgana-canvas-list", projectDir),
    canvasRead: (projectDir, id) => ipcRenderer.invoke("morgana-canvas-read", projectDir, id),
    canvasSave: (projectDir, doc) => ipcRenderer.invoke("morgana-canvas-save", projectDir, doc),
    canvasDelete: (projectDir, id) => ipcRenderer.invoke("morgana-canvas-delete", projectDir, id),
    saveReport: (opts) => ipcRenderer.invoke("morgana-report-export", opts),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
}

contextBridge.exposeInMainWorld("api", api)
