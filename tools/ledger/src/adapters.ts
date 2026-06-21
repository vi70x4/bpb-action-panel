/**
 * Adapters — normalize tool outputs into SwarmEvents.
 *
 * Each adapter takes a tool's stdout JSON or exit code and produces
 * one or more SwarmEvents that the ledger can ingest.
 *
 * These are the "sensor calibration" layer — without them, each tool
 * speaks its own language and cross-tool consistency is impossible.
 */

import type { SwarmEvent } from "./types.js";
import { normalizeKey } from "./schema.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function makeEvent(opts: {
  tool: string;
  key: string;
  value: unknown;
  run_id: string;
  node_id?: string;
  confidence?: number;
  type?: SwarmEvent["type"];
  parent_id?: string;
  meta?: Record<string, unknown>;
}): Omit<SwarmEvent, "id" | "logical_time"> {
  const canonicalKey = normalizeKey(opts.key);
  return {
    tool: opts.tool,
    key: canonicalKey,
    value: opts.value,
    timestamp: Date.now(),
    run_id: opts.run_id,
    node_id: opts.node_id,
    confidence: opts.confidence ?? 1.0,
    type: opts.type ?? "FACT",
    parent_id: opts.parent_id,
    meta: opts.meta,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap adapter
// ---------------------------------------------------------------------------

export interface BootstrapOutput {
  exit_code: number;
  reachable: number;
  total: number;
  peers?: Array<{
    multiaddr: string;
    status: string;
    latency_ms: number | null;
  }>;
}

export function normalizeBootstrap(
  output: BootstrapOutput,
  runId: string,
): Omit<SwarmEvent, "id" | "logical_time">[] {
  const events: Omit<SwarmEvent, "id" | "logical_time">[] = [];

  events.push(
    makeEvent({
      tool: "bootstrap",
      key: "dht.peer.count.bootstrap",
      value: output.reachable,
      run_id: runId,
      confidence: output.exit_code === 0 ? 1.0 : 0.8,
      meta: { exit_code: output.exit_code, total: output.total },
    }),
  );

  if (output.exit_code === 3) {
    events.push(
      makeEvent({
        tool: "bootstrap",
        key: "dht.state.clean",
        value: true,
        run_id: runId,
        confidence: 1.0,
        type: "STATE",
        meta: { reason: "no_peers_configured" },
      }),
    );
  }

  // Per-peer events
  if (output.peers) {
    for (const p of output.peers) {
      events.push(
        makeEvent({
          tool: "bootstrap",
          key: "bootstrap.peer.status",
          value: p.status,
          run_id: runId,
          confidence: p.status === "ok" ? 1.0 : 0.7,
          type: "OBSERVATION",
          meta: { multiaddr: p.multiaddr, latency_ms: p.latency_ms },
        }),
      );
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Sim adapter
// ---------------------------------------------------------------------------

export interface SimOutput {
  exit_code: number;
  node_count: number;
  peers_discovered: number[];
  full_mesh: boolean;
}

export function normalizeSim(
  output: SimOutput,
  runId: string,
): Omit<SwarmEvent, "id" | "logical_time">[] {
  const events: Omit<SwarmEvent, "id" | "logical_time">[] = [];

  events.push(
    makeEvent({
      tool: "sim",
      key: "dht.peer.count.sim",
      value:
        output.peers_discovered.reduce((a, b) => a + b, 0) /
        (output.peers_discovered.length || 1),
      run_id: runId,
      confidence: output.full_mesh ? 1.0 : 0.9,
      type: "FACT",
      meta: {
        node_count: output.node_count,
        peers_per_node: output.peers_discovered,
        full_mesh: output.full_mesh,
      },
    }),
  );

  events.push(
    makeEvent({
      tool: "sim",
      key: "dht.announced",
      value: output.exit_code === 0,
      run_id: runId,
      confidence: 1.0,
      type: "STATE",
    }),
  );

  // Also emit an unqualified dht.peer_count for cross-tool comparison
  // (note: may be overwritten if bootstrap writes to same key)
  if (output.peers_discovered.length > 0) {
    events.push(
      makeEvent({
        tool: "sim",
        key: "dht.peer.count",
        value: output.node_count,
        run_id: runId,
        confidence: output.full_mesh ? 1.0 : 0.9,
        type: "FACT",
      }),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// Ghost detector adapter
// ---------------------------------------------------------------------------

export interface GhostOutput {
  exit_code: number;
  alive: number;
  ghost: number;
  stale: number;
  unreachable: number;
  ghost_peers?: string[];
}

export function normalizeGhost(
  output: GhostOutput,
  runId: string,
): Omit<SwarmEvent, "id" | "logical_time">[] {
  const events: Omit<SwarmEvent, "id" | "logical_time">[] = [];

  events.push(
    makeEvent({
      tool: "ghost",
      key: "ghost.count",
      value: output.ghost,
      run_id: runId,
      confidence: 0.95,
      type: "OBSERVATION",
      meta: {
        alive: output.alive,
        stale: output.stale,
        unreachable: output.unreachable,
      },
    }),
  );

  // Individual ghost node events
  if (output.ghost_peers) {
    for (const peerId of output.ghost_peers) {
      events.push(
        makeEvent({
          tool: "ghost",
          key: "node.status",
          value: "ghost",
          run_id: runId,
          node_id: peerId,
          confidence: 0.9,
          type: "OBSERVATION",
        }),
      );
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Keyspace inspector adapter
// ---------------------------------------------------------------------------

export interface KeyspaceOutput {
  exit_code: number;
  vless_count: number;
  hy2_count: number;
  tombstone_count: number;
  orphan_keys: number;
}

export function normalizeKeyspace(
  output: KeyspaceOutput,
  runId: string,
): Omit<SwarmEvent, "id" | "logical_time">[] {
  const events: Omit<SwarmEvent, "id" | "logical_time">[] = [];

  events.push(
    makeEvent({
      tool: "keyspace",
      key: "keyspace.vless.count",
      value: output.vless_count,
      run_id: runId,
    }),
  );

  events.push(
    makeEvent({
      tool: "keyspace",
      key: "keyspace.hysteria2.count",
      value: output.hy2_count,
      run_id: runId,
    }),
  );

  events.push(
    makeEvent({
      tool: "keyspace",
      key: "keyspace.tombstone.count",
      value: output.tombstone_count,
      run_id: runId,
    }),
  );

  events.push(
    makeEvent({
      tool: "keyspace",
      key: "keyspace.orphan.keys",
      value: output.orphan_keys,
      run_id: runId,
      type: output.orphan_keys > 0 ? "OBSERVATION" : "FACT",
    }),
  );

  return events;
}

// ---------------------------------------------------------------------------
// Tunnel mock adapter
// ---------------------------------------------------------------------------

export interface TunnelOutput {
  status: string;
  provider: string;
  host?: string;
  port?: number;
  exit_code: number;
}

export function normalizeTunnel(
  output: TunnelOutput,
  runId: string,
): Omit<SwarmEvent, "id" | "logical_time">[] {
  const events: Omit<SwarmEvent, "id" | "logical_time">[] = [];

  events.push(
    makeEvent({
      tool: "tunnel",
      key: "tunnel.status",
      value: output.status,
      run_id: runId,
      confidence: output.exit_code === 0 ? 1.0 : 0.6,
      type: "STATE",
    }),
  );

  events.push(
    makeEvent({
      tool: "tunnel",
      key: "tunnel.provider",
      value: output.provider,
      run_id: runId,
      type: "FACT",
    }),
  );

  if (output.host) {
    events.push(
      makeEvent({
        tool: "tunnel",
        key: "tunnel.host",
        value: output.host,
        run_id: runId,
      }),
    );
  }

  if (output.port) {
    events.push(
      makeEvent({
        tool: "tunnel",
        key: "tunnel.port",
        value: output.port,
        run_id: runId,
      }),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// Spec checker adapter
// ---------------------------------------------------------------------------

export interface SpecOutput {
  exit_code: number;
  checks_passed: number;
  checks_total: number;
  drift_detected: boolean;
}

export function normalizeSpec(
  output: SpecOutput,
  runId: string,
): Omit<SwarmEvent, "id" | "logical_time">[] {
  return [
    makeEvent({
      tool: "spec",
      key: "spec.alignment",
      value: !output.drift_detected,
      run_id: runId,
      confidence: 0.85,
      type: "OBSERVATION",
      meta: {
        checks_passed: output.checks_passed,
        checks_total: output.checks_total,
      },
    }),
  ];
}
