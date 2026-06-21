import { describe, it, expect, beforeEach } from "vitest";
import {
  detectContradictions,
  formatReport,
  ciExitCode,
  DEFAULT_TEMPORAL_CONFIG,
} from "../src/contradictions.js";
import type { TemporalConfig } from "../src/contradictions.js";
import { makeTestEvent, resetClock } from "./helpers.js";

beforeEach(() => resetClock());

// Convenience: create events with a shared timestamp (within hard_skew_ms window)
const NOW = Date.now();

// ---------------------------------------------------------------------------
// detectContradictions — consistent (happy path)
// ---------------------------------------------------------------------------
describe("detectContradictions — consistent state", () => {
  it("returns consistent report for empty events", () => {
    const report = detectContradictions([]);
    expect(report.consistent).toBe(true);
    expect(report.hard_count).toBe(0);
    expect(report.soft_count).toBe(0);
    expect(report.drift_count).toBe(0);
    expect(report.contradictions).toEqual([]);
  });

  it("returns consistent when bootstrap and sim agree on peer count", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 3, timestamp: NOW }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 3, timestamp: NOW }),
    ];
    const report = detectContradictions(events);
    expect(report.consistent).toBe(true);
    expect(report.hard_count).toBe(0);
  });

  it("returns consistent when tunnel is ready and announced is true", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "ready" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dht-peer-count-consistency (HARD)
// ---------------------------------------------------------------------------
describe("invariant: dht-peer-count-consistency", () => {
  it("HARD when bootstrap=0 and sim>0 within hard_skew_ms", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 0, timestamp: NOW }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 3, timestamp: NOW + 1000 }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(1);
    expect(report.consistent).toBe(false);
    const c = report.contradictions[0];
    expect(c.rule).toBe("dht-peer-count-consistency");
    expect(c.severity).toBe("HARD");
    expect(c.tools).toContain("bootstrap");
    expect(c.tools).toContain("sim");
  });

  it("SOFT when bootstrap=0 and sim>0, skew between hard and soft thresholds", () => {
    const hardMs = DEFAULT_TEMPORAL_CONFIG.hard_skew_ms;
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 0, timestamp: NOW }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 2, timestamp: NOW + hardMs + 1000 }),
    ];
    const report = detectContradictions(events);
    expect(report.soft_count).toBe(1);
    expect(report.hard_count).toBe(0);
    expect(report.contradictions[0].severity).toBe("SOFT");
  });

  it("no contradiction when skew exceeds soft_skew_ms (too far apart to compare)", () => {
    const softMs = DEFAULT_TEMPORAL_CONFIG.soft_skew_ms;
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 0, timestamp: NOW }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 5, timestamp: NOW + softMs + 1000 }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
    expect(report.soft_count).toBe(0);
  });

  it("no contradiction when both are 0", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 0, timestamp: NOW }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 0, timestamp: NOW }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });

  it("no contradiction when both are > 0", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 2, timestamp: NOW }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 3, timestamp: NOW }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });

  it("no contradiction when only one source reports", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 0, timestamp: NOW }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// node-liveness-consistency (HARD)
// ---------------------------------------------------------------------------
describe("invariant: node-liveness-consistency", () => {
  it("HARD when ghost says offline and sim says online for same node", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "offline" }),
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: "online" }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(1);
    const c = report.contradictions.find((c) => c.rule === "node-liveness-consistency");
    expect(c).toBeDefined();
    expect(c!.message).toContain("n1");
  });

  it("no contradiction for different node_ids", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "offline" }),
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n2", value: "online" }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });

  it("no contradiction when ghost says ghost (not offline)", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "ghost" }),
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: "online" }),
    ];
    const report = detectContradictions(events);
    const liveness = report.contradictions.find((c) => c.rule === "node-liveness-consistency");
    expect(liveness).toBeUndefined();
  });

  it("no contradiction when sim doesn't say online", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "offline" }),
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: "offline" }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// keyspace-orphan-consistency (DRIFT)
// ---------------------------------------------------------------------------
describe("invariant: keyspace-orphan-consistency", () => {
  it("DRIFT when clean state + orphan keys > 0", () => {
    const events = [
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 5 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.drift_count).toBe(1);
    const c = report.contradictions.find((c) => c.rule === "keyspace-orphan-consistency");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("DRIFT");
  });

  it("no contradiction when orphan_keys = 0", () => {
    const events = [
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 0 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.drift_count).toBe(0);
  });

  it("no contradiction when clean state is false", () => {
    const events = [
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 5 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: false }),
    ];
    const report = detectContradictions(events);
    expect(report.drift_count).toBe(0);
  });

  it("no contradiction when no clean state event exists", () => {
    const events = [
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 5 }),
    ];
    const report = detectContradictions(events);
    expect(report.drift_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tunnel-vs-announce-consistency (HARD)
// ---------------------------------------------------------------------------
describe("invariant: tunnel-vs-announce-consistency", () => {
  it("HARD when tunnel=failed and announced=true", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(1);
    const c = report.contradictions.find((c) => c.rule === "tunnel-vs-announce-consistency");
    expect(c).toBeDefined();
    expect(c!.keys).toContain("tunnel.status");
    expect(c!.keys).toContain("dht.announced");
  });

  it("no contradiction when tunnel=ready and announced=true", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "ready" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });

  it("no contradiction when tunnel=failed and announced=false", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: false }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });

  it("no contradiction when tunnel=failed but no announce event", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });

  it("no contradiction when announced=true but no tunnel event", () => {
    const events = [
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ghost-density (SOFT)
// ---------------------------------------------------------------------------
describe("invariant: ghost-density", () => {
  it("SOFT when ghost ratio exceeds threshold", () => {
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 2 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 3 }),
    ];
    const report = detectContradictions(events);
    expect(report.soft_count).toBe(1);
    const c = report.contradictions.find((c) => c.rule === "ghost-density");
    expect(c).toBeDefined();
    expect(c!.delta).toEqual({ ghost_ratio: 2 / 3 });
  });

  it("no contradiction when ghost ratio is below threshold", () => {
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 1 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
    ];
    const report = detectContradictions(events);
    expect(report.soft_count).toBe(0);
  });

  it("no contradiction when ghost ratio is exactly at threshold", () => {
    // threshold is 0.5 — ratio must EXCEED, not equal
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 5 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
    ];
    const report = detectContradictions(events);
    expect(report.soft_count).toBe(0);
  });

  it("no contradiction when peer_count is 0 (division guard)", () => {
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 5 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 0 }),
    ];
    const report = detectContradictions(events);
    expect(report.soft_count).toBe(0);
  });

  it("no contradiction when ghost count missing", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 5 }),
    ];
    const report = detectContradictions(events);
    expect(report.soft_count).toBe(0);
  });

  it("respects custom ghost_ratio_threshold", () => {
    const customConfig: TemporalConfig = {
      ...DEFAULT_TEMPORAL_CONFIG,
      ghost_ratio_threshold: 0.1, // very strict
    };
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 1 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 5 }),
    ];
    const report = detectContradictions(events, customConfig);
    expect(report.soft_count).toBe(1); // 1/5 = 20% > 10%
  });
});

// ---------------------------------------------------------------------------
// Multiple invariants at once
// ---------------------------------------------------------------------------
describe("detectContradictions — multiple invariants", () => {
  it("can detect both HARD and SOFT simultaneously", () => {
    const events = [
      // Hard: tunnel failed + announced
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
      // Soft: high ghost ratio
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 8 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
    ];
    const report = detectContradictions(events);
    expect(report.hard_count).toBe(1);
    expect(report.soft_count).toBe(1);
    expect(report.consistent).toBe(false);
  });

  it("summary string reflects all counts", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 3 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: true }),
    ];
    const report = detectContradictions(events);
    expect(report.summary).toContain("hard");
    expect(report.summary).toContain("drift");
  });
});

// ---------------------------------------------------------------------------
// ciExitCode
// ---------------------------------------------------------------------------
describe("ciExitCode", () => {
  it("returns 0 for consistent report", () => {
    const report = detectContradictions([]);
    expect(ciExitCode(report)).toBe(0);
  });

  it("returns 3 for hard contradictions", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
    ];
    const report = detectContradictions(events);
    expect(ciExitCode(report)).toBe(3);
  });

  it("returns 2 for soft contradictions only", () => {
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 8 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
    ];
    const report = detectContradictions(events);
    expect(ciExitCode(report)).toBe(2);
  });

  it("returns 1 for drift only", () => {
    const events = [
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 3 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: true }),
    ];
    const report = detectContradictions(events);
    expect(ciExitCode(report)).toBe(1);
  });

  it("hard takes precedence over soft and drift", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 8 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 3 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: true }),
    ];
    const report = detectContradictions(events);
    expect(ciExitCode(report)).toBe(3); // hard wins
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------
describe("formatReport", () => {
  it("shows success message for consistent report", () => {
    const report = detectContradictions([]);
    const text = formatReport(report);
    expect(text).toContain("No contradictions");
    expect(text).toContain("all tools agree");
  });

  it("includes severity icon for each contradiction type", () => {
    // Build a report with all 3 types
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 8 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 3 }),
      makeTestEvent({ key: "dht.state.clean", tool: "bootstrap", value: true }),
    ];
    const report = detectContradictions(events);
    const text = formatReport(report);
    expect(text).toContain("[HARD]");
    expect(text).toContain("[SOFT]");
    expect(text).toContain("[DRIFT]");
  });

  it("includes rule name and tools in output", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "failed" }),
      makeTestEvent({ key: "dht.announced", tool: "sim", value: true }),
    ];
    const report = detectContradictions(events);
    const text = formatReport(report);
    expect(text).toContain("tunnel-vs-announce-consistency");
    expect(text).toContain("tunnel");
    expect(text).toContain("sim");
  });

  it("includes delta when present", () => {
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 8 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 10 }),
    ];
    const report = detectContradictions(events);
    const text = formatReport(report);
    expect(text).toContain("Delta:");
    expect(text).toContain("ghost_ratio");
  });
});
