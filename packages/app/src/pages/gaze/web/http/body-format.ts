// Content-type-aware body formatting for the HTTP message viewer.

export function isJson(contentType?: string): boolean {
  return !!contentType && contentType.toLowerCase().includes("json")
}

/** Pretty-print JSON when possible; otherwise return the text unchanged. */
export function formatBody(text: string, contentType: string | undefined, pretty: boolean): string {
  if (!pretty) return text
  if (isJson(contentType)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  return text
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
