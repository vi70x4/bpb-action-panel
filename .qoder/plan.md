# Swarm Ledger + Mesh Node: Verification & Fix Plan

## Context

Two parallel agents built the BPB Action Mesh: one created the Swarm Event Ledger & Contradiction Pipeline (`tools/ledger/`, `tools/ci/`), and the other activated the libp2p mesh node (`node/`). Both workstreams are structurally complete, but cross-cutting verification reveals **5 bugs** that will cause runtime failures and incorrect CI results.

---

## Task 1: Fix Key Normalization Bug (CRITICAL)

**Problem:** `normalizeKey()` in `schema.ts` converts underscores to dots (`replace(/_/g, ".")`), but 12 of 21 canonical keys contain underscores (e.g. `dht.peer_count`). After normalization, `dht.peer_count` becomes `dht.peer.count` — which never matches the canonical registry's `"dht.peer_count"`. The ledger accepts these via prefix match, but all downstream lookups in projections and contradictions use the canonical form and **always miss**.

**Impact:** All projections return zeros. All invariant checks are dead code. CI always exits 0.

**Fix (Option A):** Rename canonical keys to use dots only, aligning with normalization output.

**Files:**
- `tools/ledger/src/schema.ts` — Update `CANONICAL_KEYS`: `dht.peer_count` → `dht.peer.count`, `keyspace.vless_count` → `keyspace.vless.count`, etc. (all 12 underscored keys)
- `tools/ledger/src/projections.ts` — Update all key string comparisons: `evt.key === "dht.peer_count"` → `evt.key === "dht.peer.count"`, etc.
- `tools/ledger/src/contradictions.ts` — Update all `latest.get()` key strings. Also remove dead code on lines 79-80 where both `bootstrap` and `sim` look up the same key.
- `tools/ledger/src/adapters.ts` — Update all `key:` values in `makeEvent()` calls to match new canonical form.

**Verification:** Run `cd tools/ci && npx tsx ci-pipeline.ts --ledger /tmp/test.jsonl --report /tmp/test-report.json` and verify `peer_count: 3` (not 0) in projections output.

---

## Task 2: Fix Root tsconfig Module Mismatch (CRITICAL)

**Problem:** Root `tsconfig.json` specifies `"module": "commonjs"` but `package.json` declares `"type": "module"` and `src/server.ts` uses `import.meta.url`. This causes `tsc --noEmit` to fail with TS1343.

**Fix:** Change root `tsconfig.json` from `"module": "commonjs"` to `"module": "ES2022"` and `"moduleResolution": "node"` → `"node"`.

**File:** `tsconfig.json` (root)

**Verification:** `npx tsc --noEmit` from root — expect 0 errors.

---

## Task 3: Fix CI Pipeline tsconfig rootDir (HIGH)

**Problem:** `tools/ci/ci-pipeline.ts` imports from `../ledger/src/` (8 files), but `tools/ci/tsconfig.json` has `"rootDir": "."` which excludes the ledger source. `tsc --noEmit` fails with TS6059.

**Fix:** Change `tools/ci/tsconfig.json` to set `"rootDir": "../.."` so it covers both `tools/ci/` and `tools/ledger/src/`.

**Verification:** `cd tools/ci && npx tsc --noEmit` — expect 0 errors.

---

## Task 4: Fix Map Serialization in CI Report (HIGH)

**Problem:** `getDHTState()` and `getTunnelState()` return objects with `Map<string, SwarmEvent>` fields. `JSON.stringify()` serializes `Map` as `{}`, making the uploaded artifact unusable.

**Fix:** In `tools/ci/ci-pipeline.ts` lines 381-393, convert Maps to plain objects before writing:
```ts
sources: Object.fromEntries(dht.sources)
```

**Verification:** Run demo with `--report /tmp/test-report.json`, verify `sources` is non-empty in output JSON.

---

## Task 5: Fix DHT Cluster Sim Discovery (CRITICAL for mesh-smoke.yml)

**Problem (two parts):**
- **5a — API mismatch:** Sim uses libp2p v2 APIs (`connectionEncryption`) while `node/` uses v3 (`connectionEncrypters`). Sim's `package.json` declares `libp2p: ^2.0.0`, `kad-dht: ^12.0.0`.
- **5b — Provider key mismatch:** `announceNode()` calls `provide()` on per-peer keys, but `discoverPeers()` queries `findProviders()` on a network-level key. No node provides the network key, so discovery always returns 0.

**Fix:**
- Align `tools/sim/package.json` deps to match `node/package.json`: libp2p `^3.3.0`, kad-dht `^16.0.0`, etc.
- Change `connectionEncryption: [noise()]` → `connectionEncrypters: [noise()]` in `createSimNode()`
- Add `ping` service (required by kad-dht v16)
- In `announceNode()`: Also call `provide()` on the shared network key `/bpb/v2/bpb-sim/vless`
- Add `@libp2p/ping` to `tools/sim/package.json`

**Files:**
- `tools/sim/dht-cluster-sim.ts` — Fix APIs and provider keys
- `tools/sim/package.json` — Align deps to libp2p v3

**Verification:** `cd tools/sim && npm install && npx tsx dht-cluster-sim.ts --nodes 2` — expect PASS.

---

## Task 6: Type Safety for Node `announce.ts` (MEDIUM)

**Problem:** Three functions in `announce.ts` and `lifecycle.ts` use `node: any`, defeating type checking.

**Fix:** Import `Libp2p` type and use it as the parameter type:
```ts
import type { Libp2p } from "libp2p";
```

**Files:**
- `node/src/announce.ts` — Replace `node: any` with `node: Libp2p`
- `node/src/lifecycle.ts` — Same

**Verification:** `cd node && npx tsc --noEmit` — expect 0 errors.

---

## Task 7: Integration Verification (FINAL)

Run the full pipeline end-to-end to validate all fixes:

1. `npm run ledger:demo` — expect exit 0, non-zero projections
2. Create a hard contradiction fixture (tunnel=failed + announced=true) → expect exit 3
3. Create a soft contradiction fixture (ghost ratio > 50%) → expect exit 2
4. Verify `node/src/` compiles clean
5. Verify `tools/ci/ci-pipeline.ts` compiles clean

---

## Execution Order

1. Task 1 (key normalization) — highest impact, touches 4 files
2. Task 2 (root tsconfig) — quick fix
3. Task 3 (CI tsconfig) — quick fix
4. Task 4 (Map serialization) — quick fix
5. Task 6 (type safety) — quick fix, no runtime impact
6. Task 5 (sim discovery) — requires npm install, more involved
7. Task 7 (integration verification) — validates all prior fixes
