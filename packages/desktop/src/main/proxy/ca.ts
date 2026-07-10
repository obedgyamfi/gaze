// ── Proxy certificate authority ───────────────────────────────────────────────
// A local CA (Burp-style) for the intercepting proxy. Generated once and persisted;
// the user installs the CA cert on the emulator so HTTPS can be MITM'd. Per-host leaf
// certs are minted on demand (signed by the CA) and cached as TLS SecureContexts.
//
// Keys are pure-JS (node-forge) so there is no native build. One shared leaf key pair
// is reused across all hosts (only the certificate is per-host) — RSA keygen is the
// slow part, so we pay it once, not per connection. The CA private key never leaves
// this machine; only the CA CERT is exported for installation.

import { createSecureContext, type SecureContext } from "node:tls"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import forge from "node-forge"

const { pki, md, random, util } = forge

const CA_SUBJECT = [
  { name: "commonName", value: "GAZE Proxy CA" },
  { name: "organizationName", value: "GAZE" },
  { shortName: "OU", value: "Web Security" },
]

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")
}

function serial(): string {
  // Positive, ≤20-byte hex serial (leading 0 keeps it non-negative for strict parsers).
  return "00" + util.bytesToHex(random.getBytesSync(16))
}

interface CaMaterial {
  caCert: forge.pki.Certificate
  caKey: forge.pki.rsa.PrivateKey
  leaf: forge.pki.rsa.KeyPair
}

export class CertAuthority {
  private readonly leafCache = new Map<string, SecureContext>()
  private readonly leafKeyPem: string

  private constructor(private readonly mat: CaMaterial) {
    this.leafKeyPem = pki.privateKeyToPem(mat.leaf.privateKey)
  }

  /** Load the CA (+ shared leaf key) from `dir`, generating and persisting it on first run. */
  static load(dir: string): CertAuthority {
    mkdirSync(dir, { recursive: true })
    const caCertPath = join(dir, "gaze-ca.crt")
    const caKeyPath = join(dir, "gaze-ca.key")
    const leafKeyPath = join(dir, "gaze-leaf.key")

    if (existsSync(caCertPath) && existsSync(caKeyPath) && existsSync(leafKeyPath)) {
      try {
        return new CertAuthority({
          caCert: pki.certificateFromPem(readFileSync(caCertPath, "utf8")),
          caKey: pki.privateKeyFromPem(readFileSync(caKeyPath, "utf8")) as forge.pki.rsa.PrivateKey,
          leaf: keyPairFromPrivatePem(readFileSync(leafKeyPath, "utf8")),
        })
      } catch {
        /* corrupt on disk — regenerate below */
      }
    }

    const mat = generateCa()
    writeFileSync(caCertPath, pki.certificateToPem(mat.caCert))
    writeFileSync(caKeyPath, pki.privateKeyToPem(mat.caKey))
    writeFileSync(leafKeyPath, pki.privateKeyToPem(mat.leaf.privateKey))
    return new CertAuthority(mat)
  }

  /** The CA certificate in PEM — this is what the user installs on the emulator. */
  caCertPem(): string {
    return pki.certificateToPem(this.mat.caCert)
  }

  /** A TLS server context presenting a freshly-minted, CA-signed cert for `host`. Cached. */
  contextFor(host: string): SecureContext {
    const key = host.toLowerCase()
    let ctx = this.leafCache.get(key)
    if (!ctx) {
      ctx = createSecureContext({ key: this.leafKeyPem, cert: this.mintLeafPem(key) })
      this.leafCache.set(key, ctx)
    }
    return ctx
  }

  /** Default key/cert PEMs for the TLS server — used when a client connects without SNI
   *  (rare; per-host certs come from `contextFor` via SNICallback). */
  defaultCredentials(): { key: string; cert: string } {
    return { key: this.leafKeyPem, cert: this.mintLeafPem("gaze.proxy.local") }
  }

  private mintLeafPem(host: string): string {
    const cert = pki.createCertificate()
    cert.publicKey = this.mat.leaf.publicKey
    cert.serialNumber = serial()
    // Leaf validity MUST stay short. Chrome's built-in verifier and modern Android reject
    // long-lived leaves (even under a locally-trusted CA) as ERR_CERT_AUTHORITY_INVALID —
    // OpenSSL/curl don't enforce this, which is why desktop validation passed but the
    // device didn't. mitmproxy uses ~197 days for exactly this reason; keep total < 200d.
    cert.validity.notBefore = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2d back-date for clock skew
    cert.validity.notAfter = new Date(Date.now() + 197 * 24 * 60 * 60 * 1000) // ~199d total, under the cap
    cert.setSubject([{ name: "commonName", value: host }])
    cert.setIssuer(this.mat.caCert.subject.attributes)
    // Standard leaf profile. The SAN carries the intercepted host; short validity keeps
    // modern clients happy. (Extensions don't affect Android/Chrome trust — the CA install
    // format does; see generateCa.)
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectKeyIdentifier" },
      { name: "authorityKeyIdentifier", keyIdentifier: this.mat.caCert.generateSubjectKeyIdentifier().getBytes() },
      {
        name: "subjectAltName",
        altNames: [isIp(host) ? { type: 7, ip: host } : { type: 2, value: host }],
      },
    ])
    cert.sign(this.mat.caKey, md.sha256.create())
    return pki.certificateToPem(cert)
  }
}

function keyPairFromPrivatePem(pem: string): forge.pki.rsa.KeyPair {
  const privateKey = pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey
  const publicKey = pki.setRsaPublicKey(privateKey.n, privateKey.e)
  return { privateKey, publicKey }
}

function generateCa(): CaMaterial {
  const caKeys = pki.rsa.generateKeyPair(2048)
  const caCert = pki.createCertificate()
  caCert.publicKey = caKeys.publicKey
  caCert.serialNumber = serial()
  // Back-date a year (like Burp's 2014 backdate) so clock skew never makes the anchor
  // "not yet valid".
  caCert.validity.notBefore = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  caCert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
  caCert.setSubject(CA_SUBJECT)
  caCert.setIssuer(CA_SUBJECT)
  // A standard root CA profile. NB: the cert extensions do NOT affect whether Android/
  // Chrome trust the chain — verified by testing minimal vs full-extension certs against the
  // device's BoringSSL. The real Android gotcha is the INSTALL FORMAT: the system CA store
  // (/system/etc/security/cacerts/<hash>.0) must be PEM, not DER, or conscrypt silently
  // skips it. Export via caCertPem() (PEM) and install as-is; never convert to DER.
  caCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ])
  caCert.sign(caKeys.privateKey, md.sha256.create())
  return { caCert, caKey: caKeys.privateKey, leaf: pki.rsa.generateKeyPair(2048) }
}
