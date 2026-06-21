import { describe, it, expect, beforeEach } from "vitest";
import {
  latestByKey,
  getNodeState,
  getDHTState,
  getKeyspaceHealth,
  getTunnelState,
} from "../src/projections.js";
import { makeTestEvent, resetClock } from "./helpers.js";

beforeEach(() => resetClock());

// ---------------------------------------------------------------------------
// latestByKey
// ---------------------------------------------------------------------------
describe("latestByKey", () => {
  it("returns empty map for empty input", () => {
    const result = latestByKey([]);
    expect(result.size).toBe(0);
  });

  it("returns one event per key", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 1, logical_time: 1 }),
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 0, logical_time: 2 }),
    ];
    const result = latestByKey(events);
    expect(result.size).toBe(2);
  });

  it("later events overwrite earlier ones for the same key", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 1, logical_time: 1 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 5, logical_time: 3 }),
    ];
    const result = latestByKey(events);
    expect(result.get("dht.peer.count")!.value).toBe(5);
  });

  it("sorts by logical_time regardless of input order", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 99, logical_time: 5 }),
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 1, logical_time: 1 }),
    ];
    const result = latestByKey(events);
    expect(result.get("dht.peer.count")!.value).toBe(99); // lt=5 wins
  });
});

// ---------------------------------------------------------------------------
// getNodeState
// ---------------------------------------------------------------------------
describe("getNodeState", () => {
  it("returns unknown status for unknown node_id", () => {
    const state = getNodeState([], "unknown-node");
    expect(state.status).toBe("unknown");
    expect(state.latest_event).toBeNull();
    expect(state.tool_reports.size).toBe(0);
  });

  it("derives online status from string values", () => {
    for (const val of ["online", "alive", "ok", "reachable"]) {
      const events = [
        makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: val }),
      ];
      const state = getNodeState(events, "n1");
      expect(state.status).toBe("online");
    }
  });

  it("derives offline status from string values", () => {
    for (const val of ["offline", "dead", "unreachable"]) {
      const events = [
        makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: val }),
      ];
      const state = getNodeState(events, "n1");
      expect(state.status).toBe("offline");
    }
  });

  it("derives ghost status", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "ghost" }),
    ];
    const state = getNodeState(events, "n1");
    expect(state.status).toBe("ghost");
  });

  it("derives status from object value with status field", () => {
    const events = [
      makeTestEvent({
        key: "node.status",
        tool: "sim",
        node_id: "n1",
        value: { status: "online" },
      }),
    ];
    const state = getNodeState(events, "n1");
    expect(state.status).toBe("online");
  });

  it("collects per-tool reports", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "ghost" }),
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: "online" }),
    ];
    const state = getNodeState(events, "n1");
    expect(state.tool_reports.size).toBe(2);
    expect(state.tool_reports.has("ghost")).toBe(true);
    expect(state.tool_reports.has("sim")).toBe(true);
  });

  it("ignores events for other node_ids", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: "online" }),
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n2", value: "ghost" }),
    ];
    const state = getNodeState(events, "n1");
    expect(state.status).toBe("online");
  });

  it("latest_event is the last by logical_time", () => {
    const events = [
      makeTestEvent({ key: "node.status", tool: "sim", node_id: "n1", value: "online", logical_time: 1 }),
      makeTestEvent({ key: "node.status", tool: "ghost", node_id: "n1", value: "ghost", logical_time: 5 }),
    ];
    const state = getNodeState(events, "n1");
    expect(state.latest_event!.value).toBe("ghost");
  });
});

// ---------------------------------------------------------------------------
// getDHTState
// ---------------------------------------------------------------------------
describe("getDHTState", () => {
  it("returns defaults for empty events", () => {
    const state = getDHTState([]);
    expect(state.peer_count).toBe(0);
    expect(state.active_nodes).toEqual([]);
    expect(state.orphan_keys).toBe(0);
    expect(state.sources.size).toBe(0);
  });

  it("extracts peer_count from dht.peer.count key", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 5 }),
    ];
    const state = getDHTState(events);
    expect(state.peer_count).toBe(5);
  });

  it("extracts active_nodes from dht.active.nodes array", () => {
    const events = [
      makeTestEvent({ key: "dht.active.nodes", tool: "sim", value: ["a", "b", "c"] }),
    ];
    const state = getDHTState(events);
    expect(state.active_nodes).toEqual(["a", "b", "c"]);
  });

  it("extracts active_nodes from node_id on DHT events", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", node_id: "node-1", value: 3 }),
    ];
    const state = getDHTState(events);
    expect(state.active_nodes).toContain("node-1");
  });

  it("extracts orphan_keys", () => {
    const events = [
      makeTestEvent({ key: "dht.orphan.keys", tool: "keyspace", value: 7 }),
    ];
    const state = getDHTState(events);
    expect(state.orphan_keys).toBe(7);
  });

  it("tracks sources per tool", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count.bootstrap", tool: "bootstrap", value: 3 }),
      makeTestEvent({ key: "dht.peer.count.sim", tool: "sim", value: 3 }),
    ];
    const state = getDHTState(events);
    expect(state.sources.has("bootstrap")).toBe(true);
    expect(state.sources.has("sim")).toBe(true);
  });

  it("ignores non-DHT events", () => {
    const events = [
      makeTestEvent({ key: "ghost.count", tool: "ghost", value: 2 }),
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "ready" }),
    ];
    const state = getDHTState(events);
    expect(state.peer_count).toBe(0);
    expect(state.sources.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getKeyspaceHealth
// ---------------------------------------------------------------------------
describe("getKeyspaceHealth", () => {
  it("returns all zeros for empty events", () => {
    const health = getKeyspaceHealth([]);
    expect(health.vless_count).toBe(0);
    expect(health.hy2_count).toBe(0);
    expect(health.tombstone_count).toBe(0);
    expect(health.orphan_keys).toBe(0);
    expect(health.total_keys).toBe(0);
  });

  it("extracts all keyspace metrics", () => {
    const events = [
      makeTestEvent({ key: "keyspace.vless.count", tool: "keyspace", value: 10 }),
      makeTestEvent({ key: "keyspace.hysteria2.count", tool: "keyspace", value: 5 }),
      makeTestEvent({ key: "keyspace.tombstone.count", tool: "keyspace", value: 2 }),
      makeTestEvent({ key: "keyspace.orphan.keys", tool: "keyspace", value: 1 }),
    ];
    const health = getKeyspaceHealth(events);
    expect(health.vless_count).toBe(10);
    expect(health.hy2_count).toBe(5);
    expect(health.tombstone_count).toBe(2);
    expect(health.orphan_keys).toBe(1);
    expect(health.total_keys).toBe(17);
  });

  it("uses latest value when multiple events exist for same key", () => {
    const events = [
      makeTestEvent({ key: "keyspace.vless.count", tool: "keyspace", value: 10, logical_time: 1 }),
      makeTestEvent({ key: "keyspace.vless.count", tool: "keyspace", value: 20, logical_time: 5 }),
    ];
    const health = getKeyspaceHealth(events);
    expect(health.vless_count).toBe(20);
  });

  it("ignores non-keyspace events", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 99 }),
    ];
    const health = getKeyspaceHealth(events);
    expect(health.vless_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTunnelState
// ---------------------------------------------------------------------------
describe("getTunnelState", () => {
  it("returns defaults for empty events", () => {
    const state = getTunnelState([]);
    expect(state.status).toBe("unknown");
    expect(state.provider).toBeNull();
    expect(state.host).toBeNull();
    expect(state.port).toBeNull();
  });

  it("extracts all tunnel fields from string values", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "ready" }),
      makeTestEvent({ key: "tunnel.provider", tool: "tunnel", value: "cloudflare" }),
      makeTestEvent({ key: "tunnel.host", tool: "tunnel", value: "example.com" }),
      makeTestEvent({ key: "tunnel.port", tool: "tunnel", value: 443 }),
    ];
    const state = getTunnelState(events);
    expect(state.status).toBe("ready");
    expect(state.provider).toBe("cloudflare");
    expect(state.host).toBe("example.com");
    expect(state.port).toBe(443);
  });

  it("latest event wins for each field", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "connecting", logical_time: 1 }),
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "ready", logical_time: 5 }),
    ];
    const state = getTunnelState(events);
    expect(state.status).toBe("ready");
  });

  it("handles object-valued events with nested status/provider/host/port", () => {
    const events = [
      makeTestEvent({
        key: "tunnel.status",
        tool: "tunnel",
        value: { status: "reconnecting", provider: "ngrok" },
      }),
    ];
    const state = getTunnelState(events);
    expect(state.status).toBe("reconnecting");
    expect(state.provider).toBe("ngrok");
  });

  it("tracks sources by tool:key composite key", () => {
    const events = [
      makeTestEvent({ key: "tunnel.status", tool: "tunnel", value: "ready" }),
      makeTestEvent({ key: "tunnel.provider", tool: "tunnel", value: "cf" }),
    ];
    const state = getTunnelState(events);
    expect(state.sources.size).toBe(2);
    expect(state.sources.has("tunnel:tunnel.status")).toBe(true);
    expect(state.sources.has("tunnel:tunnel.provider")).toBe(true);
  });

  it("ignores non-tunnel events", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", value: 3 }),
    ];
    const state = getTunnelState(events);
    expect(state.status).toBe("unknown");
  });
});
