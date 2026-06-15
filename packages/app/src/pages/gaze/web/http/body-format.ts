// Content-type-aware body formatting + light tokenizers for the HTTP viewer.

export function isJson(contentType?: string): boolean {
  return !!contentType && /json|\+json/i.test(contentType)
}

export function isHtml(contentType?: string): boolean {
  return !!contentType && /html/i.test(contentType)
}

export function isXml(contentType?: string): boolean {
  return !!contentType && /xml/i.test(contentType) && !/html/i.test(contentType)
}

export function isUrlEncoded(contentType?: string): boolean {
  return !!contentType && /x-www-form-urlencoded/i.test(contentType)
}

/** Pretty-print structured bodies (JSON, XML, url-encoded forms). Unstructured
 *  bodies (incl. HTML — use Render) are returned unchanged. */
export function formatBody(text: string, contentType: string | undefined, pretty: boolean): string {
  if (!pretty) return text
  if (isJson(contentType)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  if (isUrlEncoded(contentType)) return formatUrlEncoded(text)
  if (isXml(contentType)) return formatXml(text)
  return text
}

function formatUrlEncoded(text: string): string {
  return text
    .split("&")
    .map((pair) => {
      const i = pair.indexOf("=")
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "))
        } catch {
          return s
        }
      }
      return i < 0 ? dec(pair) : `${dec(pair.slice(0, i))} = ${dec(pair.slice(i + 1))}`
    })
    .join("\n")
}

/** Conservative XML indenter: one tag per line, indented by nesting depth. */
function formatXml(text: string): string {
  const flat = text.replace(/>\s+</g, "><").replace(/></g, ">\n<")
  let depth = 0
  const out: string[] = []
  for (const raw of flat.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (/^<\/[^>]+>/.test(line)) depth = Math.max(0, depth - 1)
    out.push("  ".repeat(depth) + line)
    const opens = /^<[^!?/][^>]*[^/]>$/.test(line)
    const selfClose = /\/>$/.test(line)
    const inlineClose = /<\/[^>]+>$/.test(line)
    if (opens && !selfClose && !inlineClose) depth++
  }
  return out.join("\n")
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Parse a raw query string (no leading `?`) into ordered name/value pairs. */
export function parseParams(query?: string): { name: string; value: string }[] {
  if (!query) return []
  const out: { name: string; value: string }[] = []
  try {
    for (const [name, value] of new URLSearchParams(query)) out.push({ name, value })
  } catch {
    // tolerate malformed query strings
  }
  return out
}

export type TokenKind = "key" | "string" | "number" | "keyword" | "punct" | "comment" | "tag" | "attr" | "plain"
export interface JsonToken {
  text: string
  kind: TokenKind
}

export type BodyLang = "json" | "markup" | "code" | "text"

export function bodyLang(contentType?: string): BodyLang {
  const c = (contentType ?? "").toLowerCase()
  if (/json/.test(c)) return "json"
  if (/html|xml|svg/.test(c)) return "markup"
  if (/javascript|ecmascript|typescript|(^|\W)css(\W|$)|json5/.test(c)) return "code"
  return "text"
}

const MARKUP_RE =
  /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>)|(<\/?[a-zA-Z][\w:-]*)|([\w:-]+)(=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/?>)|(&[a-zA-Z#0-9]+;)/g

/** Per-line markup (HTML/XML) tokenizer — tags, attributes, strings, comments. */
export function tokenizeMarkup(line: string): JsonToken[] {
  const out: JsonToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  MARKUP_RE.lastIndex = 0
  while ((m = MARKUP_RE.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), kind: "plain" })
    if (m[1] !== undefined) out.push({ text: m[1], kind: "comment" })
    else if (m[2] !== undefined) out.push({ text: m[2], kind: "tag" })
    else if (m[3] !== undefined) {
      out.push({ text: m[3], kind: "attr" }, { text: m[4], kind: "punct" }, { text: m[5], kind: "string" })
    } else if (m[6] !== undefined) out.push({ text: m[6], kind: "tag" })
    else if (m[7] !== undefined) out.push({ text: m[7], kind: "keyword" })
    last = MARKUP_RE.lastIndex
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: "plain" })
  return out
}

const CODE_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null|undefined|function|return|const|let|var|if|else|for|while|switch|case|new|class|extends|import|export|from|default|async|await|yield|this|typeof|instanceof)\b|([{}()[\];:,.=<>+\-*/%!&|?])/g

/** Per-line generic code (JS/TS/CSS) tokenizer — strings, numbers, keywords,
 *  comments, punctuation. Multi-line strings/comments are approximate. */
export function tokenizeCode(line: string): JsonToken[] {
  const out: JsonToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  CODE_RE.lastIndex = 0
  while ((m = CODE_RE.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), kind: "plain" })
    if (m[1] !== undefined) out.push({ text: m[1], kind: "comment" })
    else if (m[2] !== undefined) out.push({ text: m[2], kind: "string" })
    else if (m[3] !== undefined) out.push({ text: m[3], kind: "number" })
    else if (m[4] !== undefined) out.push({ text: m[4], kind: "keyword" })
    else if (m[5] !== undefined) out.push({ text: m[5], kind: "punct" })
    last = CODE_RE.lastIndex
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: "plain" })
  return out
}

const JSON_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])/g

/** Tokenize pretty-printed JSON for lightweight syntax colouring. Covers the
 *  whole string (plain gaps included) so it round-trips losslessly. */
export function tokenizeJson(src: string): JsonToken[] {
  const tokens: JsonToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  JSON_RE.lastIndex = 0
  while ((m = JSON_RE.exec(src))) {
    if (m.index > last) tokens.push({ text: src.slice(last, m.index), kind: "plain" })
    if (m[1] !== undefined) {
      tokens.push({ text: m[1], kind: m[2] !== undefined ? "key" : "string" })
      if (m[2] !== undefined) tokens.push({ text: m[2], kind: "punct" })
    } else if (m[3] !== undefined) {
      tokens.push({ text: m[3], kind: "number" })
    } else if (m[4] !== undefined) {
      tokens.push({ text: m[4], kind: "keyword" })
    } else if (m[5] !== undefined) {
      tokens.push({ text: m[5], kind: "punct" })
    }
    last = JSON_RE.lastIndex
  }
  if (last < src.length) tokens.push({ text: src.slice(last), kind: "plain" })
  return tokens
}
