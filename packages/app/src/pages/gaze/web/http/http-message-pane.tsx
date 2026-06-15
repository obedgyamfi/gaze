import { createMemo, createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useWebCapture } from "@/context/web-capture"
import type { CaptureRecord, HeaderPair } from "@/web/capture-types"
import {
  bodyLang as bodyLangOf,
  formatBody,
  tokenizeCode,
  tokenizeJson,
  tokenizeMarkup,
  type BodyLang,
} from "./body-format"
import {
  buildRawMessage,
  canonicalHeaderName,
  countMatches,
  normalizeProtocol,
  parseCookies,
  parseRawRequest,
  requestStartLine,
  responseStartLine,
} from "./raw-http"

// One side of a request/response pair, Burp-style: a sub-tab bar (Pretty · Raw ·
// Headers · Cookies/Render), a line-numbered + syntax-highlighted raw message,
// word-wrap + copy, and a bottom search bar with a highlight count. Read-only
// (proxy) or editable (repeater request).

export type Side = "request" | "response"

// Method + status colours from opencode's syntax palette — balanced for light
// and dark by design.
const METHOD_CLASS: Record<string, string> = {
  GET: "text-syntax-info",
  POST: "text-syntax-success",
  PUT: "text-syntax-warning",
  PATCH: "text-syntax-warning",
  DELETE: "text-syntax-critical",
}
function methodClass(method: string): string {
  return METHOD_CLASS[method] ?? "text-syntax-keyword"
}

export function statusTextClass(status?: number): string {
  if (status == null) return "text-text-weak"
  if (status < 300) return "text-syntax-success"
  if (status < 400) return "text-syntax-info"
  if (status < 500) return "text-syntax-warning"
  return "text-syntax-critical"
}
const statusClass = statusTextClass

type SubTab = "pretty" | "raw" | "headers" | "cookies" | "render"

export function HttpMessagePane(props: {
  title: string
  side: Side
  /** Read-only view from a record. */
  record?: CaptureRecord
  /** Editable mode (repeater request) — owns the raw text. */
  editable?: boolean
  value?: string
  onInput?: (value: string) => void
  /** Extra controls rendered into the title bar (right side). */
  toolbar?: JSX.Element
}) {
  const capture = useWebCapture()
  const [sub, setSub] = createSignal<SubTab>(props.editable ? "raw" : "pretty")
  const [wrap, setWrap] = createSignal(true)
  const [search, setSearch] = createSignal("")

  const headers = () => {
    if (props.editable) return parseRawRequest(props.value ?? "").headers
    return (props.side === "request" ? props.record?.requestHeaders : props.record?.responseHeaders) ?? []
  }
  const bodyMeta = () => (props.side === "request" ? props.record?.requestBody : props.record?.responseBody)

  const [body] = createResource(
    () => (props.record && bodyMeta()?.present ? ([props.record.id, props.side] as const) : null),
    ([id, side]) => capture.getBody(id, side),
  )
  const ct = () => {
    // Editable requests have no record — read the content type off the typed headers.
    if (props.editable) return headers().find((h) => h.name.toLowerCase() === "content-type")?.value
    return body()?.contentType ?? bodyMeta()?.contentType
  }

  const startLine = createMemo(() => {
    const r = props.record
    if (!r) return ""
    return props.side === "request" ? requestStartLine(r) : responseStartLine(r)
  })

  // The full wire message; Pretty formats the body, Raw shows it verbatim. Both
  // render in one continuously line-numbered view with the headers HTTP-coloured
  // and the body coloured for its language.
  // Raw = the full wire message verbatim (start line + headers + body), shown in
  // one continuously line-numbered view. Pretty renders the body via shiki.
  const rawText = createMemo(() => {
    if (props.editable) return props.value ?? ""
    if (!props.record) return ""
    const text = body()?.text
    return buildRawMessage(startLine(), headers(), text != null ? text : undefined)
  })
  // Pretty = the same full wire view as Raw, but the body is pretty-printed
  // (JSON/XML/form indented). Both go through one renderer so every tab —
  // request and response, Pretty/Raw/Headers — shares one colour palette.
  const prettyText = createMemo(() => {
    if (props.editable) {
      // Keep the typed head verbatim; just pretty-print the body for the read-only view.
      const raw = props.value ?? ""
      const sep = raw.search(/\r?\n\r?\n/)
      if (sep < 0) return raw
      const head = raw.slice(0, sep)
      const bodyText = raw.slice(sep).replace(/^\r?\n\r?\n/, "")
      if (!bodyText) return head
      return head + "\n\n" + formatBody(bodyText, ct(), true)
    }
    if (!props.record) return ""
    const text = body()?.text
    return buildRawMessage(startLine(), headers(), text != null ? formatBody(text, ct(), true) : undefined)
  })
  const lang = createMemo<BodyLang>(() => bodyLangOf(ct()))
  const displayText = createMemo(() => (sub() === "pretty" ? prettyText() : rawText()))

  const subTabs = createMemo<{ id: SubTab; label: string }[]>(() =>
    props.side === "request"
      ? [
          { id: "pretty", label: "Pretty" },
          { id: "raw", label: "Raw" },
          { id: "headers", label: "Headers" },
          { id: "cookies", label: "Cookies" },
        ]
      : [
          { id: "pretty", label: "Pretty" },
          { id: "raw", label: "Raw" },
          { id: "render", label: "Render" },
          { id: "headers", label: "Headers" },
        ],
  )

  const matches = createMemo(() => countMatches(displayText(), search().trim()))

  return (
    <div class="flex h-full min-h-0 min-w-0 flex-col bg-background-base">
      {/* title + sub-tabs */}
      <div class="shrink-0 flex items-center gap-2 px-2 h-8 border-b border-border-weak-base bg-background-stronger">
        <span class="text-12-medium text-text-strong">{props.title}</span>
        <Show when={props.side === "response" && props.record?.status != null}>
          <span class={`text-12-regular ${statusClass(props.record!.status)}`}>{props.record!.status}</span>
        </Show>
        <span class="flex-1" />
        {props.toolbar}
      </div>
      <div class="shrink-0 flex items-center gap-0.5 px-1.5 h-7 border-b border-border-weaker-base">
        <For each={subTabs()}>
          {(t) => (
            <button
              type="button"
              class="relative px-2 py-1 text-12-regular cursor-default transition-colors"
              classList={{ "text-text-strong": sub() === t.id, "text-text-weak hover:text-text-base": sub() !== t.id }}
              onClick={() => setSub(t.id)}
            >
              {t.label}
              <Show when={sub() === t.id}>
                <span class="absolute inset-x-1 -bottom-px h-0.5 bg-primary" />
              </Show>
            </button>
          )}
        </For>
        <span class="flex-1" />
        <Tooltip label={wrap() ? "Word wrap: on" : "Word wrap: off"}>
          <button
            type="button"
            aria-label="Toggle word wrap"
            class="grid size-6 place-items-center rounded transition-colors"
            classList={{ "text-primary": wrap(), "text-text-weak hover:text-text-base": !wrap() }}
            onClick={() => setWrap((v) => !v)}
          >
            <WrapIcon />
          </button>
        </Tooltip>
        <CopyButton text={rawText} />
      </div>

      {/* body */}
      <div class="min-h-0 flex-1 overflow-hidden">
        <Switch>
          <Match when={sub() === "headers"}>
            <HeaderTable headers={headers()} editable={props.editable} />
          </Match>
          <Match when={sub() === "cookies"}>
            <CookieTable headers={headers()} side={props.side} />
          </Match>
          <Match when={sub() === "render"}>
            <RenderView record={props.record} body={body()?.text} contentType={ct()} />
          </Match>
          <Match when={props.editable && sub() === "raw"}>
            <RawEditor
              value={props.value ?? ""}
              onInput={(v) => props.onInput?.(v)}
              wrap={wrap()}
              side={props.side}
              lang={lang()}
              search={search().trim()}
            />
          </Match>
          <Match when={sub() === "pretty" && isImageCt(ct()) && body()?.base64}>
            <div class="flex h-full items-center justify-center p-4">
              <img
                src={`data:${ct()};base64,${body()!.base64}`}
                alt="response body"
                class="max-h-full max-w-full object-contain"
              />
            </div>
          </Match>
          <Match when={true}>
            <RawView text={displayText()} side={props.side} lang={lang()} wrap={wrap()} search={search().trim()} />
          </Match>
        </Switch>
      </div>

      {/* search */}
      <Show when={sub() === "raw" || sub() === "pretty"}>
        <div class="shrink-0 flex items-center gap-2 px-2 h-7 border-t border-border-weak-base">
          <SearchIcon />
          <input
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search"
            spellcheck={false}
            class="h-5 min-w-0 flex-1 bg-transparent text-12-regular text-text-base outline-none placeholder:text-text-weak"
          />
          <span class="shrink-0 text-12-regular text-text-weak">{matches()} highlights</span>
        </div>
      </Show>
    </div>
  )
}

// ── raw, line-numbered views ────────────────────────────────────────────────────

// Single continuously line-numbered view of the whole message: start line +
// headers (HTTP-coloured) then the body (coloured for its language).
function RawView(props: { text: string; side: Side; lang: BodyLang; wrap: boolean; search: string }) {
  const lines = createMemo(() => props.text.split("\n"))
  const blankIdx = createMemo(() => lines().indexOf(""))
  const gutterW = createMemo(() => `${String(lines().length).length + 1}ch`)

  return (
    <div class="h-full overflow-auto font-mono text-12-regular leading-relaxed">
      <For each={lines()}>
        {(line, i) => (
          <div class="flex">
            <span
              class="shrink-0 select-none px-2 text-right text-text-weaker"
              style={{ width: `calc(${gutterW()} + 1rem)` }}
            >
              {i() + 1}
            </span>
            <span
              class="min-w-0 flex-1 pr-3 text-text-strong"
              classList={{ "whitespace-pre-wrap break-all": props.wrap, "whitespace-pre": !props.wrap }}
            >
              {props.search
                ? highlightPlain(line, props.search)
                : renderLine(line, i(), blankIdx(), props.side, props.lang)}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

// Editable raw message that still reads like the proxy's read-only view: a
// transparent textarea sits on top of a line-numbered, syntax-coloured underlay,
// the two kept in lockstep by mirroring the textarea's scroll. The textarea owns
// the metrics (gutter width as padding, identical wrap + line-height) so the
// coloured text underneath lines up character-for-character as you type.
function RawEditor(props: {
  value: string
  onInput: (v: string) => void
  wrap: boolean
  side: Side
  lang: BodyLang
  search: string
}) {
  const lines = createMemo(() => props.value.split("\n"))
  const blankIdx = createMemo(() => lines().indexOf(""))
  const gutter = createMemo(() => `calc(${String(lines().length).length + 1}ch + 1rem)`)
  let underlay: HTMLDivElement | undefined

  const sync = (el: HTMLTextAreaElement) => {
    if (!underlay) return
    underlay.scrollTop = el.scrollTop
    underlay.scrollLeft = el.scrollLeft
  }

  return (
    <div class="relative h-full font-mono text-12-regular leading-relaxed">
      <div ref={underlay} aria-hidden class="pointer-events-none absolute inset-0 overflow-hidden text-text-strong">
        <For each={lines()}>
          {(line, i) => (
            <div class="flex">
              <span class="shrink-0 select-none px-2 text-right text-text-weaker" style={{ width: gutter() }}>
                {i() + 1}
              </span>
              <span
                class="min-w-0 flex-1 pr-3"
                classList={{ "whitespace-pre-wrap break-all": props.wrap, "whitespace-pre": !props.wrap }}
              >
                {props.search
                  ? highlightPlain(line, props.search)
                  : renderLine(line, i(), blankIdx(), props.side, props.lang)}
              </span>
            </div>
          )}
        </For>
      </div>
      <textarea
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onScroll={(e) => sync(e.currentTarget)}
        spellcheck={false}
        style={{ "padding-left": gutter(), "padding-right": "0.75rem" }}
        class="absolute inset-0 size-full resize-none overflow-auto bg-transparent leading-relaxed text-transparent caret-text-base outline-none"
        classList={{ "whitespace-pre-wrap break-all": props.wrap, "whitespace-pre": !props.wrap }}
      />
    </div>
  )
}

// ── line rendering ───────────────────────────────────────────────────────────────

function renderLine(line: string, index: number, blankIdx: number, side: Side, lang: BodyLang): JSX.Element {
  if (index === 0) return side === "request" ? renderRequestLine(line) : renderResponseLine(line)
  if (blankIdx >= 0 && index < blankIdx) return renderHeaderLine(line)
  if (blankIdx >= 0 && index > blankIdx) return renderBodyLine(line, lang)
  return line
}

function renderBodyLine(line: string, lang: BodyLang): JSX.Element {
  if (lang === "json") return colorTokens(tokenizeJson(line))
  if (lang === "markup") return colorTokens(tokenizeMarkup(line))
  if (lang === "code") return colorTokens(tokenizeCode(line))
  return line
}

function isImageCt(contentType?: string): boolean {
  return /^image\//i.test(contentType ?? "") && !/svg/i.test(contentType ?? "")
}

function renderRequestLine(line: string): JSX.Element {
  const m = line.match(/^(\S+)(\s+)(\S+)(\s+)?(.*)$/)
  if (!m) return line
  return (
    <>
      <span class={methodClass(m[1])}>{m[1]}</span>
      {m[2]}
      <span class="text-text-strong">{m[3]}</span>
      {m[4] ?? ""}
      <span class="text-text-base">{m[5]}</span>
    </>
  )
}

function renderResponseLine(line: string): JSX.Element {
  const m = line.match(/^(\S+)(\s+)(\d{3})(\s+)?(.*)$/)
  if (!m) return line
  return (
    <>
      <span class="text-text-base">{m[1]}</span>
      {m[2]}
      <span class={statusClass(Number(m[3]))}>{m[3]}</span>
      {m[4] ?? ""}
      <span class="text-text-strong">{m[5]}</span>
    </>
  )
}

function renderHeaderLine(line: string): JSX.Element {
  const i = line.indexOf(":")
  if (i <= 0) return line
  return (
    <>
      <span class="text-syntax-property">{line.slice(0, i)}</span>
      <span class="text-syntax-punctuation">:</span>
      <span class="text-text-strong">{line.slice(i + 1)}</span>
    </>
  )
}

const TOKEN_CLASS: Record<string, string> = {
  key: "text-syntax-property",
  attr: "text-syntax-property",
  string: "text-syntax-string",
  number: "text-syntax-constant",
  keyword: "text-syntax-keyword",
  tag: "text-syntax-keyword",
  punct: "text-syntax-punctuation",
  comment: "text-syntax-comment",
  plain: "text-text-strong",
}
function colorTokens(tokens: { text: string; kind: string }[]): JSX.Element {
  return <For each={tokens}>{(tok) => <span class={TOKEN_CLASS[tok.kind] ?? "text-text-strong"}>{tok.text}</span>}</For>
}

function highlightPlain(line: string, term: string): JSX.Element {
  const lower = line.toLowerCase()
  const t = term.toLowerCase()
  const parts: JSX.Element[] = []
  let i = 0
  let from = 0
  while ((i = lower.indexOf(t, from)) !== -1) {
    if (i > from) parts.push(line.slice(from, i))
    parts.push(<mark class="rounded-sm bg-surface-warning-base text-text-strong">{line.slice(i, i + t.length)}</mark>)
    from = i + t.length
  }
  if (from < line.length) parts.push(line.slice(from))
  return <>{parts}</>
}

// ── sub-tab views ────────────────────────────────────────────────────────────────

function HeaderTable(props: { headers: HeaderPair[]; editable?: boolean }) {
  return (
    <div class="h-full overflow-auto px-3 py-2 font-mono text-12-regular">
      <Show when={props.headers.length} fallback={<span class="text-text-weak">No headers.</span>}>
        <For each={props.headers}>
          {(h) => (
            <div class="flex gap-2 break-all py-0.5">
              <span class="shrink-0 text-syntax-property">{canonicalHeaderName(h.name)}:</span>
              <span class="min-w-0 text-text-strong">{h.value}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function CookieTable(props: { headers: HeaderPair[]; side: Side }) {
  const cookies = createMemo(() => parseCookies(props.headers, props.side))
  return (
    <div class="h-full overflow-auto px-3 py-2 font-mono text-12-regular">
      <Show when={cookies().length} fallback={<span class="text-text-weak">No cookies.</span>}>
        <For each={cookies()}>
          {(c) => (
            <div class="flex gap-2 break-all py-0.5">
              <span class="shrink-0 text-syntax-property">{c.name}</span>
              <span class="text-syntax-punctuation">=</span>
              <span class="min-w-0 text-text-strong">{c.value}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function RenderView(props: { record?: CaptureRecord; body?: string; contentType?: string }) {
  const isHtml = () => /html/i.test(props.contentType ?? "")
  return (
    <Show
      when={isHtml() && props.body}
      fallback={
        <div class="flex h-full items-center justify-center text-12-regular text-text-weak">
          Render is available for HTML responses.
        </div>
      }
    >
      <iframe title="Rendered response" sandbox="" srcdoc={props.body} class="size-full border-0 bg-white" />
    </Show>
  )
}

// ── atoms ────────────────────────────────────────────────────────────────────────

function CopyButton(props: { text: () => string }) {
  const [done, setDone] = createSignal(false)
  return (
    <IconButton
      icon={done() ? "check" : "copy"}
      variant="ghost"
      class="size-6"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(props.text()).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    />
  )
}

function Tooltip(props: { label: string; children: JSX.Element }) {
  return <span title={props.label}>{props.children}</span>
}

function WrapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M3 5h14M3 10h11a3 3 0 010 6h-3m0 0l2-2m-2 2l2 2M3 15h5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class="shrink-0 text-text-weak"
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.5 13.5L17 17" stroke-linecap="round" />
    </svg>
  )
}
