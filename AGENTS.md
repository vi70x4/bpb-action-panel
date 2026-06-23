# BPB Action Mesh

A decentralized mesh of ephemeral proxy nodes (VLESS/Hysteria2) running inside GitHub Actions runners, discovered via libp2p Kademlia DHT. TypeScript monorepo with a Cloudflare Worker coordinator and Express dashboard. Pure science experiment — not a production service.

## Structure

| Directory | Purpose |
|---|---|
| `src/` | Express + Socket.IO dashboard panel (`server.ts`, `index.ts` entry, `assets/panel/` static UI) |
| `node/` | libp2p DHT mesh node — discovery + lifecycle (`dht.ts`, `lifecycle.ts`, `announce.ts`, `index.ts`) |
| `worker/` | Cloudflare Worker coordinator — proxy register, heartbeat, subscription (`src/index.ts`) |
| `scripts/` | CLI management: `proxy-up.sh` (launch), `proxy-down.sh` (cancel), `proxy-status.sh` (health) |
| `.github/workflows/` | `proxy.yml` (GHA runner for VLESS/Hy2), `panel.yml` (build/deploy dashboard) |
| `docs/` | `SPEC-V2-MESH.md` (full architecture), `BRAINSTORM-PROMPT.md` (consillium prompt) |

Key modules: the mesh works in 3 layers — the DHT node (`node/`) discovers peers and announces proxy configs, the CF Worker (`worker/`) serves subscription URLs to clients, and the GHA workflow (`proxy.yml`) is the actual runner that starts sing-box/hysteria, creates a cloudflared tunnel, and registers with the coordinator.

## Commands

- **Dev dashboard:** `npm run dev` (tsx watch, starts Express on :3000)
- **Dev mesh node:** `cd node && npm run dev`
- **Dev coordinator:** `cd worker && npm run dev`
- **Build all:** `npm run build` (tsc + panel asset inlining)
- **Build panel only:** `npm run build:panel`
- **Test:** `npm test` (no-op stub — no tests yet)
- **Lint:** `npm run lint` (eslint, may fail if not installed)
- **Launch proxy:** `./scripts/proxy-up.sh --protocol hysteria2`
- **Deploy coordinator:** `cd worker && npm run deploy`

## Rules

- This is a research experiment. Respect GitHub's ToS. Never use for production traffic.
- libp2p is for peer discovery ONLY — proxy traffic flows directly over VLESS/Hysteria2, never through the DHT.
- Secrets (`COORDINATOR_URL`, `AUTH_TOKEN`, `NETWORK_ID`) go in GitHub Actions secrets, never in source.
- The root `tsconfig.json` uses CommonJS modules (`"module": "commonjs"`); `node/tsconfig.json` uses ES2022 modules. Don't mix them.
- The coordinator is optional — the mesh must degrade gracefully without it. Every feature must work DHT-only as fallback.
- Use `spawn_agent` for code changes when that tool is available. If `spawn_agent` is unavailable in the current environment, proceed directly with the normal editing tools and keep changes scoped.

## Delegation

When available, `spawn_agent` is stateless — every prompt must include the repo identifier, target symbol IDs, and the jcodemunch usage mandate. See `RULES.md §0` for the full delegation SOP and subagent prompt template.

## jcodemunch

This repo is indexed as `bpb-action`. Use jcodemunch for all code exploration — never brute-read full files.
- Start with `plan_turn(repo="bpb-action", query="...")` to find relevant symbols.
- Symbol ID format: `{file_path}::{qualified_name}#{kind}` (e.g. `worker/src/index.ts::fetch#function`).
- Use `get_blast_radius` before editing any symbol — understand what breaks.
- After delegated code returns from `spawn_agent`, verify the changes, then call `register_edit(repo="bpb-action", file_paths=[...])` to keep the index fresh.

## Further Reference

- `RULES.md §0` — Delegation SOP: how to plan, delegate, review, and iterate on code changes.
- `RULES.md §1` — Project-specific rules: repository identity, branch strategy, credentials, architecture quirks.
- `docs/SPEC-V2-MESH.md` — Full architectural specification (DHT topology, lifecycle, bootstrap, threat model, consillium decisions).
- `docs/BRAINSTORM-PROMPT.md` — The original consillium prompt that produced the spec.
- `README.md` — User-facing docs: quick start, threat model, FAQ, implementation roadmap.