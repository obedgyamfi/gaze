// ── API schema parsing (pure) ─────────────────────────────────────────────────
// Turn an OpenAPI/Swagger document or a GraphQL introspection result into concrete
// endpoint descriptors — the surface a UI-only crawl never reaches (where BOLA/BFLA
// live). Tolerant parsing: unknown shapes yield [] rather than throwing.

export interface ParsedEndpoint {
  method: string
  url: string
  params: { name: string; loc: "query" | "path" | "header" | "body" }[]
}

const loc = (where: string): "query" | "path" | "header" | "body" =>
  where === "path" ? "path" : where === "header" || where === "cookie" ? "header" : "query"

const joinUrl = (base: string, path: string): string => {
  if (!base) return path
  const b = base.replace(/\/$/, "")
  return b + (path.startsWith("/") ? path : "/" + path)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseOpenApi(doc: any, fallbackBase?: string): ParsedEndpoint[] {
  if (!doc || typeof doc !== "object" || !doc.paths) return []
  const base: string = doc.servers?.[0]?.url ?? doc.basePath ?? fallbackBase ?? ""
  const methods = ["get", "post", "put", "patch", "delete", "options", "head"]
  const out: ParsedEndpoint[] = []
  for (const [path, itemRaw] of Object.entries<any>(doc.paths)) {
    const item = itemRaw ?? {}
    for (const method of methods) {
      const op = item[method]
      if (!op) continue
      const params = [...(op.parameters ?? []), ...(item.parameters ?? [])]
        .filter((p: any) => p && p.name)
        .map((p: any) => ({ name: String(p.name), loc: loc(String(p.in ?? "query")) }))
      if (op.requestBody) params.push({ name: "body", loc: "body" })
      out.push({ method: method.toUpperCase(), url: joinUrl(base, path), params })
    }
  }
  return out
}

export function parseGraphqlIntrospection(doc: any, endpointUrl: string): ParsedEndpoint[] {
  const schema = doc?.data?.__schema ?? doc?.__schema
  if (!schema) return []
  const types: any[] = schema.types ?? []
  const roots = [schema.queryType?.name, schema.mutationType?.name].filter(Boolean) as string[]
  const out: ParsedEndpoint[] = []
  for (const rootName of roots) {
    const t = types.find((x) => x?.name === rootName)
    for (const f of t?.fields ?? []) {
      if (f?.name) out.push({ method: "POST", url: endpointUrl, params: [{ name: String(f.name), loc: "body" }] })
    }
  }
  return out
}

export function detectSchemaKind(doc: any): "openapi" | "graphql" | "unknown" {
  if (!doc || typeof doc !== "object") return "unknown"
  if (doc.data?.__schema || doc.__schema) return "graphql"
  if (doc.openapi || doc.swagger || doc.paths) return "openapi"
  return "unknown"
}
/* eslint-enable @typescript-eslint/no-explicit-any */
