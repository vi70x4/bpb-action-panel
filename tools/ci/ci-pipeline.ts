/**
 * CI Pipeline — builds the swarm fact ledger from tool outputs,
 * then runs the contradiction engine.
 *
 * This is the CI "truth validator" that replaces independent tool checks
 * with a unified consistency evaluation.
 *
 * Pipeline:
 *   1. Run each tool, capture structured output
 *   2. Normalize tool outputs into SwarmEvents
 *   3. Append events to the ledger
 *   4. Run contradiction detection
 *   5. Output report + exit code
 *
 * Usage:
 *   tsx ci-pipeline.ts --ledger /tmp/swarm-ledger.jsonl --run-id ci-42
 */

import { SwarmLedger } from "../ledger/src/ledger.js";
import {
  detectContradictions,
  formatReport,
  ciExitCode,
} from "../ledger/src/contradictions.js";
import { replay, replaySummary } from "../ledger/src/replay.js";
import { buildCausalEdges } from "../ledger/src/causal.js";
import {
  latestByKey,
  getDHTState,
  getNodeState,
  getTunnelState,
  getKeyspaceHealth,
} from "../ledger/src/projections.js";
import {
  normalizeBootstrap,
  normalizeSim,
  normalizeGhost,
  normalizeKeyspace,
  normalizeTunnel,
  normalizeSpec,
} from "../ledger/src/adapters.js";
import type { SwarmEvent } from "../ledger/src/types.js";
import {
  captureFingerprint,
  compareFingerprints,
} from "../ledger/src/schema.js";
import type { EnvFingerprint } from "../ledger/src/schema.js";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  ledgerPath: string;
  runId: string;
  jsonDir: string | null;
  reportPath: string | null;
  fingerprintCheck: boolean;
} {
  const defaults = {
    ledgerPath: "/tmp/swarm-ledger.jsonl",
    runId: `ci-${Date.now()}`,
    jsonDir: null as string | null,
    reportPath: null as string | null,
    fingerprintCheck: false,
  };

  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--ledger" && argv[i + 1]) {
      defaults.ledgerPath = argv[++i];
    } else if (argv[i] === "--run-id" && argv[i + 1]) {
      defaults.runId = argv[++i];
    } else if (argv[i] === "--json-dir" && argv[i + 1]) {
      defaults.jsonDir = argv[++i];
    } else if (argv[i] === "--report" && argv[i + 1]) {
      defaults.reportPath = argv[++i];
    } else if (argv[i] === "--fingerprint-check") {
      defaults.fingerprintCheck = true;
    }
    i++;
  }

  return defaults;
}

// ---------------------------------------------------------------------------
// JSON result loader — reads tool output JSON files from a directory
// ---------------------------------------------------------------------------

interface ToolResults {
  bootstrap?: { exit_code: number; reachable: number; total: number };
  sim?: {
    exit_code: number;
    node_count: number;
    peers_discovered: number[];
    full_mesh: boolean;
  };
  ghost?: {
    exit_code: number;
    alive: number;
    ghost: number;
    stale: number;
    unreachable: number;
    ghost_peers?: string[];
  };
  keyspace?: {
    exit_code: number;
    vless_count: number;
    hy2_count: number;
    tombstone_count: number;
    orphan_keys: number;
  };
  tunnel?: {
    status: string;
    provider: string;
    host?: string;
    port?: number;
    exit_code: number;
  };
  spec?: {
    exit_code: number;
    checks_passed: number;
    checks_total: number;
    drift_detected: boolean;
  };
}

function loadToolResults(jsonDir: string): ToolResults {
  const results: ToolResults = {};

  const files = [
    { key: "bootstrap", file: "bootstrap.json" },
    { key: "sim", file: "sim.json" },
    { key: "ghost", file: "ghost.json" },
    { key: "keyspace", file: "keyspace.json" },
    { key: "tunnel", file: "tunnel.json" },
    { key: "spec", file: "spec.json" },
  ] as const;

  for (const { key, file } of files) {
    const path = resolve(jsonDir, file);
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        (results as Record<string, unknown>)[key] = JSON.parse(raw);
      } catch {
        console.warn(`⚠ Failed to parse ${path}, skipping`);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Event ingestion
// ---------------------------------------------------------------------------

function ingestResults(
  ledger: SwarmLedger,
  results: ToolResults,
  runId: string,
): void {
  // Emit environment fingerprint as first event in the run
  const fp = captureFingerprint(runId);
  ledger.append({
    tool: "system",
    key: "env.fingerprint",
    value: true,
    confidence: 1.0,
    type: "FACT",
    timestamp: Date.now(),
    run_id: runId,
    meta: { env: fp },
  });

  // Bootstrap
  if (results.bootstrap) {
    const events = normalizeBootstrap(results.bootstrap, runId);
    for (const e of events) ledger.append(e);
  }

  // Sim
  if (results.sim) {
    const events = normalizeSim(results.sim, runId);
    for (const e of events) ledger.append(e);
  }

  // Ghost
  if (results.ghost) {
    const events = normalizeGhost(results.ghost, runId);
    for (const e of events) ledger.append(e);
  }

  // Keyspace
  if (results.keyspace) {
    const events = normalizeKeyspace(results.keyspace, runId);
    for (const e of events) ledger.append(e);
  }

  // Tunnel
  if (results.tunnel) {
    const events = normalizeTunnel(results.tunnel, runId);
    for (const e of events) ledger.append(e);
  }

  // Spec
  if (results.spec) {
    const events = normalizeSpec(results.spec, runId);
    for (const e of events) ledger.append(e);
  }
}

// ---------------------------------------------------------------------------
// Projections summary
// ---------------------------------------------------------------------------

function buildProjectionsReport(events: SwarmEvent[]): string {
  const lines: string[] = [];

  // DHT
  const dht = getDHTState(events);
  lines.push(`📡 DHT State:`);
  lines.push(`   peer_count: ${dht.peer_count}`);
  lines.push(`   active_nodes: ${dht.active_nodes.length}`);
  lines.push(`   orphan_keys: ${dht.orphan_keys}`);
  lines.push(`   sources: ${[...dht.sources.keys()].join(", ") || "none"}`);

  // Keyspace
  const ks = getKeyspaceHealth(events);
  lines.push(`🔑 Keyspace:`);
  lines.push(
    `   vless: ${ks.vless_count}  hy2: ${ks.hy2_count}  tombstones: ${ks.tombstone_count}`,
  );
  lines.push(`   orphan_keys: ${ks.orphan_keys}  total: ${ks.total_keys}`);

  // Tunnel
  const tunnel = getTunnelState(events);
  lines.push(`🚇 Tunnel:`);
  lines.push(
    `   status: ${tunnel.status}  provider: ${tunnel.provider ?? "unknown"}`,
  );
  lines.push(
    `   host: ${tunnel.host ?? "unknown"}  port: ${tunnel.port ?? "unknown"}`,
  );

  // Causality
  const edges = buildCausalEdges(events);
  lines.push(`🔗 Causality: ${edges.length} edges`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Demo / test fixtures (run when no --json-dir provided)
// ---------------------------------------------------------------------------

function runDemo(ledger: SwarmLedger, runId: string): void {
  console.log("🧪 Running CI pipeline demo with synthetic fixtures...\n");

  // Simulate a coherent swarm state
  const simResult = {
    exit_code: 0,
    node_count: 3,
    peers_discovered: [2, 2, 2],
    full_mesh: true,
  };
  for (const e of normalizeSim(simResult, runId)) ledger.append(e);

  const ghostResult = {
    exit_code: 0,
    alive: 3,
    ghost: 0,
    stale: 0,
    unreachable: 0,
  };
  for (const e of normalizeGhost(ghostResult, runId)) ledger.append(e);

  const keyspaceResult = {
    exit_code: 0,
    vless_count: 2,
    hy2_count: 1,
    tombstone_count: 0,
    orphan_keys: 0,
  };
  for (const e of normalizeKeyspace(keyspaceResult, runId)) ledger.append(e);

  const tunnelResult = {
    status: "ready",
    provider: "trycloudflare",
    host: "abc-xyz.trycloudflare.com",
    port: 443,
    exit_code: 0,
  };
  for (const e of normalizeTunnel(tunnelResult, runId)) ledger.append(e);

  const specResult = {
    exit_code: 0,
    checks_passed: 5,
    checks_total: 5,
    drift_detected: false,
  };
  for (const e of normalizeSpec(specResult, runId)) ledger.append(e);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log("🧠 Swarm CI Truth Pipeline");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Ledger: ${args.ledgerPath}`);
  console.log(`  Run ID: ${args.runId}`);
  console.log("");

  const ledger = new SwarmLedger(args.ledgerPath);

  // Ingest tool results
  if (args.jsonDir) {
    console.log(`📂 Loading tool results from ${args.jsonDir}`);
    const results = loadToolResults(args.jsonDir);
    ingestResults(ledger, results, args.runId);
    console.log(
      `  Ingested results from: ${Object.keys(results)
        .filter((k) => (results as Record<string, unknown>)[k] !== undefined)
        .join(", ")}`,
    );
  } else {
    console.log(
      "⚠ No --json-dir provided, running demo with synthetic fixtures\n",
    );
    runDemo(ledger, args.runId);
  }

  const events = ledger.loadAll();
  console.log(
    `\n📊 Ledger: ${events.length} events from ${[...new Set(events.map((e) => e.tool))].length} tools\n`,
  );

  // Fingerprint check (warning only)
  if (args.fingerprintCheck) {
    const fpEvent = events.find((e) => e.key === "env.fingerprint");
    if (fpEvent?.meta?.env) {
      const recorded = fpEvent.meta.env as EnvFingerprint;
      const current = captureFingerprint(args.runId);
      const mismatch = compareFingerprints(recorded, current);
      if (mismatch) {
        console.warn(`⚠️  Environment fingerprint mismatch: ${mismatch}`);
      } else {
        console.log("✅ Environment fingerprint matches");
      }
    } else {
      console.warn(
        "⚠️  No fingerprint event found in ledger (run with fingerprint capture enabled)",
      );
    }
  }

  // Build projections
  console.log(buildProjectionsReport(events));
  console.log("");

  // Run contradiction engine
  const report = detectContradictions(events);
  const reportText = formatReport(report);
  console.log(reportText);

  // Replay summary
  console.log("\n🔁 Replay Summary:");
  console.log(replaySummary(events));

  // Write report to file if requested
  if (args.reportPath) {
    const fullReport = {
      run_id: args.runId,
      timestamp: new Date().toISOString(),
      event_count: events.length,
      tools: [...new Set(events.map((e) => e.tool))],
      contradiction_report: report,
      projections: {
        dht: {
          peer_count: getDHTState(events).peer_count,
          active_nodes: getDHTState(events).active_nodes,
          orphan_keys: getDHTState(events).orphan_keys,
          sources: Object.fromEntries(getDHTState(events).sources),
        },
        keyspace: getKeyspaceHealth(events),
        tunnel: {
          status: getTunnelState(events).status,
          provider: getTunnelState(events).provider,
          host: getTunnelState(events).host,
          port: getTunnelState(events).port,
          sources: Object.fromEntries(getTunnelState(events).sources),
        },
      },
    };
    writeFileSync(args.reportPath, JSON.stringify(fullReport, null, 2));
    console.log(`\n📄 Full report written to ${args.reportPath}`);
  }

  // Exit code
  const exitCode = ciExitCode(report);
  console.log(
    `\n🚪 CI exit code: ${exitCode} (${exitCode === 0 ? "consistent" : exitCode === 1 ? "drift" : exitCode === 2 ? "soft contradiction" : "hard contradiction"})`,
  );

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`❌ Pipeline error: ${(err as Error).message}`);
  process.exit(1);
});
