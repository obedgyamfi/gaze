// ── Knowledge base — methodology retrieval + candidate seeding ────────────────
// The web-pentest methodology layer (WSTG-flavored). Distinct from the attack
// graph: static, shared across engagements, the thing that says WHAT to test and
// WHY. `candidatesFor` is the deterministic, observation-grounded planner seed.
// This seed covers the nine Phase-1 vuln classes; richer prose lives in the
// plugin's skills layer (this stays a queryable structured index).

import type { NodeKind, RiskLevel, VulnClass } from "./types.js"

export interface KbProcedure {
  id: string
  title: string
  vulnClass: VulnClass
  steps: string[]
  lookFor: string[]
  preconditions: string[]
  refs: string[]
}

export interface KbCandidate {
  vulnClass: VulnClass
  why: string
  confidence: "high" | "medium"
  methodologyRef: string
}

export interface KbPayloadTemplate {
  id: string
  vulnClass: VulnClass
  template: string
  notes: string
  refs: string[]
}

export interface KbNode {
  kind: NodeKind
  tags: string[]
  method?: string
  url?: string
  risk?: RiskLevel
}

export interface KnowledgeBase {
  query(input: { vulnClass?: VulnClass; nodeKind?: NodeKind; q?: string; tags?: string[] }): KbProcedure[]
  candidatesFor(node: KbNode): KbCandidate[]
  payloads(vulnClass: VulnClass): KbPayloadTemplate[]
}

const SEED: KbProcedure[] = [
  {
    id: "wstg-idor",
    title: "Insecure Direct Object Reference (IDOR)",
    vulnClass: "idor",
    steps: [
      "Identify an endpoint that references an object by id (path or query param).",
      "Replay the SAME authenticated session but substitute another owner's id.",
      "Compare baseline (your object) vs test (their object) via the oracle.",
    ],
    lookFor: ["200 on another owner's id", "different response body for substituted id", "no authorization re-check"],
    preconditions: ["an authenticated session", "an object-id parameter"],
    refs: ["WSTG-ATHZ-04"],
  },
  {
    id: "wstg-authz-forced-browse",
    title: "Access control / forced browsing",
    vulnClass: "access-control",
    steps: ["Find an endpoint that is 401/403 for your role.", "Replay with method/role tampering.", "Oracle: denied→allowed is a boundary crossing."],
    lookFor: ["401/403 → 200", "privileged action accepted", "method override (X-HTTP-Method-Override) honored"],
    preconditions: ["a denied endpoint to test against"],
    refs: ["WSTG-ATHZ-02"],
  },
  {
    id: "wstg-cors",
    title: "CORS misconfiguration",
    vulnClass: "cors",
    steps: ["Check Access-Control-Allow-Origin reflection.", "Test wildcard + credentials.", "Confirm cross-origin read is possible."],
    lookFor: ["ACAO: *", "ACAO reflects arbitrary Origin with ACAC: true"],
    preconditions: ["a cross-origin readable endpoint"],
    refs: ["WSTG-CLNT-07"],
  },
  {
    id: "wstg-auth",
    title: "Authentication weaknesses",
    vulnClass: "auth",
    steps: ["Inspect auth flow + token handling.", "Test session fixation / weak token.", "Test auth bypass on protected routes."],
    lookFor: ["token in URL", "missing auth on sensitive route", "predictable/long-lived token"],
    preconditions: ["an authentication mechanism"],
    refs: ["WSTG-ATHN-01"],
  },
  {
    id: "wstg-csrf",
    title: "Cross-Site Request Forgery",
    vulnClass: "csrf",
    steps: ["Find a state-changing form/endpoint.", "Check for an anti-CSRF token.", "Test whether the action succeeds without it."],
    lookFor: ["no CSRF token on a state-changing form", "action accepted cross-site", "SameSite=None cookie"],
    preconditions: ["a state-changing request"],
    refs: ["WSTG-SESS-05"],
  },
  {
    id: "wstg-injection-sql",
    title: "SQL / command injection",
    vulnClass: "injection",
    steps: ["Map parameters that reach a backend query.", "Send a benign breaking token + a timing canary.", "Oracle: error-class change or timing blowup vs baseline."],
    lookFor: ["DB error reflected", "boolean-state difference", "time-based delay on a sleep payload"],
    preconditions: ["a parameter that influences a query"],
    refs: ["WSTG-INPV-05", "WSTG-INPV-12"],
  },
  {
    id: "wstg-xss",
    title: "Cross-Site Scripting (reflected/stored)",
    vulnClass: "xss",
    steps: ["Find a parameter reflected into HTML/JS.", "Plant a unique canary marker.", "Oracle: the canary reflected un-encoded in the response."],
    lookFor: ["canary reflected without HTML/JS encoding", "content-type text/html with reflected input"],
    preconditions: ["a reflected parameter", "an HTML response context"],
    refs: ["WSTG-INPV-01", "WSTG-INPV-02"],
  },
  {
    id: "wstg-ssrf",
    title: "Server-Side Request Forgery / open redirect",
    vulnClass: "ssrf",
    steps: ["Find a parameter holding a URL (url/next/redirect/callback).", "Point it at an in-scope canary collaborator.", "Confirm server-side fetch or redirect."],
    lookFor: ["server fetches the supplied URL", "redirect to an attacker-controlled host", "internal metadata reachable"],
    preconditions: ["a URL-valued parameter"],
    refs: ["WSTG-INPV-19"],
  },
  {
    id: "wstg-info-leak",
    title: "Information disclosure",
    vulnClass: "info-leak",
    steps: ["Trigger error/edge responses.", "Inspect verbose errors, stack traces, headers.", "Check for secrets/PII in bodies."],
    lookFor: ["stack trace / framework error", "Server / X-Powered-By version leak", "secrets or PII in JSON"],
    preconditions: ["an endpoint that can be coerced into an error/verbose path"],
    refs: ["WSTG-ERRH-01", "WSTG-CONF-02"],
  },
]

const SSRF_PARAM = /[?&](url|uri|next|redirect|dest|destination|callback|return|returnto|target|to|continue|image|feed|host)=/i
const ID_PARAM = /\/\d+(\/|$)|[?&](id|user|userid|uid|account|acct|order|orderid|pid|doc|file|key)=/i

export function createSeedKnowledgeBase(): KnowledgeBase {
  const byClass = (vc: VulnClass) => SEED.filter((p) => p.vulnClass === vc)
  return {
    query(input) {
      const q = input.q?.toLowerCase()
      return SEED.filter((p) => {
        if (input.vulnClass && p.vulnClass !== input.vulnClass) return false
        if (q && !`${p.title} ${p.steps.join(" ")} ${p.lookFor.join(" ")} ${p.refs.join(" ")}`.toLowerCase().includes(q)) return false
        return true
      })
    },

    candidatesFor(node) {
      const out: KbCandidate[] = []
      const has = (t: string) => node.tags.includes(t)
      const url = node.url ?? ""
      const hasQuery = url.includes("?")
      const mutating = node.method != null && ["POST", "PUT", "PATCH", "DELETE"].includes(node.method.toUpperCase())
      const testable = node.kind === "Endpoint" || node.kind === "Form" || node.kind === "EndpointTemplate"
      const objectId = has("object-id") || ID_PARAM.test(url)

      // ── IDOR / access-control — graph-correlated signals first, then per-node ──
      if (has("multi-principal") && objectId) {
        out.push({ vulnClass: "idor", why: "the SPG saw this id-bearing resource served to ≥2 principals — replay one owner's id under another's session", confidence: "high", methodologyRef: "wstg-idor" })
      } else if (testable && objectId) {
        out.push({ vulnClass: "idor", why: "references an object id — substitute another owner's id under the same session", confidence: "high", methodologyRef: "wstg-idor" })
      }
      if (node.kind === "EndpointTemplate" && has("enumerable")) {
        out.push({ vulnClass: "access-control", why: "enumerable id family (multiple instances observed) — walk the id range for objects you shouldn't reach", confidence: "medium", methodologyRef: "wstg-authz-forced-browse" })
      }

      // ── taint-derived signals (data-flow pass) ──
      if (has("reflected")) {
        out.push({ vulnClass: "xss", why: "a request value was echoed un-encoded in the response — likely reflected XSS", confidence: "high", methodologyRef: "wstg-xss" })
      }
      if (has("cross-boundary-leak")) {
        out.push({ vulnClass: "info-leak", why: "a secret/token flowed to a different trust zone — possible credential leak / exfiltration", confidence: "high", methodologyRef: "wstg-info-leak" })
      }

      // ── injection / xss / ssrf — driven by typed parameters ──
      if (testable && (hasQuery || has("param:opaque") || has("param:numeric-id"))) {
        out.push({ vulnClass: "injection", why: "user-controlled parameter may reach a backend query", confidence: "medium", methodologyRef: "wstg-injection-sql" })
        out.push({ vulnClass: "xss", why: "reflected parameter — test for un-encoded reflection", confidence: "medium", methodologyRef: "wstg-xss" })
      }
      if (has("param:url") || SSRF_PARAM.test(url)) {
        out.push({ vulnClass: "ssrf", why: "a parameter holds a URL — test server-side fetch / open redirect", confidence: "medium", methodologyRef: "wstg-ssrf" })
      }

      // ── auth / cors / csrf / info-leak ──
      if (has("auth")) {
        out.push({ vulnClass: "auth", why: "auth material observed on this node", confidence: "medium", methodologyRef: "wstg-auth" })
        out.push({ vulnClass: "access-control", why: "authenticated endpoint — test role/method boundary", confidence: "medium", methodologyRef: "wstg-authz-forced-browse" })
      }
      if (has("cors-wildcard")) out.push({ vulnClass: "cors", why: "Access-Control-Allow-Origin: * observed", confidence: "high", methodologyRef: "wstg-cors" })
      if (node.kind === "Form" && mutating && !has("csrf-token")) out.push({ vulnClass: "csrf", why: "state-changing form with no anti-CSRF token observed", confidence: "medium", methodologyRef: "wstg-csrf" })
      if (has("html") && hasQuery) out.push({ vulnClass: "xss", why: "reflected parameter in an HTML response context", confidence: "medium", methodologyRef: "wstg-xss" })
      if (has("json") && (node.risk === "high" || node.risk === "critical")) out.push({ vulnClass: "info-leak", why: "high-risk JSON endpoint — inspect for verbose errors / secrets", confidence: "medium", methodologyRef: "wstg-info-leak" })

      // First (highest-confidence) candidate per vuln class wins.
      const seen = new Set<VulnClass>()
      return out.filter((c) => (seen.has(c.vulnClass) ? false : (seen.add(c.vulnClass), true)))
    },

    payloads(vulnClass) {
      // Abstract, parameterized templates only — the replay engine instantiates within ROE.
      const map: Partial<Record<VulnClass, KbPayloadTemplate[]>> = {
        idor: [{ id: "idor-id-swap", vulnClass: "idor", template: "{baseline_url with id => another owner's id}", notes: "replay under the SAME session; compare via the oracle", refs: ["WSTG-ATHZ-04"] }],
        cors: [{ id: "cors-origin-reflect", vulnClass: "cors", template: "Origin: https://attacker.example", notes: "check ACAO reflection + ACAC: true", refs: ["WSTG-CLNT-07"] }],
        injection: [
          { id: "sqli-boolean", vulnClass: "injection", template: "{param}=' OR '1'='1  vs  {param}=' AND '1'='2", notes: "boolean-state differential via the oracle", refs: ["WSTG-INPV-05"] },
          { id: "sqli-time", vulnClass: "injection", template: "{param}=…;SLEEP(5)--", notes: "time-based; oracle flags the latency spike", refs: ["WSTG-INPV-05"] },
        ],
        xss: [{ id: "xss-canary", vulnClass: "xss", template: "{param}=<m4rker>{canary}</m4rker>", notes: "plant a unique canary; oracle confirms un-encoded reflection", refs: ["WSTG-INPV-01"] }],
        ssrf: [{ id: "ssrf-collaborator", vulnClass: "ssrf", template: "{url_param}=http://{in-scope-collaborator}/{canary}", notes: "confirm a server-side fetch to the collaborator", refs: ["WSTG-INPV-19"] }],
        "access-control": [{ id: "ac-method-override", vulnClass: "access-control", template: "X-HTTP-Method-Override: {privileged-method}", notes: "replay a denied request with method tampering", refs: ["WSTG-ATHZ-02"] }],
      }
      return map[vulnClass] ?? byClass(vulnClass).map((p) => ({ id: `${p.id}-generic`, vulnClass, template: "(no parameterized payload; follow the procedure)", notes: p.title, refs: p.refs }))
    },
  }
}
