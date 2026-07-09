// ── Static JS analysis (pure) ─────────────────────────────────────────────────
// Endpoint + secret extraction from a script's SOURCE TEXT. Never executes target
// code (regex/string scanning only). Secrets are returned as fingerprint refs
// (hash + class + entropy) — the raw value is hashed and discarded here, so it can
// never propagate into an Observation, the SPG, or the report.

import { hashHex } from "../graph/hash.js"
import type { SecretClass, SecretRefObs } from "./types.js"

export function shannonEntropy(s: string): number {
  if (!s) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let e = 0
  for (const n of freq.values()) {
    const p = n / s.length
    e -= p * Math.log2(p)
  }
  return Math.round(e * 100) / 100
}

const SECRET_PATTERNS: { class: SecretClass; re: RegExp }[] = [
  { class: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { class: "gcp", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { class: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
  { class: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { class: "bearer", re: /\bbearer\s+[A-Za-z0-9._\-]{16,}\b/gi },
  // conservative generic: an assignment of a long, high-entropy literal to a
  // secret-ish key. Entropy is checked by the caller.
  { class: "generic", re: /(?:secret|token|api[_-]?key|access[_-]?key|password|passwd|client[_-]?secret)["'`]?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi },
]

/** Detect secrets; returns fingerprint refs only (raw values hashed + discarded). */
export function detectSecrets(text: string): SecretRefObs[] {
  const out = new Map<string, SecretRefObs>()
  for (const { class: cls, re } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0]
      const entropy = shannonEntropy(value)
      if (cls === "generic" && entropy < 3.5) continue // skip low-entropy noise
      const hash = hashHex(value)
      if (!out.has(hash)) out.set(hash, { hash, class: cls, entropy })
    }
  }
  return [...out.values()]
}

const ASSET_EXT = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|mp4|webm|pdf)(?:$|\?)/i
const URL_RE = /https?:\/\/[^\s"'`<>()]+/g
const PATH_RE = /["'`](\/[A-Za-z0-9_~.\-/]+(?:\?[^"'`\s]*)?)["'`]/g

/** Extract candidate endpoint URLs from script text; resolves relative paths against
 *  `baseUrl` when given, drops static assets, dedupes, and caps the result. */
export function extractEndpoints(text: string, baseUrl?: string, cap = 500): string[] {
  const found = new Set<string>()
  const add = (raw: string) => {
    if (found.size >= cap) return
    let url = raw
    if (url.startsWith("/")) {
      if (!baseUrl) return
      try {
        url = new URL(url, baseUrl).toString()
      } catch {
        return
      }
    }
    if (!/^https?:\/\//.test(url)) return
    if (url.length > 200) return
    if (ASSET_EXT.test(url)) return
    found.add(url.split("#")[0] ?? url)
  }
  for (const m of text.matchAll(URL_RE)) add(m[0].replace(/[),.'"`]+$/, ""))
  for (const m of text.matchAll(PATH_RE)) if (m[1]) add(m[1])
  return [...found]
}
