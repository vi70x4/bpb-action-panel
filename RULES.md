# BPB Action Mesh — RULES.md

Task-specific rules for coding agents. Read §0 before any code work; read §1+ when the section is relevant to your task.

---

## §0: Delegation SOP

All code changes go through `spawn_agent`. The architect plans and reviews; subagents implement. This is the 5-step loop:

### Step 1 — Analyze & Plan

Use jcodemunch to understand the task before delegating anything:

1. `plan_turn(repo="bpb-action", query="...")` — opening move. Returns confidence + recommended symbols.
2. `search_symbols` / `get_file_outline` — find the exact symbols and files involved.
3. `get_blast_radius(symbol="...", depth=2)` — understand downstream impact before touching anything.
4. `get_hotspots` / `find_dead_code` — flag risk areas in your review plan.
5. `get_dependency_graph(file="...", direction="imports")` — map module boundaries if the change crosses packages.

Break the work into the smallest feasible incremental steps. Delegate one step at a time.

### Step 2 — Delegate One Step

Every `spawn_agent` prompt must contain:

1. **Repo identifier:** `bpb-action`
2. **jcodemunch mandate:** The subagent must use jcodemunch for ALL code lookup. Never read a full file.
3. **Target symbol_ids:** The exact symbols the subagent needs to read or modify.
4. **All required context:** The subagent is stateless — it knows nothing about prior steps. Include everything.
5. **Token budget:** When using `get_ranked_context` or `get_context_bundle`, pass `token_budget=4000` to keep context focused.

Delegation preamble template — prepend this to every spawn_agent prompt:

```
You are working in repo "bpb-action" (indexed via jcodemunch-mcp).
Mandatory: use jcodemunch tools for ALL code lookup. Never read a full file.
- get_file_outline before pulling source
- search_symbols / get_symbol_source for targeted retrieval
- Batch with symbol_ids[] instead of repeated calls
- get_ranked_context(query="...", token_budget=4000) for task-driven context

Target symbols: <list symbol_ids>
```

Delegate only the immediate next step. Never bundle multiple steps into one subagent call. If work can be parallelized across disjoint files, include the phrase "fan out subagents" in the prompt so the subagent knows it can parallelize.

**Recursive safety:** If you are the spawned subagent, do your designated job directly. Do not recursively spawn further subagents unless explicitly instructed to "fan out."

### Step 3 — Review

After each subagent returns, verify with jcodemunch:

- `get_blast_radius(symbol="...", include_source=true)` — confirm the impact matches expectations.
- `find_references(identifier="...")` — verify no call site is broken.
- `get_call_hierarchy(symbol_id="...", direction="callers")` — trace upstream dependents.
- `get_symbol_source(symbol_id="...", verify=true)` — confirm the indexed source matches what was written.
- `register_edit(repo="bpb-action", file_paths=[...], reindex=true)` — keep the index fresh after edits.
- Run available tests (`npm test` — currently a no-op stub, but check anyway).

### Step 4 — Iterate

- **Approved:** Move to the next step (return to Step 2).
- **Revision needed:** Re-delegate with a new spawn_agent prompt that includes: (1) repo id + jcodemunch mandate, (2) the symbol_ids for the code just written plus surrounding context, (3) corrective feedback, (4) instruction for the subagent to `get_symbol_source` the current state of affected symbols before editing. Do not fix code yourself.

---

## §1: Project-Specific Rules

### Repository identity

- **Repo identifier:** `bpb-action`
- **Default branch:** `main` — push to main triggers the proxy workflow via GHA.
- **Monorepo layout:** Root `package.json` owns the dashboard. `node/` and `worker/` are separate packages with their own `package.json` and `tsconfig.json`.

### Module system mismatch

The root `tsconfig.json` compiles to CommonJS (`"module": "commonjs"`), while `node/tsconfig.json` compiles to ES2022 modules (`"module": "ES2022"`). The node package uses `.js` extensions in imports (e.g. `import { createDHTNode } from './dht.js'`). The worker uses Cloudflare Workers module format. Never mix import styles across packages — follow what the local `tsconfig.json` and existing imports already do.

### Credential handling

- `COORDINATOR_URL`, `AUTH_TOKEN`, `NETWORK_ID` are GitHub Actions secrets. Never hardcode them in source.
- The worker's `AUTH_TOKEN` is set via `wrangler secret put AUTH_TOKEN`. If not set, the worker allows all requests (dev mode).
- The `wrangler.toml` KV namespace id is a placeholder — it must be replaced after `wrangler kv:namespace create BPB_KV`. Do not commit real KV ids.

### Architecture constraints

- **DHT is discovery-only.** Never route proxy traffic through libp2p. This is a non-negotiable architectural invariant (unanimous consillium agreement).
- **Coordinator is optional.** Every feature must degrade gracefully when the CF Worker is down. The mesh must work DHT-only.
- **Ephemeral by design.** Nodes live 15-60 minutes (random TTL). No persistent state. Identity is per-lifecycle PeerId.
- **No serial multi-hop.** Killed by consillium decision. Parallel multiplexing (client opens multiple single-hop tunnels) is the resilience model. Do not add `route: []` to any schema.
- **Stagger, don't sync.** Random TTLs, jittered announces. No herd behavior.

### DHT key schema

Proxy configs are stored at `/bpb/v2/{network-id}/{protocol}/{peer-id}`. Tombstones at `/bpb/v2/{network-id}/tombstone/{peer-id}`. Do not change this schema without updating both the node (`announce.ts`) and the spec (`docs/SPEC-V2-MESH.md`).

### Coordinator API

The CF Worker exposes these endpoints. Preserve backward compatibility:

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/register` | POST | Bearer | Runner registers proxy config |
| `/heartbeat` | POST | Bearer | Runner refreshes TTL |
| `/sub/all` | GET | None | Hiddify subscription (all proxies) |
| `/sub/{id}` | GET | None | Single proxy subscription |
| `/proxies` | GET | None | JSON list of active proxies |
| `/delete/{id}` | DELETE | Bearer | Remove a proxy record |
| `/health` | GET | None | Service health check |

The `/sub/all` endpoint is consumed by Hiddify and other v2ray clients. Any change to its output format will break existing client subscriptions.

### Testing

There are no tests yet. `npm test` exits 0. When adding tests, place them adjacent to the source they test (e.g. `node/src/lifecycle.test.ts`) and use the same module system as the source package. Update the relevant `package.json` `test` script.

### GHA workflow quirks

- `proxy.yml` runs on `ubuntu-latest` with a 45-minute timeout. The proxy binary install steps (Hysteria2, sing-box) download from GitHub releases and have fallback URLs — don't simplify these without verifying the URLs actually resolve.
- The DHT node step in `proxy.yml` is currently commented out (`# DISABLED: DHT node code is not yet tested`). Do not re-enable until the node code is verified.
- `panel.yml` deploys to GitHub Pages and creates auto-releases. The `continue-on-error: true` on deploy/release steps means failures are silently ignored.

### Emergency recovery

If the mesh is dead (no coordinator + no DHT peers):
1. Push to `main` or manually trigger `proxy.yml` via `workflow_dispatch`.
2. Use `./scripts/proxy-up.sh --protocol hysteria2` to launch and wait for subscription.
3. Check coordinator health: `curl $COORDINATOR_URL/health`.
4. List active proxies: `curl $COORDINATOR_URL/proxies`.
5. Cancel stuck runs: `./scripts/proxy-down.sh`.
