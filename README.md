<h1 align="center">Gaze</h1>

<p align="center">
  <b>An agent-driven web application security workbench.</b><br>
  Point it at an authorized target, browse, and Gaze turns live traffic into a living
  map of the attack surface — then helps confirm real, exploitable findings.
</p>

<p align="center">
  <img alt="Status" src="https://img.shields.io/badge/status-active%20development-orange?style=flat-square">
  <img alt="Desktop" src="https://img.shields.io/badge/desktop-Electron-informational?style=flat-square">
  <img alt="Engine" src="https://img.shields.io/badge/engine-TypeScript%20(pure%20core)-3178c6?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
</p>

<img width="1918" height="1030" alt="gaze_demo" src="https://github.com/user-attachments/assets/9c0bba33-0a22-42c0-8b3c-19a71fecbbfb" />

---

## Why Gaze

Modern app security work is mostly a fight against volume and context loss. You proxy
hundreds of requests, but the structure — which hosts, which endpoints, which parameters
are enumerable, where a secret leaked, which trust boundary a value crossed — lives only
in the tester's head. Classic tools (a proxy, a repeater, a wordlist) capture traffic;
they don't capture understanding.

Gaze is an attempt to close that gap. It treats an engagement as a graph that grows as you
work: every captured request, crawled link, analyzed script, and discovered parameter
folds into one security-property graph of the target. On top of that graph sits an AI
agent that can drive the same tooling a human does — crawl, discover, analyze, replay, and
confirm candidate issues — while a hard scope kernel guarantees it never touches anything
it wasn't authorized to.

The goals:

- See the whole surface, not one request at a time. Capture and recon continuously build a
  single, navigable map.
- Confirm, don't guess. Findings come from oracles that must produce evidence — the design
  target is no false positives.
- Stay inside the lines. Every outbound connection passes a deny-by-default scope check
  first; this is the tool's ethical and legal boundary, not an afterthought.
- Let the agent do the tedious parts. The human sets scope and intent; the agent runs the
  breadth-first grind.

## The workbench

Gaze is a desktop app. The Web module is a set of tools that share one live capture and one
graph, so a request you see in the Proxy is the same node you inspect in the Graph.

- **Graph** — a tidy, real-time map of everything the target exposed: domains, paths,
  endpoints, and resources, plus enriched layers (identities, parameters, tainted values,
  trust zones). Composable lenses and overlays change what the map emphasizes; clicking a
  node opens every request behind it.
- **Proxy** — a full-fidelity, Burp-style history of every observed request/response,
  unredacted: complete on-the-wire headers (cookies, authorization), decoded bodies, and
  the request initiator (the JS call stack that fired it). Capture works from a launched,
  instrumented Chromium and from an intercepting HTTP(S) proxy for devices/emulators.
- **Repeater** — take any captured request into an editable raw editor, tweak it, and fire
  it back through the scoped runtime; every replay is recorded into the same log and graph.
- **Findings** — confirmed issues flow into a dashboard with severity scoring, remediation
  guidance, and exportable HTML reports.

Also in the module: an Overview launcher (start a scoped engagement), a Canvas scratch
surface, and the Interceptor.

## How it works

The engine is `@morgana/web-core` — a pure, headless, test-covered TypeScript core that
knows nothing about the UI. The desktop app (Electron) wires it to a real browser, a worker
pool, and the agent.

```
            authorized scope
                   │
   ┌───────────────▼────────────────┐
   │  ScopeGuard  (deny-by-default)  │  ← every outbound connection asks first
   └───────────────┬────────────────┘
                   │
        ┌──────────▼──────────┐        ┌───────────────────────────┐
        │  Collectors          │        │  Scheduler                │
        │  capture · crawl ·   │◄──────►│  per-host rate + concurr. │
        │  content/param disc. │        │  politeness & WAF-survival│
        │  JS/HTML analysis ·  │        └───────────────────────────┘
        │  API/GraphQL import ·│
        │  subdomain-takeover  │
        └──────────┬───────────┘
                   │ Observation deltas (endpoint·param·asset·service·cert·js·secret·takeover)
        ┌──────────▼───────────┐
        │  Security-Property    │  one incremental graph the UI *and* the agent read
        │  Graph  (fold + taint)│  identities · parameters · tainted values · trust zones
        └──────────┬───────────┘
                   │ candidates (IDOR · enumeration · SSRF · reflected-XSS · info-leak · race · logic)
        ┌──────────▼───────────┐
        │  Oracles              │  confirm(candidate) → evidence  (no evidence ⇒ no finding)
        └──────────┬───────────┘
                   │
             Findings → scoring → report
```

Five seams carry the whole design (`web-core/collect`):

1. ScopeGuard — the egress security kernel. Host globs, CIDRs, port allow-lists, and
   `denyPrivate` (blocks RFC1918/loopback/link-local incl. cloud metadata). In the Node
   runtime it also resolves and pins the IP and re-checks on every redirect hop
   (SSRF / DNS-rebinding defense).
2. Scheduler — the single owner of all outbound work: per-host token bucket + concurrency
   caps + priority queue + cancellation. One knob for both politeness and surviving WAFs.
3. Collectors — surface producers (capture, crawler, content/param discovery, static
   JS/HTML analysis, API/GraphQL schema import, subdomain-takeover). They emit incremental
   Observation deltas — nothing re-materializes.
4. Oracles — finding confirmers (differential-replay, race-condition, business-logic). Each
   must return evidence or null; the bar is no false positives.
5. foldObservation — idempotent merge of observations into the security-property graph, so
   the agent and the UI always see one attack surface.

Process model: the Node main process owns the DNS-pinned HTTP runtime and scheduler;
CPU-heavy and untrusted parsing (JS/HTML ASTs, wordlists) runs in network-less worker
processes — the target's code is parsed, never executed; the agent drives everything
through tools (`web_crawl`, `web_discover_content`, `web_analyze_js`, `web_race`,
`web_scenario_run`, `recon_takeover_check`, and so on).

## Responsible use

Gaze is for authorized security testing only — your own systems, or targets you have
explicit written permission to test (for example, an in-scope bug-bounty program). The
safety model is built into the architecture, not bolted on:

- Deny-by-default egress. No module can open a connection except through a client that
  passes `ScopeGuard.assert()` first. Every active run requires a defined scope.
- Secrets never enter the graph. Producers emit a fingerprint reference, never the value;
  credentials used for auth testing are encrypted at rest and redacted from captures and
  reports.
- Never execute target code. JS/asset analysis is static-parse-only, inside workers with no
  network handle.

You are responsible for ensuring you have authorization for any target you point it at.

## Tech stack

- Engine — TypeScript, pure/headless (`@morgana/web-core`), extensively unit-tested.
- Desktop — Electron; live capture over the Chrome DevTools Protocol plus an intercepting
  HTTP(S) proxy.
- UI — SolidJS renderer (graph on a canvas force layout, Burp-style HTTP viewer).
- Agent — the OpenCode agent runtime, driving the security tools over MCP.

## Project status

Active development. The engine foundation is landed and covered by tests — the scope
kernel, scheduler, collectors (crawler, content/param discovery, JS/HTML analysis,
API-schema import, subdomain-takeover), the differential-replay / race / business-logic
oracles, and the enriched + taint graph layers all live headless with fixture tests. The
desktop workbench (capture, Graph, Proxy, Repeater, Findings) is wired on top. Some pieces
noted in the design docs are still in progress or intentionally deferred (for example,
out-of-band/OAST and watch mode). Design docs live in [`packages/web-core/docs`](packages/web-core/docs).

## Built on OpenCode

Gaze is a fork of [OpenCode](https://opencode.ai) (MIT) — it reuses OpenCode's agent
runtime and desktop shell as the foundation and adds the `@morgana/web-core` security
engine and the Web workbench on top. Full credit to the OpenCode authors; the original
project READMEs (English and translations) are preserved under
[`docs/opencode-readme-translations/`](docs/opencode-readme-translations/).

## License

MIT — see [`LICENSE`](LICENSE). Original OpenCode copyright is retained; additions in this
fork are © their respective author.
