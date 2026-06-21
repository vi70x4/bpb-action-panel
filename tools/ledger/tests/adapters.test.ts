import { describe, it, expect } from "vitest";
import {
  normalizeBootstrap,
  normalizeSim,
  normalizeGhost,
  normalizeKeyspace,
  normalizeTunnel,
  normalizeSpec,
} from "../src/adapters.js";
import type {
  BootstrapOutput,
  SimOutput,
  GhostOutput,
  KeyspaceOutput,
  TunnelOutput,
  SpecOutput,
} from "../src/adapters.js";

const RUN_ID = "test-run";

// ---------------------------------------------------------------------------
// normalizeBootstrap
// ---------------------------------------------------------------------------
describe("normalizeBootstrap", () => {
  it("emits peer count event for successful run", () => {
    const output: BootstrapOutput = {
      exit_code: 0,
      reachable: 3,
      total: 5,
    };
    const events = normalizeBootstrap(output, RUN_ID);
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("dht.peer.count.bootstrap");
    expect(events[0].value).toBe(3);
    expect(events[0].tool).toBe("bootstrap");
    expect(events[0].confidence).toBe(1.0);
    expect(events[0].meta?.exit_code).toBe(0);
    expect(events[0].meta?.total).toBe(5);
  });

  it("emits lower confidence for non-zero exit", () => {
    const output: BootstrapOutput = { exit_code: 1, reachable: 0, total: 3 };
    const events = normalizeBootstrap(output, RUN_ID);
    expect(events[0].confidence).toBe(0.8);
  });

  it("emits dht.state.clean when exit_code is 3", () => {
    const output: BootstrapOutput = { exit_code: 3, reachable: 0, total: 0 };
    const events = normalizeBootstrap(output, RUN_ID);
    expect(events.length).toBe(2);
    const cleanEvent = events.find((e) => e.key === "dht.state.clean");
    expect(cleanEvent).toBeDefined();
    expect(cleanEvent!.value).toBe(true);
    expect(cleanEvent!.type).toBe("STATE");
    expect(cleanEvent!.meta?.reason).toBe("no_peers_configured");
  });

  it("emits per-peer events when peers array provided", () => {
    const output: BootstrapOutput = {
      exit_code: 0,
      reachable: 2,
      total: 2,
      peers: [
        { multiaddr: "/ip4/1.2.3.4/tcp/4001", status: "ok", latency_ms: 50 },
        { multiaddr: "/ip4/5.6.7.8/tcp/4001", status: "timeout", latency_ms: null },
      ],
    };
    const events = normalizeBootstrap(output, RUN_ID);
    // 1 peer count + 2 per-peer events
    expect(events.length).toBe(3);
    const peerEvents = events.filter((e) => e.key === "bootstrap.peer.status");
    expect(peerEvents.length).toBe(2);
    expect(peerEvents[0].value).toBe("ok");
    expect(peerEvents[0].confidence).toBe(1.0);
    expect(peerEvents[1].value).toBe("timeout");
    expect(peerEvents[1].confidence).toBe(0.7);
  });

  it("handles empty peers array", () => {
    const output: BootstrapOutput = { exit_code: 0, reachable: 0, total: 0, peers: [] };
    const events = normalizeBootstrap(output, RUN_ID);
    expect(events.length).toBe(1); // only peer count, no per-peer events
  });

  it("does not emit state.clean for non-3 exit codes", () => {
    for (const code of [0, 1, 2, 4]) {
      const events = normalizeBootstrap({ exit_code: code, reachable: 0, total: 0 }, RUN_ID);
      expect(events.find((e) => e.key === "dht.state.clean")).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeSim
// ---------------------------------------------------------------------------
describe("normalizeSim", () => {
  it("emits sim-qualified peer count + announced + unqualified count", () => {
    const output: SimOutput = {
      exit_code: 0,
      node_count: 3,
      peers_discovered: [2, 2, 2],
      full_mesh: true,
    };
    const events = normalizeSim(output, RUN_ID);
    expect(events.length).toBe(3);

    const simCount = events.find((e) => e.key === "dht.peer.count.sim");
    expect(simCount!.value).toBe(2); // average of [2,2,2]
    expect(simCount!.confidence).toBe(1.0);
    expect(simCount!.meta?.full_mesh).toBe(true);

    const announced = events.find((e) => e.key === "dht.announced");
    expect(announced!.value).toBe(true);

    const unqual = events.find((e) => e.key === "dht.peer.count");
    expect(unqual!.value).toBe(3); // node_count
  });

  it("announced is false when exit_code is non-zero", () => {
    const output: SimOutput = {
      exit_code: 1,
      node_count: 2,
      peers_discovered: [1, 1],
      full_mesh: false,
    };
    const events = normalizeSim(output, RUN_ID);
    const announced = events.find((e) => e.key === "dht.announced");
    expect(announced!.value).toBe(false);
  });

  it("computes average peers correctly with uneven distribution", () => {
    const output: SimOutput = {
      exit_code: 0,
      node_count: 3,
      peers_discovered: [1, 2, 3],
      full_mesh: true,
    };
    const events = normalizeSim(output, RUN_ID);
    const simCount = events.find((e) => e.key === "dht.peer.count.sim");
    expect(simCount!.value).toBe(2); // (1+2+3)/3
  });

  it("handles empty peers_discovered (divides by 1 to avoid NaN)", () => {
    const output: SimOutput = {
      exit_code: 1,
      node_count: 0,
      peers_discovered: [],
      full_mesh: false,
    };
    const events = normalizeSim(output, RUN_ID);
    const simCount = events.find((e) => e.key === "dht.peer.count.sim");
    expect(simCount!.value).toBe(0); // 0/1 = 0

    // No unqualified count event when peers_discovered is empty
    const unqual = events.find((e) => e.key === "dht.peer.count");
    expect(unqual).toBeUndefined();
  });

  it("confidence is 0.9 when not full mesh", () => {
    const output: SimOutput = {
      exit_code: 0,
      node_count: 2,
      peers_discovered: [1, 0],
      full_mesh: false,
    };
    const events = normalizeSim(output, RUN_ID);
    expect(events[0].confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// normalizeGhost
// ---------------------------------------------------------------------------
describe("normalizeGhost", () => {
  it("emits ghost count event", () => {
    const output: GhostOutput = {
      exit_code: 0,
      alive: 3,
      ghost: 1,
      stale: 0,
      unreachable: 0,
    };
    const events = normalizeGhost(output, RUN_ID);
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("ghost.count");
    expect(events[0].value).toBe(1);
    expect(events[0].type).toBe("OBSERVATION");
    expect(events[0].meta?.alive).toBe(3);
  });

  it("emits per-node ghost events when ghost_peers provided", () => {
    const output: GhostOutput = {
      exit_code: 0,
      alive: 1,
      ghost: 2,
      stale: 0,
      unreachable: 0,
      ghost_peers: ["peer-A", "peer-B"],
    };
    const events = normalizeGhost(output, RUN_ID);
    expect(events.length).toBe(3); // 1 count + 2 per-node
    const nodeEvents = events.filter((e) => e.key === "node.status");
    expect(nodeEvents.length).toBe(2);
    expect(nodeEvents[0].value).toBe("ghost");
    expect(nodeEvents[0].node_id).toBe("peer-A");
    expect(nodeEvents[1].node_id).toBe("peer-B");
  });

  it("handles zero ghosts", () => {
    const output: GhostOutput = {
      exit_code: 0,
      alive: 5,
      ghost: 0,
      stale: 0,
      unreachable: 0,
    };
    const events = normalizeGhost(output, RUN_ID);
    expect(events[0].value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeKeyspace
// ---------------------------------------------------------------------------
describe("normalizeKeyspace", () => {
  it("emits 4 events for all keyspace metrics", () => {
    const output: KeyspaceOutput = {
      exit_code: 0,
      vless_count: 5,
      hy2_count: 3,
      tombstone_count: 1,
      orphan_keys: 0,
    };
    const events = normalizeKeyspace(output, RUN_ID);
    expect(events.length).toBe(4);

    expect(events.find((e) => e.key === "keyspace.vless.count")!.value).toBe(5);
    expect(events.find((e) => e.key === "keyspace.hysteria2.count")!.value).toBe(3);
    expect(events.find((e) => e.key === "keyspace.tombstone.count")!.value).toBe(1);
    expect(events.find((e) => e.key === "keyspace.orphan.keys")!.value).toBe(0);
  });

  it("orphan_keys event type is OBSERVATION when orphans > 0", () => {
    const output: KeyspaceOutput = {
      exit_code: 0,
      vless_count: 0,
      hy2_count: 0,
      tombstone_count: 0,
      orphan_keys: 3,
    };
    const events = normalizeKeyspace(output, RUN_ID);
    const orphan = events.find((e) => e.key === "keyspace.orphan.keys");
    expect(orphan!.type).toBe("OBSERVATION");
  });

  it("orphan_keys event type is FACT when orphans = 0", () => {
    const output: KeyspaceOutput = {
      exit_code: 0,
      vless_count: 0,
      hy2_count: 0,
      tombstone_count: 0,
      orphan_keys: 0,
    };
    const events = normalizeKeyspace(output, RUN_ID);
    const orphan = events.find((e) => e.key === "keyspace.orphan.keys");
    expect(orphan!.type).toBe("FACT");
  });
});

// ---------------------------------------------------------------------------
// normalizeTunnel
// ---------------------------------------------------------------------------
describe("normalizeTunnel", () => {
  it("emits status + provider always, host/port only when present", () => {
    const output: TunnelOutput = {
      status: "ready",
      provider: "cloudflare",
      host: "example.com",
      port: 443,
      exit_code: 0,
    };
    const events = normalizeTunnel(output, RUN_ID);
    expect(events.length).toBe(4);
    expect(events.find((e) => e.key === "tunnel.status")!.value).toBe("ready");
    expect(events.find((e) => e.key === "tunnel.provider")!.value).toBe("cloudflare");
    expect(events.find((e) => e.key === "tunnel.host")!.value).toBe("example.com");
    expect(events.find((e) => e.key === "tunnel.port")!.value).toBe(443);
  });

  it("omits host/port when not provided", () => {
    const output: TunnelOutput = {
      status: "failed",
      provider: "trycloudflare",
      exit_code: 1,
    };
    const events = normalizeTunnel(output, RUN_ID);
    expect(events.length).toBe(2);
    expect(events.find((e) => e.key === "tunnel.host")).toBeUndefined();
    expect(events.find((e) => e.key === "tunnel.port")).toBeUndefined();
  });

  it("confidence is 1.0 on exit_code 0, 0.6 otherwise", () => {
    const ok = normalizeTunnel({ status: "ready", provider: "cf", exit_code: 0 }, RUN_ID);
    expect(ok[0].confidence).toBe(1.0);

    const fail = normalizeTunnel({ status: "failed", provider: "cf", exit_code: 1 }, RUN_ID);
    expect(fail[0].confidence).toBe(0.6);
  });

  it("tunnel status event is type STATE", () => {
    const events = normalizeTunnel(
      { status: "connecting", provider: "ngrok", exit_code: 0 },
      RUN_ID,
    );
    expect(events[0].type).toBe("STATE");
  });
});

// ---------------------------------------------------------------------------
// normalizeSpec
// ---------------------------------------------------------------------------
describe("normalizeSpec", () => {
  it("emits a single spec.alignment event", () => {
    const output: SpecOutput = {
      exit_code: 0,
      checks_passed: 10,
      checks_total: 10,
      drift_detected: false,
    };
    const events = normalizeSpec(output, RUN_ID);
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("spec.alignment");
    expect(events[0].value).toBe(true); // !drift_detected
    expect(events[0].confidence).toBe(0.85);
    expect(events[0].type).toBe("OBSERVATION");
    expect(events[0].meta?.checks_passed).toBe(10);
    expect(events[0].meta?.checks_total).toBe(10);
  });

  it("alignment is false when drift detected", () => {
    const output: SpecOutput = {
      exit_code: 1,
      checks_passed: 8,
      checks_total: 10,
      drift_detected: true,
    };
    const events = normalizeSpec(output, RUN_ID);
    expect(events[0].value).toBe(false);
  });
});
