/**
 * Contradiction Engine — cross-tool consistency validator.
 *
 * Compares facts across tools using key-based invariants.
 * This is what makes CI a "truth validator" instead of "script runner".
 *
 * Contradiction severity:
 *   HARD   — tools disagree on the same measurement → CI fail
 *   SOFT   — tools may disagree due to timing → CI warning
 *   DRIFT  — tools report stale/inconsistent views → CI warning
 */

import type { SwarmEvent } from "./types.js";
import { latestByKey } from "./projections.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContradictionSeverity = "HARD" | "SOFT" | "DRIFT";

export interface Contradiction {
  severity: ContradictionSeverity;
  rule: string;
  message: string;
  keys: string[];
  tools: string[];
  events: SwarmEvent[];
  delta?: unknown;
}

export interface ContradictionReport {
  hard_count: number;
  soft_count: number;
  drift_count: number;
  contradictions: Contradiction[];
  consistent: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Temporal configuration
// ---------------------------------------------------------------------------

export interface TemporalConfig {
  /** Max skew for HARD contradiction classification (same CI phase). Default: 120_000 (2min) */
  hard_skew_ms: number;
  /** Max skew for SOFT contradiction classification (cross CI phase). Default: 300_000 (5min) */
  soft_skew_ms: number;
  /** Ghost ratio above this triggers SOFT contradiction. Default: 0.5 */
  ghost_ratio_threshold: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  hard_skew_ms: 120_000,
  soft_skew_ms: 300_000,
  ghost_ratio_threshold: 0.5,
};

// ---------------------------------------------------------------------------
// Invariant rules
// ---------------------------------------------------------------------------

interface InvariantCheck {
  rule: string;
  severity: ContradictionSeverity;
  check: (
    latest: Map<string, SwarmEvent>,
    config: TemporalConfig,
  ) => Contradiction | null;
}

const INVARIANTS: InvariantCheck[] = [
  // ---- DHT peer count consistency ----
  {
    rule: "dht-peer-count-consistency",
    severity: "HARD",
    check: (latest, config) => {
      // Use per-tool-qualified keys for cross-tool comparison
      const bEvt = latest.get("dht.peer.count.bootstrap");
      const sEvt = latest.get("dht.peer.count.sim");

      if (bEvt && sEvt) {
        const bVal = bEvt.value as number;
        const sVal = sEvt.value as number;

        // Special case: bootstrap 0 + sim > 0
        if (bVal === 0 && sVal > 0) {
          const skew = Math.abs(bEvt.timestamp - sEvt.timestamp);
          // Beyond soft_skew_ms → not comparable, skip
          if (skew >= config.soft_skew_ms) {
            return null;
          }
          // Within hard_skew_ms → real contradiction
          if (skew < config.hard_skew_ms) {
            return {
              severity: "HARD",
              rule: "dht-peer-count-consistency",
              message: `Bootstrap reports 0 peers but sim reports ${sVal}`,
              keys: ["dht.peer.count"],
              tools: [bEvt.tool, sEvt.tool],
              events: [bEvt, sEvt],
              delta: { bootstrap: 0, sim: sVal },
            };
          }
          // hard_skew_ms ≤ skew < soft_skew_ms → timing artifact
          return {
            severity: "SOFT",
            rule: "dht-peer-count-consistency",
            message: `Bootstrap 0 peers vs sim ${sVal} peers (possibly different time windows, skew=${Math.round(skew / 1000)}s)`,
            keys: ["dht.peer.count"],
            tools: [bEvt.tool, sEvt.tool],
            events: [bEvt, sEvt],
            delta: { bootstrap: 0, sim: sVal, time_skew_ms: skew },
          };
        }
      }
      return null;
    },
  },

  // ---- Node liveness consistency ----
  {
    rule: "node-liveness-consistency",
    severity: "HARD",
    check: (latest, _config) => {
      // If ghost detector says a node is offline, but sim says it's active
      const ghostOffline = [...latest.values()].filter(
        (e) =>
          e.key === "node.status" &&
          e.value === "offline" &&
          e.tool === "ghost",
      );

      const simActive = [...latest.values()].filter(
        (e) =>
          e.key === "node.status" && e.value === "online" && e.tool === "sim",
      );

      for (const g of ghostOffline) {
        for (const s of simActive) {
          if (g.node_id && g.node_id === s.node_id) {
            return {
              severity: "HARD",
              rule: "node-liveness-consistency",
              message: `Ghost detector says ${g.node_id} is offline, sim says online`,
              keys: ["node.status"],
              tools: [g.tool, s.tool],
              events: [g, s],
            };
          }
        }
      }
      return null;
    },
  },

  // ---- Keyspace integrity ----
  {
    rule: "keyspace-orphan-consistency",
    severity: "DRIFT",
    check: (latest, _config) => {
      const orphans = latest.get("keyspace.orphan.keys");
      const peerCount = latest.get("dht.peer.count");

      if (orphans && typeof orphans.value === "number" && orphans.value > 0) {
        // Having orphans isn't necessarily a contradiction, but if bootstrap
        // says "clean state" and we have orphans, that's drift
        const cleanState = [...latest.values()].find(
          (e) => e.key === "dht.state.clean" && e.value === true,
        );

        if (cleanState) {
          return {
            severity: "DRIFT",
            rule: "keyspace-orphan-consistency",
            message: `Bootstrap claims clean DHT state but ${orphans.value} orphan keys found`,
            keys: ["keyspace.orphan.keys", "dht.state.clean"],
            tools: [orphans.tool, cleanState.tool],
            events: [orphans, cleanState],
          };
        }
      }
      return null;
    },
  },

  // ---- Tunnel readiness ----
  {
    rule: "tunnel-vs-announce-consistency",
    severity: "HARD",
    check: (latest, _config) => {
      const tunnelStatus = latest.get("tunnel.status");
      const announce = latest.get("dht.announced");

      // If tunnel failed but node still announced → hard contradiction
      if (
        tunnelStatus &&
        announce &&
        tunnelStatus.value === "failed" &&
        announce.value === true
      ) {
        return {
          severity: "HARD",
          rule: "tunnel-vs-announce-consistency",
          message:
            "Node announced to DHT but tunnel failed — proxy unreachable",
          keys: ["tunnel.status", "dht.announced"],
          tools: [tunnelStatus.tool, announce.tool],
          events: [tunnelStatus, announce],
        };
      }
      return null;
    },
  },

  // ---- Ghost count threshold ----
  {
    rule: "ghost-density",
    severity: "SOFT",
    check: (latest, config) => {
      const ghostCount = latest.get("ghost.count");
      const peerCount = latest.get("dht.peer.count");

      if (
        ghostCount &&
        peerCount &&
        typeof ghostCount.value === "number" &&
        typeof peerCount.value === "number" &&
        peerCount.value > 0
      ) {
        const ghostRatio = ghostCount.value / peerCount.value;
        if (ghostRatio > config.ghost_ratio_threshold) {
          return {
            severity: "SOFT",
            rule: "ghost-density",
            message: `Ghost ratio ${(ghostRatio * 100).toFixed(0)}% exceeds ${(config.ghost_ratio_threshold * 100).toFixed(0)}% threshold`,
            keys: ["ghost.count", "dht.peer.count"],
            tools: [ghostCount.tool, peerCount.tool],
            events: [ghostCount, peerCount],
            delta: { ghost_ratio: ghostRatio },
          };
        }
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run all invariant checks against the event ledger.
 * Returns a contradiction report.
 */
export function detectContradictions(
  events: SwarmEvent[],
  config: TemporalConfig = DEFAULT_TEMPORAL_CONFIG,
): ContradictionReport {
  const latest = latestByKey(events);
  const contradictions: Contradiction[] = [];

  for (const invariant of INVARIANTS) {
    const result = invariant.check(latest, config);
    if (result) {
      contradictions.push(result);
    }
  }

  const hard = contradictions.filter((c) => c.severity === "HARD").length;
  const soft = contradictions.filter((c) => c.severity === "SOFT").length;
  const drift = contradictions.filter((c) => c.severity === "DRIFT").length;

  // Hard contradictions → not consistent
  const consistent = hard === 0;

  const parts: string[] = [];
  if (hard > 0) parts.push(`${hard} hard`);
  if (soft > 0) parts.push(`${soft} soft`);
  if (drift > 0) parts.push(`${drift} drift`);

  const summary = consistent
    ? `Swarm state consistent (${contradictions.length} warnings)`
    : `SWARM STATE CONTRADICTION: ${parts.join(", ")}`;

  return {
    hard_count: hard,
    soft_count: soft,
    drift_count: drift,
    contradictions,
    consistent,
    summary,
  };
}

/**
 * Format a contradiction report as human-readable text.
 */
export function formatReport(report: ContradictionReport): string {
  const lines: string[] = [];

  lines.push("⚖️  Swarm Contradiction Report");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (report.contradictions.length === 0) {
    lines.push("✅ No contradictions — all tools agree on swarm state");
  } else {
    for (const c of report.contradictions) {
      const icon =
        c.severity === "HARD" ? "❌" : c.severity === "SOFT" ? "⚠️" : "🌀";
      lines.push("");
      lines.push(`${icon} [${c.severity}] ${c.message}`);
      lines.push(`   Rule: ${c.rule}`);
      lines.push(`   Tools: ${c.tools.join(", ")}`);
      lines.push(`   Keys: ${c.keys.join(", ")}`);
      if (c.delta) {
        lines.push(`   Delta: ${JSON.stringify(c.delta)}`);
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push(`Summary: ${report.summary}`);
  }

  return lines.join("\n");
}

/**
 * Determine CI exit code from a contradiction report.
 */
export function ciExitCode(report: ContradictionReport): number {
  if (report.hard_count > 0) return 3; // hard contradiction = fail
  if (report.soft_count > 0) return 2; // soft contradiction = warning
  if (report.drift_count > 0) return 1; // drift = minor warning
  return 0; // consistent
}
