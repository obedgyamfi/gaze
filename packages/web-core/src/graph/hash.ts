// ── Browser-safe stable hash ──────────────────────────────────────────────────
// The graph builders run in BOTH Node (agent side) and the desktop renderer
// (browser), so they cannot use node:crypto. This is a fast, deterministic
// string→hex hash (cyrb53) used only for stable node ids and de-duplication
// fingerprints — NOT a security boundary. The hard rule ("raw credential never
// enters the graph") is satisfied by never storing the raw value, not by the hash
// being cryptographic.

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** Stable hex fingerprint of a string (≈53-bit, 13 hex chars). Deterministic. */
export function hashHex(input: string): string {
  return cyrb53(input).toString(16).padStart(13, "0")
}
