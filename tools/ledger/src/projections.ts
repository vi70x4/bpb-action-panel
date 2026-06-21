/**
 * Projections — derived views over the ledger.
 *
 * The ledger is never queried directly by consumers.
 * Projections build a read-model from the raw event stream.
 * All derived, never stored.
 */

import type { SwarmEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Key-indexed latest values
// ---------------------------------------------------------------------------

/**
 * Returns the latest event per key, by logical_time.
 * Later events overwrite earlier ones for the same key.
 */
export function latestByKey(events: SwarmEvent[]): Map<string, SwarmEvent> {
  const map = new Map<string, SwarmEvent>();

  // Sort by logical_time ascending, so last write wins
  const sorted = [...events].sort((a, b) => a.logical_time - b.logical_time);
  for (const e of sorted) {
    map.set(e.key, e);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Node state projection
// ---------------------------------------------------------------------------

export type NodeStatus = "online" | "offline" | "ghost" | "unknown";

export interface NodeState {
  node_id: string;
  status: NodeStatus;
  latest_event: SwarmEvent | null;
  tool_reports: Map<string, SwarmEvent>;
}

/**
 * Reconstruct node state from all events referencing a given node_id.
 */
export function getNodeState(events: SwarmEvent[], nodeId: string): NodeState {
  const nodeEvents = events
    .filter((e) => e.node_id === nodeId)
    .sort((a, b) => a.logical_time - b.logical_time);

  const latest = nodeEvents.length > 0 ? nodeEvents[nodeEvents.length - 1] : null;

  // Collect per-tool reports
  const toolReports = new Map<string, SwarmEvent>();
  for (const e of nodeEvents) {
    toolReports.set(e.tool, e);
  }

  // Derive status from latest event's value
  let status: NodeStatus = "unknown";
  if (latest) {
    const v = latest.value;
    if (typeof v === "string") {
      if (["online", "alive", "ok", "reachable"].includes(v)) status = "online";
      else if (["offline", "dead", "unreachable"].includes(v)) status = "offline";
      else if (v === "ghost") status = "ghost";
    } else if (typeof v === "object" && v !== null && "status" in (v as Record<string, unknown>)) {
      const s = (v as Record<string, unknown>).status;
      if (typeof s === "string") status = s as NodeStatus;
    }
  }

  return { node_id: nodeId, status, latest_event: latest, tool_reports: toolReports };
}

// ---------------------------------------------------------------------------
// DHT state projection
// ---------------------------------------------------------------------------

export interface DHTState {
  peer_count: number;
  active_nodes: string[];
  orphan_keys: number;
  sources: Map<string, SwarmEvent>; // tool → event
}

/**
 * Build DHT state view from events with DHT-related keys.
 * Picks the latest observation per tool, then synthesizes.
 */
export function getDHTState(events: SwarmEvent[]): DHTState {
  const dhtEvents = events.filter((e) => e.key.startsWith("dht."));
  const latest = latestByKey(dhtEvents);

  const sources = new Map<string, SwarmEvent>();
  const knownNodes = new Set<string>();

  let peerCount = 0;
  let orphanKeys = 0;

  for (const [, evt] of latest) {
    sources.set(evt.tool, evt);

    if (evt.key === "dht.peer.count" && typeof evt.value === "number") {
      peerCount = evt.value;
    }

    if (evt.key === "dht.active.nodes" && Array.isArray(evt.value)) {
      for (const n of evt.value as string[]) knownNodes.add(n);
    }

    if (evt.key === "dht.orphan.keys" && typeof evt.value === "number") {
      orphanKeys = evt.value;
    }

    // Also extract node_id from events for active_nodes
    if (evt.node_id && evt.key.startsWith("dht.")) {
      knownNodes.add(evt.node_id);
    }
  }

  return {
    peer_count: peerCount,
    active_nodes: [...knownNodes],
    orphan_keys: orphanKeys,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Keyspace health projection
// ---------------------------------------------------------------------------

export interface KeyspaceHealth {
  vless_count: number;
  hy2_count: number;
  tombstone_count: number;
  orphan_keys: number;
  total_keys: number;
}

/**
 * Build keyspace health from events with keyspace.* keys.
 */
export function getKeyspaceHealth(events: SwarmEvent[]): KeyspaceHealth {
  const ksEvents = events.filter((e) => e.key.startsWith("keyspace."));
  const latest = latestByKey(ksEvents);

  const get = (key: string, fallback: number): number => {
    const evt = latest.get(key);
    return evt && typeof evt.value === "number" ? evt.value : fallback;
  };

  const vless = get("keyspace.vless.count", 0);
  const hy2 = get("keyspace.hysteria2.count", 0);
  const tomb = get("keyspace.tombstone.count", 0);
  const orphan = get("keyspace.orphan.keys", 0);

  return {
    vless_count: vless,
    hy2_count: hy2,
    tombstone_count: tomb,
    orphan_keys: orphan,
    total_keys: vless + hy2 + tomb,
  };
}

// ---------------------------------------------------------------------------
// Tunnel state projection
// ---------------------------------------------------------------------------

export type TunnelStatus = "ready" | "failed" | "connecting" | "reconnecting" | "closed" | "unknown";

export interface TunnelState {
  status: TunnelStatus;
  provider: string | null;
  host: string | null;
  port: number | null;
  sources: Map<string, SwarmEvent>;
}

export function getTunnelState(events: SwarmEvent[]): TunnelState {
  const tunnelEvents = events
    .filter((e) => e.key.startsWith("tunnel."))
    .sort((a, b) => a.logical_time - b.logical_time);

  const sources = new Map<string, SwarmEvent>();
  let status: TunnelStatus = "unknown";
  let provider: string | null = null;
  let host: string | null = null;
  let port: number | null = null;

  // Process in order — latest wins
  for (const e of tunnelEvents) {
    sources.set(`${e.tool}:${e.key}`, e);

    if (e.key === "tunnel.status" && typeof e.value === "string") {
      status = e.value as TunnelStatus;
    }
    if (e.key === "tunnel.provider" && typeof e.value === "string") {
      provider = e.value;
    }
    if (e.key === "tunnel.host" && typeof e.value === "string") {
      host = e.value;
    }
    if (e.key === "tunnel.port" && typeof e.value === "number") {
      port = e.value;
    }

    // Also handle object values
    if (typeof e.value === "object" && e.value !== null) {
      const v = e.value as Record<string, unknown>;
      if (typeof v.status === "string") status = v.status as TunnelStatus;
      if (typeof v.provider === "string") provider = v.provider;
      if (typeof v.host === "string") host = v.host;
      if (typeof v.port === "number") port = v.port;
    }
  }

  return { status, provider, host, port, sources };
}
