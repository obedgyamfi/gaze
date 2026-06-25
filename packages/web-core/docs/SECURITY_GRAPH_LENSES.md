# Security Graph & Lenses — Design

> Status: **building — Foundation in progress**. Source of truth for the graph
> redesign. Implementation tracks the staging in §8.
>
> **Landed (web-core, headless + fixture-tested):**
> - **Identity/param/template layer** — `Principal` / `Parameter` / `EndpointTemplate`
>   nodes; `ACCESSED_BY` / `HAS_PARAM` / `INSTANCE_OF` edges; principal fingerprinting
>   (hash only, no credential); endpoint templating; cross-request `enumerable` /
>   `multi-principal` / `object-id` tags. `graph/enriched.ts` + `enriched.test.ts`.
> - **Taint layer** — `Value` / `TrustZone` nodes; `FLOWS_TO` / `REFLECTS` / `IN_ZONE`
>   edges; fingerprinted secret/email/uuid values; reflected-input detection;
>   cross-boundary leak detection; host→zone bucketing. Async body-correlated pass
>   wired into the store (bounded body fetch). `graph/taint.ts` + `taint.test.ts`.
> - `candidatesFor` fires off all of the above (IDOR / enumeration / SSRF / reflected
>   XSS / cross-boundary info-leak).
>
> - **UI seam + lens scaffold (desktop renderer)** — `@morgana/web-core` linked into
>   `@opencode-ai/app`; `useSecurityGraph()` memoizes the SPG over the capture context
>   (one source of truth for UI + agent). Lens contract + registry + two terrains
>   (Attack Surface, Identity & Access bipartite); risk-heat overlay; `LayerSwitcher`
>   corner control wired into the graph page. `graph/use-security-graph.ts`,
>   `graph/lenses/*`, `graph/layer-switcher.tsx`.
>
> **Next increments:** the remaining four terrains (API & Parameters, Data Flow,
> Trust Boundaries, Attack Paths — needs the async taint pass surfaced into the UI),
> `RenderGraph` regions/shape on the canvas, and per-lens camera.

> **Desktop note:** `packages/app` is the Electron renderer the desktop loads, so all
> UI-lens work ships in the desktop build. `@morgana/web-core` is the shared engine
> for both the renderer (lenses) and the in-process agent tools.

## Thesis

Today the UI graph is a **navigation graph** — a tidy `Root → Domain → /path → leaf`
sitemap colored by resource category. It answers *"what did the browser load."*
Vulnerabilities don't live there. They live in **who can reach what** (identity),
**what flows where** (data flow / taint), and **where data crosses a privilege
level** (trust boundaries) — none of which the current model can express.

This redesign does two things:

1. Evolves the model into a **Security Property Graph (SPG)** — the runtime/DAST
   analog of a code property graph — adding the security-typed nodes and edges that
   make vulnerability hunting a graph-reachability problem.
2. Turns the single UI graph into **one model projected through many switchable
   lenses** — like changing the terrain on a map. A layer switcher in the corner
   swaps between six topologies, all backed by the same SPG.

The same SPG backs **both** the UI lenses and the agent's read tools, so the picture
the operator navigates and the graph the agent reasons over never drift.

---

## 1. Architecture principle: one model, many lenses

There is exactly one graph — the SPG — and it is the single source of truth.
Everything the user switches between is a **lens**: a pure projection of that one
graph into a different topology. Roads, satellite, terrain are the same coordinates
rendered differently; so are our lenses.

Two facts make this cheap:

- **The renderer is already lens-agnostic.** `packages/app/.../graph/graph-canvas.tsx`
  uses `force-graph` only as a frozen canvas host: node positions are driven
  externally, and the reconcile loop *eases* each node from its old `x/y` toward a
  new target each frame. That easing **is** the terrain-switch animation — hand it a
  different layout for the same node IDs and it morphs.
- **Today's `buildTree` becomes one lens, not the model.** `graph-model.ts` is
  demoted to the "Attack Surface" lens — a sibling of the other five.

---

## 2. The model layer — Security Property Graph (SPG)

The SPG is built headless in `@morgana/web-core` (`graph/enriched.ts`), captures in →
graph out, pure and fixture-testable. It promotes security-relevant things out of URL
strings and headers into first-class nodes, and adds edges that carry meaning.

### 2.1 Node kinds

| Node | Carries | Why it matters |
|---|---|---|
| `Domain` | host, origin | scope root *(existing)* |
| `Page` / `Resource` / `Form` / `ExternalService` | url, status, tags | structural surface *(existing)* |
| `Endpoint` + `EndpointTemplate` | method, template (`/orders/{id}`), instances | testable surface; templating kills leaf-explosion and enables enumeration detection |
| **`Principal`** | session/role **fingerprint** (never the credential) | the access subject — IDOR, access-control, priv-esc are all principal↔resource relations |
| **`Parameter`** | name, location (path/query/header/body), value-class | reuse across endpoints is where IDOR/injection/mass-assignment candidates come from |
| **`Value` / `Secret`** | token/PII **fingerprint** | anchors taint (`FLOWS_TO`) edges without holding the secret |
| **`TrustZone`** | first-party / third-party / internal / pre-auth / post-auth | the boundary a dangerous edge crosses |

### 2.2 Edge kinds

Structural (existing): `HOSTS`, `NAVIGATES_TO`, `CALLS`, `LOADS`, `SUBMITS_TO`,
`REDIRECTS_TO`, `CROSS_ORIGIN_CALL`.

Security (new):

| Edge | From → To | Detection it powers |
|---|---|---|
| `AUTHENTICATED_AS` | request → Principal | attributes traffic to a subject |
| `ACCESSED_BY` | Resource ← Principal | the access matrix — IDOR/BOLA, access-control |
| `HAS_PARAM` | Endpoint → Parameter | parameter surface |
| `FLOWS_TO` | Value/Param → request | **taint** — XSS, SSRF, secret leak |
| `REFLECTS` | Parameter → response | reflected XSS / injection seed |
| `CROSSES_BOUNDARY` | annotation on any edge leaving a zone | CSRF, CORS, exfiltration |
| `CORRELATES` / `SAME_VALUE` | Parameter instance ↔ instance | id reuse, enumeration |
| `INSTANCE_OF` | Endpoint instance → Template | collapse near-duplicates |

### 2.3 Hard-rule compliance

Per `CLAUDE.md` rule #1 ("credentials never enter the graph"): `Principal` and
`Secret`/`Value` nodes store a **hash / reference / fingerprint only** — never the
raw token, cookie, or PII. Replay still fires from wherever the credential actually
lives. Identity is modeled by *distinguishability*, not by holding the secret.

### 2.4 Candidate generation becomes graph-pattern queries

Today `kb.candidatesFor(node)` scores **one node in isolation** against URL regexes —
linear, low-signal. In the SPG, candidates come from **graph patterns**, and every
new capture enriches edges that light up many patterns at once. This is the
multiplier.

| Vuln class | Pattern (informal) |
|---|---|
| IDOR / BOLA | `(p:Principal)-[:ACCESSED_BY]->(r{object_id})` where `r`'s template is reachable from another principal's id range |
| Broken access control / priv-esc | resource `ACCESSED_BY` an admin principal whose template is also reachable by a low-priv principal |
| Reflected XSS / injection | `(param)-[:REFLECTS]->(resp: text/html)` un-encoded |
| SSRF / open redirect | `(param: url-valued)-[:FLOWS_TO]->(resp 3xx Location \| server fetch)` |
| Secret leak | `(v:Secret)-[:FLOWS_TO]->(req)-[:CROSSES_BOUNDARY]->(:ThirdParty)` |
| Enumeration | `EndpointTemplate` with sequential numeric-id instances under one principal |

Candidates remain **hypotheses to test**, never confirmed findings. The oracle
(`oracle.ts`) is still the only thing that rules positive/negative, and findings stay
gated on positive oracle evidence (`tools-action.ts`).

---

## 3. The lens system

### 3.1 The `Lens` contract

A lens is a declarative descriptor plus a pure projection:

```ts
interface Lens {
  id: string                 // "attack-surface" | "taint" | ...
  label: string              // "Data Flow (Taint)"
  icon: string               // tabler icon for the switcher
  thumbnail: () => JSX        // tiny preview for the popover (Maps-style)
  project(spg: SPG, view: LensViewState): RenderGraph
  defaultOverlays?: OverlayId[]
}
```

`project` always runs four steps in order:
**select** (which nodes/edges) → **layout** (assign `x/y` via a layout engine) →
**encode** (color/size/shape = what *this* lens means) → **legend** (its own key).

### 3.2 The `RenderGraph` contract (generalize `WebTree`)

`WebTree` becomes a superset so `GraphCanvas` stays the single renderer:

```ts
interface RenderNode {                                  // adds to today's TreeNode
  id; label; x; y; color
  shape?: "disc" | "diamond" | "square" | "pill"        // encode kind per-lens
  size?: number                                         // encode degree / blast-radius
  groupId?: string                                      // membership in a region
  badge?: "risk" | "new" | "on-path"                    // overlay hooks
}
interface RenderEdge   { id; source; target; style?: "solid" | "flow" | "danger"; label? }
interface RenderRegion { id; label; bbox; tone }        // drawn containers (zones/columns)
interface RenderGraph  { nodes; edges; regions?; legend }
```

`GraphCanvas` gains exactly two new capabilities: **regions** (labeled container
rects behind nodes — trust zones, bipartite columns) and **per-node shape**.
Everything else (easing, glow, status ring, pop in/out, camera) already exists.

### 3.3 The lens catalog (six terrains)

| Lens | Selects | Layout | Encodes | Hunting job |
|---|---|---|---|---|
| **Attack Surface** *(default)* | Domain → path → leaf | tidy tree | category | orientation — "what exists" |
| **API & Parameters** | Endpoint templates + Parameters | tree grouped by host/template | method · status · param value-class | testable surface — injection/IDOR seeds |
| **Identity & Access** | Principals + resources + `ACCESSED_BY` | bipartite columns (principals \| resources) | per-principal color; missing/extra edges flagged | "who can reach what" — IDOR, access-control, priv-esc |
| **Data Flow (Taint)** | Value/Param/Endpoint + `FLOWS_TO`/`REFLECTS` | force-directed, source→sink L→R | taint status; sink shape | "what flows where" — XSS, SSRF, leak |
| **Trust Boundaries** | all, grouped by TrustZone; `CROSSES_BOUNDARY` lit | grouped regions (zone containers) | crossing edges = danger | DFD / STRIDE — CSRF, CORS, exfil |
| **Attack Paths** | scored candidate chains only | layered / Sankey | severity · confidence | the hunt board — ranked source→sink chains |

### 3.4 Overlays (composable, on any base)

Overlays are the Maps "traffic/transit" analog — toggles that re-style the active
lens **without changing its topology** (touch `badge`/`color`/alpha, never layout):

- **Risk heat** — recolor by risk *(ships first)*
- **On-path only** — dim anything not on a candidate chain
- **New-since-last-scan** — highlight recent deltas
- **Principal focus** — pick a principal; dim everything it can't reach

### 3.5 The switcher UX

A layers icon (`ti-stack-2`) pinned to a canvas corner. Click → a compact,
Maps-style popover: each lens a row with thumbnail + label, active one checked;
overlay toggles in a divided section below. Selecting sets `graphState.activeLens` →
the page re-projects → `GraphCanvas` reconciles → positions ease into the new terrain.
Keyboard: `1–6` jump to lenses, `L` opens the popover.

**Switch behavior: hard re-layout.** Every lens recomputes positions from scratch.
The canvas eases old→new so it still *feels* like a morph, but there is no
persistent-position bookkeeping — each lens stays a pure `SPG → RenderGraph`.

---

## 4. Source unification — the `useSecurityGraph()` seam

Today the app does **not** depend on `@morgana/web-core`; it builds its graph from
its own `buildTree` over the `web-capture` context. web-core's SPG is wired only to
the agent side (plugin / MCP). We unify the UI onto the SPG **now**, because four of
the six lenses (Identity & Access, Taint, Trust Boundaries, Attack Paths) can *only*
be projected from the enriched SPG — building them on capture-derived trees first
would mean writing the projection layer twice.

Unification is a **thin seam, not a big-bang**:

- Add `@morgana/web-core` as an app dependency.
- One new accessor — `useSecurityGraph()` — memoizes
  `buildEnrichedGraph(captures, navs, forms)` keyed by capture version (the same
  caching `store.ts` already does). An adapter maps the app's `CaptureRecord` →
  web-core's `CaptureRecord` (trivial: web-core's is explicitly "a mirror of
  opencode's", `capture-source.ts`).
- Every lens reads `useSecurityGraph()`. `buildTree` survives only until the Attack
  Surface lens is ported, then it is deleted.

**Key clarification — directories are display scaffolding, not model nodes.** The
path hierarchy (`/a/b/c` with single-child chain-compression) is a *layout grouping*,
not a security entity. It lives in the **Attack Surface lens**, synthesized from the
SPG's leaf URLs — **not** in the SPG model. The model stays security-pure; the
sitemap lens owns its scaffolding. This resolves "the sitemap needs directories but
the SPG doesn't have them" and is a cleaner separation than today.

**No perf regression:** `buildTree` already rebuilds wholesale on each streamed
capture; `buildEnrichedGraph` does the same with version-memoization, and the canvas
reconcile loop handles deltas exactly as it does now.

---

## 5. Code map

```
packages/web-core/src/
  graph/enriched.ts        # SPG builder — add Principal/Parameter/Template + sec edges
  kb.ts                    # candidatesFor → graph-pattern queries
  store.ts / tools*.ts     # agent read surface, same SPG (mostly unchanged)

packages/app/src/pages/gaze/web/graph/
  graph-canvas.tsx         # generalize: consume RenderGraph; add regions + node shape
  graph-state.ts           # add activeLens, overlays, per-lens camera
  use-security-graph.ts    # NEW — the unification seam (memoized buildEnrichedGraph)
  lenses/
    render-graph.ts        # NEW — RenderNode/Edge/Region/RenderGraph types
    lens-registry.ts       # NEW — declarative catalog (mirrors CATEGORY_META style)
    attack-surface-lens.ts # NEW — ported buildTree (tree + compress + tidy layout)
    api-params-lens.ts     # NEW
    identity-access-lens.ts# NEW
    taint-lens.ts          # NEW
    trust-boundary-lens.ts # NEW
    attack-paths-lens.ts   # NEW
  LayerSwitcher.tsx        # NEW — corner layers icon + popover
```

---

## 6. Layout engines

Run in the projection step; each emits frozen `x/y` (consistent with the current
"simulation is frozen; we drive x/y ourselves" approach):

- **tidy tree** — have it (in `graph-model.ts`, moves to the Attack Surface lens)
- **force-directed** — `d3-force`, run offline then freeze (Taint)
- **layered / Sankey** — `d3-dag` or `dagre` (Attack Paths)
- **bipartite columns** — two sorted columns, trivial (Identity & Access)
- **grouped regions** — group bbox + light intra-group force (Trust Boundaries)

---

## 7. Interaction model

- **Selection survives lens switches.** `selectedId` is the stable SPG node id, so
  selecting a node in Attack Surface and flipping to Taint keeps it selected and the
  inspector keeps showing it.
- **Per-lens camera.** Each terrain remembers its own zoom/pan (Maps-like).
- **Inspector** is lens-aware: it shows SPG node detail plus the candidates the
  current lens's patterns surfaced for that node.

---

## 8. Staging / build order

Respects the project's "don't build the destination first" discipline; the seam +
model are the shared foundation every lens depends on.

1. **Foundation**
   - SPG Stage 0 in web-core: `Principal` / `Parameter` / `EndpointTemplate` nodes +
     `ACCESSED_BY` / `FLOWS_TO` edges; rewrite `candidatesFor` as graph patterns;
     headless fixture tests.
   - `useSecurityGraph()` seam + `RenderGraph` types + lens registry + `LayerSwitcher`
     shell. End state: the app reads the one SPG; Attack Surface renders as a ported
     lens.
2. **Light up the six lenses** — each a `project()` over the SPG.
3. **Overlays (risk heat first) + per-lens camera + attack-path scoring.**

Phase-1's target (IDOR end-to-end) is served directly by the Foundation stage —
Principal + Template are exactly the IDOR gap, so this is not building ahead.

---

## 9. Open items / future

- **Attack-path scoring** — rank chains by `reachability × blast-radius × confidence`
  (Bayesian-attack-graph style) so the Attack Paths lens and `web_graph_overview`
  surface top *paths*, not just top *nodes*.
- **State / sequence modeling** — auth state machine and multi-step flow ordering for
  business-logic bugs (a later node/edge addition; the Attack Paths lens can host it).
- **Principal inference** — how distinct sessions/roles are fingerprinted from
  observed traffic without holding credentials (heuristic TBD; spec in Foundation).

## References

- Code property graphs for vulnerability detection — Fluid Attacks
- IRIS: LLM-assisted static taint analysis — arXiv 2405.17238
- Taint analysis for graph APIs / broken access control — arXiv 2501.08947
- Graph-based access control & entitlements — Enterprise Knowledge; Neo4j IAM
- STRIDE + Data Flow Diagram trust boundaries — Practical DevSecOps
