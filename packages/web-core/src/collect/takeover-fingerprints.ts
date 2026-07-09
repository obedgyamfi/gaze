// ── Subdomain-takeover fingerprints ───────────────────────────────────────────
// Known "unclaimed service" signatures. A dangling CNAME pointing at one of these
// services, serving its claim-me page, is a takeover candidate. Body-match only here;
// the Node runtime can add CNAME/NXDOMAIN confirmation for higher confidence.

export interface TakeoverFingerprint {
  service: string
  /** A stable substring of the service's "unclaimed" response body. */
  needle: string
}

export const TAKEOVER_FINGERPRINTS: TakeoverFingerprint[] = [
  { service: "github-pages", needle: "There isn't a GitHub Pages site here." },
  { service: "heroku", needle: "no-such-app.html" },
  { service: "heroku", needle: "No such app" },
  { service: "aws-s3", needle: "The specified bucket does not exist" },
  { service: "aws-s3", needle: "NoSuchBucket" },
  { service: "fastly", needle: "Fastly error: unknown domain" },
  { service: "shopify", needle: "Sorry, this shop is currently unavailable" },
  { service: "ghost", needle: "The thing you were looking for is no longer here" },
  { service: "surge", needle: "project not found" },
  { service: "bitbucket", needle: "Repository not found" },
  { service: "unbounce", needle: "The requested URL was not found on this server" },
  { service: "cargo", needle: "404 Not Found: The requested resource could not be found" },
  { service: "webflow", needle: "The page you are looking for doesn't exist or has been moved" },
]

export interface TakeoverMatch {
  service: string
  needle: string
  confidence: number
}

/** Body-match a takeover fingerprint. Confidence is modest without DNS confirmation. */
export function matchTakeover(body: string): TakeoverMatch | undefined {
  for (const fp of TAKEOVER_FINGERPRINTS) {
    if (body.includes(fp.needle)) return { service: fp.service, needle: fp.needle, confidence: 0.7 }
  }
  return undefined
}
