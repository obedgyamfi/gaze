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
  launch: (opts?: { url?: string }) => Promise<BrowserStatus>
  close: () => Promise<void>
  status: () => Promise<BrowserStatus>
  subscribe: (cb: (status: BrowserStatus) => void) => () => void
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
  HttpSide,
  RepeaterRequest,
} from "../main/capture/types"

export type CaptureAPI = {
  subscribe: (cb: (event: CaptureStreamEvent) => void) => () => void
  list: (filter?: CaptureFilter) => Promise<CaptureRecord[]>
  getBody: (id: string, side: HttpSide) => Promise<BodyData | null>
  clear: () => Promise<void>
  star: (id: string, on: boolean) => Promise<void>
  comment: (id: string, text?: string) => Promise<void>
  repeaterSend: (req: RepeaterRequest) => Promise<CaptureRecord>
}

// ── Morgana findings/notes (read from the persisted engagement db) ────────────
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
}
export type NoteSummary = {
  id: string
  nodeId?: string
  text: string
  tags: string[]
  createdAt: number
}
export type MorganaAPI = {
  findings: () => Promise<FindingSummary[]>
  notes: () => Promise<NoteSummary[]>
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
  installCli: () => Promise<string>
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
