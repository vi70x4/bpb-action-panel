import { describe, it, expect, beforeEach } from "vitest";
import { buildCausalEdges, getAncestors, getDescendants } from "../src/causal.js";
import { makeTestEvent, resetClock } from "./helpers.js";

beforeEach(() => resetClock());

// ---------------------------------------------------------------------------
// buildCausalEdges
// ---------------------------------------------------------------------------
describe("buildCausalEdges", () => {
  it("returns empty array for empty events", () => {
    expect(buildCausalEdges([])).toEqual([]);
  });

  // Explicit parent_id edges
  it("creates explicit edges from parent_id", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "dht.peer.count", tool: "sim", logical_time: 2, parent_id: "a" }),
    ];
    const edges = buildCausalEdges(events);
    const explicit = edges.filter((e) => e.kind === "explicit");
    expect(explicit.length).toBe(1);
    expect(explicit[0]).toEqual({ from: "a", to: "b", kind: "explicit" });
  });

  it("ignores parent_id that doesn't exist in events", () => {
    const events = [
      makeTestEvent({ id: "b", key: "dht.peer.count", tool: "sim", parent_id: "nonexistent" }),
    ];
    const edges = buildCausalEdges(events);
    const explicit = edges.filter((e) => e.kind === "explicit");
    expect(explicit.length).toBe(0);
  });

  // Same-node temporal edges
  it("creates same_node edges for events with matching node_id", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", node_id: "n1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", node_id: "n1", logical_time: 2 }),
    ];
    const edges = buildCausalEdges(events);
    const sameNode = edges.filter((e) => e.kind === "same_node");
    expect(sameNode.length).toBe(1);
    expect(sameNode[0]).toEqual({ from: "a", to: "b", kind: "same_node" });
  });

  it("creates chained same_node edges for 3+ events on same node", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", node_id: "n1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", node_id: "n1", logical_time: 2 }),
      makeTestEvent({ id: "c", key: "tunnel.status", tool: "tunnel", node_id: "n1", logical_time: 3 }),
    ];
    const edges = buildCausalEdges(events);
    const sameNode = edges.filter((e) => e.kind === "same_node");
    expect(sameNode.length).toBe(2); // a→b, b→c
  });

  it("does not create same_node edges between different node_ids", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", node_id: "n1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", node_id: "n2", logical_time: 2 }),
    ];
    const edges = buildCausalEdges(events);
    const sameNode = edges.filter((e) => e.kind === "same_node");
    expect(sameNode.length).toBe(0);
  });

  it("ignores events without node_id for same_node edges", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", logical_time: 2 }),
    ];
    const edges = buildCausalEdges(events);
    const sameNode = edges.filter((e) => e.kind === "same_node");
    expect(sameNode.length).toBe(0);
  });

  // Same-run temporal edges
  it("creates same_run edges between different tools in the same run", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", run_id: "r1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", run_id: "r1", logical_time: 2 }),
    ];
    const edges = buildCausalEdges(events);
    const sameRun = edges.filter((e) => e.kind === "same_run");
    expect(sameRun.length).toBe(1);
    expect(sameRun[0]).toEqual({ from: "a", to: "b", kind: "same_run" });
  });

  it("does NOT create same_run edges between same tool events", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", run_id: "r1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "dht.announced", tool: "sim", run_id: "r1", logical_time: 2 }),
    ];
    const edges = buildCausalEdges(events);
    const sameRun = edges.filter((e) => e.kind === "same_run");
    expect(sameRun.length).toBe(0);
  });

  it("does not create same_run edges across different run_ids", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", run_id: "r1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", run_id: "r2", logical_time: 2 }),
    ];
    const edges = buildCausalEdges(events);
    const sameRun = edges.filter((e) => e.kind === "same_run");
    expect(sameRun.length).toBe(0);
  });

  // Combined edge types
  it("produces all edge types together", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", node_id: "n1", run_id: "r1", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", node_id: "n1", run_id: "r1", logical_time: 2, parent_id: "a" }),
    ];
    const edges = buildCausalEdges(events);
    const kinds = new Set(edges.map((e) => e.kind));
    expect(kinds.has("explicit")).toBe(true);
    expect(kinds.has("same_node")).toBe(true);
    expect(kinds.has("same_run")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAncestors
// ---------------------------------------------------------------------------
describe("getAncestors", () => {
  it("returns self + ancestors in topological order", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", logical_time: 2, parent_id: "a" }),
      makeTestEvent({ id: "c", key: "tunnel.status", tool: "tunnel", logical_time: 3, parent_id: "b" }),
    ];
    const edges = buildCausalEdges(events);
    const ancestors = getAncestors(events, edges, "c");
    const ids = ancestors.map((e) => e.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("returns only self when no parents exist", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
    ];
    const edges = buildCausalEdges(events);
    const ancestors = getAncestors(events, edges, "a");
    expect(ancestors.length).toBe(1);
    expect(ancestors[0].id).toBe("a");
  });

  it("handles diamond-shaped DAG without duplicates", () => {
    // a → b, a → c, b → d, c → d
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", node_id: "n1", logical_time: 2, parent_id: "a" }),
      makeTestEvent({ id: "c", key: "tunnel.status", tool: "tunnel", node_id: "n2", logical_time: 3, parent_id: "a" }),
      makeTestEvent({ id: "d", key: "dht.announced", tool: "sim", node_id: "n1", logical_time: 4, parent_id: "b" }),
    ];
    const edges = buildCausalEdges(events);
    // Add c→d edge manually (not auto-generated since different node_id)
    edges.push({ from: "c", to: "d", kind: "explicit" });
    const ancestors = getAncestors(events, edges, "d");
    const ids = ancestors.map((e) => e.id);
    // All 4 should appear exactly once
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain("a");
    expect(ids).toContain("d");
  });

  it("returns empty for unknown event id", () => {
    const events = [makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim" })];
    const ancestors = getAncestors(events, [], "nonexistent");
    expect(ancestors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getDescendants
// ---------------------------------------------------------------------------
describe("getDescendants", () => {
  it("returns self + descendants", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", logical_time: 2, parent_id: "a" }),
      makeTestEvent({ id: "c", key: "tunnel.status", tool: "tunnel", logical_time: 3, parent_id: "b" }),
    ];
    const edges = buildCausalEdges(events);
    const descendants = getDescendants(events, edges, "a");
    const ids = descendants.map((e) => e.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  it("returns only self when no children exist", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
    ];
    const edges = buildCausalEdges(events);
    const descendants = getDescendants(events, edges, "a");
    expect(descendants.length).toBe(1);
  });

  it("handles branching descendants", () => {
    const events = [
      makeTestEvent({ id: "a", key: "dht.peer.count", tool: "sim", logical_time: 1 }),
      makeTestEvent({ id: "b", key: "ghost.count", tool: "ghost", logical_time: 2, parent_id: "a" }),
      makeTestEvent({ id: "c", key: "tunnel.status", tool: "tunnel", logical_time: 3, parent_id: "a" }),
    ];
    const edges = buildCausalEdges(events);
    const descendants = getDescendants(events, edges, "a");
    expect(descendants.length).toBe(3);
  });

  it("returns empty for unknown event id", () => {
    const descendants = getDescendants([], [], "nonexistent");
    expect(descendants.length).toBe(0);
  });
});
