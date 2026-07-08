// Remediation + impact guidance per vuln class, for the engagement report. The seed
// KB carries methodology (how to find/confirm); this carries how to fix and why it
// matters — authored here (report-side content), keyed by the web-core VulnClass.

export interface Remediation {
  /** One-line business/technical impact statement. */
  impact: string
  /** Concrete, ordered remediation actions. */
  remediation: string[]
}

const MAP: Record<string, Remediation> = {
  idor: {
    impact:
      "An authenticated user can read or modify records belonging to other users by tampering with an object identifier, leading to unauthorized data disclosure or manipulation.",
    remediation: [
      "Enforce object-level authorization on every request — verify the current principal owns (or is entitled to) the referenced object server-side, not just that they are authenticated.",
      "Do not rely on unpredictable identifiers (UUIDs) as an access control; they are not a substitute for an ownership check.",
      "Centralize the authorization decision in a middleware/policy layer so it cannot be forgotten on new endpoints.",
      "Add automated tests that replay a request with another user's object id and assert a 403.",
    ],
  },
  "access-control": {
    impact:
      "A lower-privileged or unauthenticated actor can reach functionality or data intended for a higher privilege level, breaking the application's trust boundaries.",
    remediation: [
      "Deny by default; require an explicit, server-side authorization check for every privileged route and action.",
      "Validate role/permission on the server for each request — never trust client-supplied role, hidden fields, or UI gating.",
      "Reject method/verb tampering and header overrides (e.g. X-HTTP-Method-Override) unless explicitly supported and authorized.",
      "Log and alert on authorization failures to detect probing.",
    ],
  },
  auth: {
    impact:
      "Weaknesses in authentication allow an attacker to assume another identity or bypass the login boundary, compromising every asset behind it.",
    remediation: [
      "Enforce strong session management: rotate session identifiers on login, bind sessions to a single principal, and expire them server-side.",
      "Apply rate limiting and lockout to credential-handling endpoints to resist brute force and credential stuffing.",
      "Require multi-factor authentication for sensitive accounts and actions.",
      "Invalidate tokens/sessions on logout and password change.",
    ],
  },
  injection: {
    impact:
      "Untrusted input is interpreted as code or query syntax, allowing an attacker to read, alter, or destroy data — or in severe cases execute commands on the server.",
    remediation: [
      "Use parameterized queries / prepared statements or a vetted ORM; never concatenate untrusted input into a query or command.",
      "Validate and canonicalize input against an allow-list; reject unexpected structure early.",
      "Apply least-privilege database and service accounts to limit blast radius.",
      "Escape output for the correct context if dynamic composition is unavoidable.",
    ],
  },
  xss: {
    impact:
      "An attacker can execute script in a victim's browser session, enabling session theft, credential capture, request forgery, and full account takeover in the victim's context.",
    remediation: [
      "Context-aware output encoding for all untrusted data rendered into HTML, attributes, JavaScript, and URLs.",
      "Prefer framework auto-escaping; avoid innerHTML / dangerouslySetInnerHTML with untrusted input.",
      "Deploy a strict Content-Security-Policy as defense in depth (no unsafe-inline, restricted script sources).",
      "Set HttpOnly and Secure on session cookies so script cannot read them.",
    ],
  },
  cors: {
    impact:
      "An overly permissive cross-origin policy lets a malicious website read authenticated responses, exposing user data to any origin the browser will honor.",
    remediation: [
      "Reflect only an explicit allow-list of trusted origins in Access-Control-Allow-Origin; never reflect an arbitrary Origin.",
      "Do not combine Access-Control-Allow-Credentials: true with a wildcard or reflected origin.",
      "Scope allowed methods and headers to the minimum required.",
      "Treat CORS as a browser convenience, not an authorization mechanism — keep server-side access checks.",
    ],
  },
  ssrf: {
    impact:
      "The server can be coerced into making requests to attacker-chosen destinations, exposing internal services, cloud metadata, and otherwise unreachable network segments.",
    remediation: [
      "Validate and allow-list outbound destinations (scheme, host, port); reject internal/link-local/metadata ranges.",
      "Resolve and pin hostnames to prevent DNS-rebinding, and block redirects to disallowed hosts.",
      "Do not send credentials or metadata tokens on user-influenced requests; use a dedicated egress proxy.",
      "Disable unused URL schemes (file://, gopher://, etc.) in the fetching component.",
    ],
  },
  "info-leak": {
    impact:
      "Sensitive data or implementation details are exposed to unauthorized parties, aiding further attacks or directly disclosing confidential information.",
    remediation: [
      "Remove secrets, internal identifiers, stack traces, and verbose errors from responses sent to clients.",
      "Return generic error messages; log details server-side only.",
      "Scope API responses to exactly the fields the caller is authorized to see (avoid over-fetching / mass exposure).",
      "Review caching, headers, and debug endpoints for unintended disclosure.",
    ],
  },
  csrf: {
    impact:
      "An attacker can cause an authenticated user's browser to perform state-changing actions without their intent, forging privileged operations as the victim.",
    remediation: [
      "Require an unpredictable, per-session anti-CSRF token on all state-changing requests and validate it server-side.",
      "Set SameSite=Lax or Strict on session cookies as defense in depth.",
      "Verify Origin/Referer for sensitive actions.",
      "Prefer safe, idempotent methods for reads and never mutate state on GET.",
    ],
  },
}

const DEFAULT: Remediation = {
  impact: "This issue weakens the security posture of the application and should be remediated.",
  remediation: [
    "Review the affected functionality against the referenced testing guidance.",
    "Apply input validation, output encoding, and server-side authorization as appropriate to the class of issue.",
    "Add a regression test that reproduces the finding and asserts the fixed behavior.",
  ],
}

export function remediationFor(vulnClass: string): Remediation {
  return MAP[vulnClass] ?? DEFAULT
}
