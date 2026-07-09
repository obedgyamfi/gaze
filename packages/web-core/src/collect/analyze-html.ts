// ── Static HTML analysis (pure) ───────────────────────────────────────────────
// Link / form / script extraction from HTML source text (regex scanning — no DOM,
// no execution). Feeds the crawler frontier and endpoint discovery.

const httpOnly = (raw: string | undefined, baseUrl: string): string | undefined => {
  if (!raw || /^(mailto:|tel:|javascript:|data:|#)/i.test(raw.trim())) return undefined
  try {
    const u = new URL(raw, baseUrl)
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    return u.toString().split("#")[0]
  } catch {
    return undefined
  }
}

const LINK_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi
const SCRIPT_RE = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi
const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi
const ATTR = (tag: string | undefined, name: string): string | undefined =>
  tag ? (new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? undefined) : undefined
const INPUT_NAME_RE = /<(?:input|select|textarea)\b[^>]*?\bname\s*=\s*["']([^"']+)["']/gi

export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(LINK_RE)) {
    const u = httpOnly(m[1], baseUrl)
    if (u) out.add(u)
  }
  return [...out]
}

export function extractScripts(html: string, baseUrl: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(SCRIPT_RE)) {
    const u = httpOnly(m[1], baseUrl)
    if (u) out.add(u)
  }
  return [...out]
}

export interface FormObs {
  method: string
  action: string
  params: string[]
}

export function extractForms(html: string, baseUrl: string): FormObs[] {
  const forms: FormObs[] = []
  for (const m of html.matchAll(FORM_RE)) {
    const attrs = m[1]
    const inner = m[2] ?? ""
    const action = httpOnly(ATTR(attrs, "action"), baseUrl) ?? baseUrl.split("#")[0] ?? baseUrl
    const method = (ATTR(attrs, "method") ?? "GET").toUpperCase()
    const params = [...new Set([...inner.matchAll(INPUT_NAME_RE)].map((i) => i[1]).filter((x): x is string => !!x))]
    forms.push({ method, action, params })
  }
  return forms
}
