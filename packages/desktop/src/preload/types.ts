import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type BrowserStatus = {
  running: boolean
  pid?: number
  port?: number
  url?: string
  executable?: string
}
export type BrowserAPI = {
  launch: (projectDir: string, opts?: { url?: string }) => Promise<BrowserStatus>
  close: (projectDir: string) => Promise<void>
  status: (projectDir: string) => Promise<BrowserStatus>
  subscribe: (projectDir: string, cb: (status: BrowserStatus) => void) => () => void
}

export type {
  BodyData,
  CaptureFilter,
  CaptureRecord,
  CaptureStreamEvent,
  HeaderPair,
  HttpSide,
  RepeaterRequest,
} from "../main/capture/types"
import type {
  BodyData,
  CaptureFilter,
  CaptureRecord,
  CaptureStreamEvent,
  FormRecord,
  HttpSide,
  NavRecord,
  RepeaterRequest,
} from "../main/capture/types"

export type CaptureAPI = {
  /** Stream live capture events, each tagged with the workspace (project dir) it
   *  belongs to (the browser it came from). */
  subscribe: (cb: (projectDir: string, event: CaptureStreamEvent) => void) => () => void
  list: (projectDir: string, filter?: CaptureFilter) => Promise<CaptureRecord[]>
  /** Load a workspace's PERSISTED captures — restores graph/proxy state on open. */
  load: (projectDir: string) => Promise<{ records: CaptureRecord[]; navs: NavRecord[]; forms: FormRecord[] }>
  getBody: (id: string, side: HttpSide, projectDir: string) => Promise<BodyData | null>
  clear: (projectDir: string) => Promise<void>
  star: (projectDir: string, id: string, on: boolean) => Promise<void>
  comment: (projectDir: string, id: string, text?: string) => Promise<void>
  repeaterSend: (projectDir: string, req: RepeaterRequest) => Promise<CaptureRecord>
}

// ── Morgana findings/notes (read from the persisted engagement db) ────────────
export type FindingSnapshot = { status: number; ms: number; length: number }
export type FindingSummary = {
  id: string
  status: string
  vulnClass: string
  severity: string
  title: string
  detail: string
  evidenceId: string
  verdict: string
  signal: string
  createdAt: number
  nodeId?: string
  baseline?: FindingSnapshot
  test?: FindingSnapshot
  baselineCaptureId?: string
  testCaptureId?: string
}
export type NoteSummary = {
  id: string
  nodeId?: string
  text: string
  tags: string[]
  createdAt: number
}
// Curated canvases (JSONCanvas). `doc` is the full @morgana/web-core CanvasRecord;
// kept structural here so the preload doesn't depend on web-core.
export type CanvasSummary = {
  id: string
  title: string
  purpose: string
  nodeCount: number
  edgeCount: number
  updatedAt: number
}
export type CanvasDoc = {
  id: string
  title: string
  purpose: string
  canvas: { nodes: unknown[]; edges: unknown[] }
  createdAt: number
  updatedAt: number
}
export type MorganaAPI = {
  findings: (projectDir: string) => Promise<FindingSummary[]>
  notes: (projectDir: string) => Promise<NoteSummary[]>
  // Discovered surface as opaque rows — the renderer casts to web-core's Observation to
  // fold. Structural here so the preload stays free of a web-core dependency.
  observations: (projectDir: string) => Promise<unknown[]>
  // Per-workspace engagement scope (in-scope host globs). Gates the active MCP tools.
  scopeGet: (projectDir: string) => Promise<string[]>
  scopeSet: (projectDir: string, hosts: string[]) => Promise<void>
  canvasList: (projectDir: string) => Promise<CanvasSummary[]>
  canvasRead: (projectDir: string, id: string) => Promise<CanvasDoc | null>
  canvasSave: (projectDir: string, doc: CanvasDoc) => Promise<void>
  canvasDelete: (projectDir: string, id: string) => Promise<void>
  saveReport: (opts: { format: "html" | "pdf" | "doc"; html: string; defaultName: string }) => Promise<string | null>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  browser: BrowserAPI
  capture: CaptureAPI
  morgana: MorganaAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
}
