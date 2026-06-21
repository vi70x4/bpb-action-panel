#!/usr/bin/env tsx

/**
 * Ghost Node Scanner for BPB Action Mesh
 *
 * Detects stale/ghost peers in the DHT that are expired but have no
 * tombstone — the most dangerous failure mode in an ephemeral proxy mesh.
 *
 * Modes:
 *   DHT scan (default) — joins the mesh as a client and scans the keyspace
 *   --json <path>       — offline analysis from a peer snapshot (CI-friendly)
 *
 * Exit codes: 0 = no ghosts, 1 = ghosts detected, 2 = scan failed
 */

import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { kadDHT } from "@libp2p/kad-dht";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { toString as uint8ArrayToString } from "uint8arrays";
import { createConnection } from "net";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

interface PeerRecord {
  peerId: string;
  protocol: "vless" | "hysteria2";
  host: string;
  port: number;
  expiresAt: string;
  ttl: number;
  bornAt?: string;
  tombstoned: boolean;
}

type PeerStatus = "alive" | "ghost" | "stale" | "unreachable";

interface ClassifyResult {
  peer: PeerRecord;
  status: PeerStatus;
  detail: string;
}

interface JsonInput {
  networkId: string;
  peers: PeerRecord[];
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  network: string;
  jsonPath: string | null;
  probe: boolean;
  bootstrap: string | null;
} {
  const args = { network: "bpb-default", jsonPath: null as string | null, probe: false, bootstrap: null as string | null };
  let i = 2; // skip node + script
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--network":
        args.network = argv[++i] ?? args.network;
        break;
      case "--json":
        args.jsonPath = argv[++i] ?? null;
        break;
      case "--probe":
        args.probe = true;
        break;
      case "--bootstrap":
        args.bootstrap = argv[++i] ?? null;
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        process.exit(2);
    }
    i++;
  }
  return args;
}

// ── Classification logic ─────────────────────────────────────────────────────

function classifyPeer(peer: PeerRecord, now: Date): ClassifyResult {
  const expires = new Date(peer.expiresAt);
  const expired = now >= expires;

  if (!expired) {
    const minsLeft = Math.round((expires.getTime() - now.getTime()) / 60_000);
    return { peer, status: "alive", detail: `expires in ${minsLeft}m` };
  }

  if (peer.tombstoned) {
    const minsAgo = Math.round((now.getTime() - expires.getTime()) / 60_000);
    return { peer, status: "stale", detail: `tombstoned but record persists (expired ${minsAgo}m ago)` };
  }

  // Expired AND no tombstone → GHOST
  const minsAgo = Math.round((now.getTime() - expires.getTime()) / 60_000);
  return { peer, status: "ghost", detail: `expired ${minsAgo}m ago, NO TOMBSTONE → GHOST` };
}

// ── TCP reachability check ───────────────────────────────────────────────────

function probeHost(host: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ── DHT scan mode ───────────────────────────────────────────────────────────

const PROTOCOLS = ["vless", "hysteria2"] as const;

interface RawDHTRecord {
  peerId: string;
  protocol: "vless" | "hysteria2";
  host: string;
  port: number;
  expiresAt: string;
  ttl: number;
  bornAt?: string;
}

async function scanDHT(
  network: string,
  bootstrap: string | null,
  doProbe: boolean,
): Promise<ClassifyResult[]> {
  // Create a client-mode DHT node (lighter than a full mesh node)
  const node = await createLibp2p({
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0"],
    },
    services: {
      dht: kadDHT({
        clientMode: true,
        kBucketSize: 20,
      }),
      identify: identify(),
      ping: ping(),
    },
    ...(bootstrap
      ? {
          peerDiscovery: undefined, // we dial the bootstrap peer manually below
        }
      : {}),
  });

  try {
    // Dial bootstrap peer if provided
    if (bootstrap) {
      console.log(`🔌 Dialing bootstrap peer: ${bootstrap}`);
      await node.dial(bootstrap);
    }

    // Wait briefly for routing table to populate
    await new Promise((r) => setTimeout(r, 3000));

    const results: ClassifyResult[] = [];
    const now = new Date();
    const tombstoneCache = new Map<string, boolean>();

    for (const protocol of PROTOCOLS) {
      const keyPrefix = `/bpb/v2/${network}/${protocol}`;

      // We iterate a known peer-id space by scanning common prefixes.
      // In practice, we query the DHT for records under each protocol prefix.
      // libp2p kad-dht doesn't expose a "prefix scan", so we use Provider
      // records + direct get with known peer IDs from the routing table.

      console.log(`🔍 Scanning ${keyPrefix}/* ...`);

      // Collect candidate peer IDs from the routing table peers
      const knownPeers = node.getPeers();

      for (const peer of knownPeers) {
        const pid = peer.toString();
        const key = `${keyPrefix}/${pid}`;

        try {
          const rawBytes = await node.services.dht.get(new TextEncoder().encode(key));
          if (!rawBytes) continue;

          const record: RawDHTRecord = JSON.parse(new TextDecoder().decode(rawBytes));

          // Check for tombstone
          const tombstoneKey = `/bpb/v2/${network}/tombstone/${pid}`;
          let tombstoned = tombstoneCache.get(pid) ?? false;
          if (!tombstoneCache.has(pid)) {
            try {
              const tb = await node.services.dht.get(new TextEncoder().encode(tombstoneKey));
              tombstoned = tb != null;
            } catch {
              tombstoned = false;
            }
            tombstoneCache.set(pid, tombstoned);
          }

          const peerRec: PeerRecord = {
            peerId: pid,
            protocol: record.protocol ?? protocol,
            host: record.host,
            port: record.port,
            expiresAt: record.expiresAt,
            ttl: record.ttl,
            bornAt: record.bornAt,
            tombstoned,
          };

          let result = classifyPeer(peerRec, now);

          // Optional reachability check
          if (doProbe && result.status !== "stale") {
            const reachable = await probeHost(peerRec.host, peerRec.port);
            if (!reachable && result.status === "alive") {
              result = { peer: peerRec, status: "unreachable", detail: `TCP connect failed to ${peerRec.host}:${peerRec.port}` };
            }
          }

          results.push(result);
        } catch {
          // Key not found in DHT — normal for sparse meshes
        }
      }
    }

    return results;
  } finally {
    await node.stop();
  }
}

// ── JSON file mode ───────────────────────────────────────────────────────────

function scanJson(jsonPath: string, doProbe: boolean): ClassifyResult[] {
  const raw = readFileSync(resolve(jsonPath), "utf-8");
  const input: JsonInput = JSON.parse(raw);
  const now = new Date();

  return input.peers.map((peer) => {
    let result = classifyPeer(peer, now);

    if (doProbe && result.status !== "stale") {
      // Fire synchronously for simplicity in JSON mode
      // (could be parallelized, but we keep it simple)
    }

    return result;
  });
}

// ── Async JSON mode (supports --probe) ──────────────────────────────────────

async function scanJsonAsync(jsonPath: string, doProbe: boolean): Promise<ClassifyResult[]> {
  const raw = readFileSync(resolve(jsonPath), "utf-8");
  const input: JsonInput = JSON.parse(raw);
  const now = new Date();

  const results: ClassifyResult[] = [];

  for (const peer of input.peers) {
    let result = classifyPeer(peer, now);

    if (doProbe && result.status !== "stale") {
      const reachable = await probeHost(peer.host, peer.port);
      if (!reachable && result.status === "alive") {
        result = { peer, status: "unreachable", detail: `TCP connect failed to ${peer.host}:${peer.port}` };
      }
    }

    results.push(result);
  }

  return results;
}

// ── Output formatting ────────────────────────────────────────────────────────

const STATUS_ICONS: Record<PeerStatus, string> = {
  alive: "✓",
  ghost: "⚠",
  stale: "⚠",
  unreachable: "✗",
};

const STATUS_LABELS: Record<PeerStatus, string> = {
  alive: "alive",
  ghost: "GHOST",
  stale: "STALE",
  unreachable: "UNREACHABLE",
};

function formatOutput(network: string, results: ClassifyResult[]): void {
  const short = (id: string) =>
    id.length > 12 ? `${id.slice(0, 12)}...` : id;

  console.log(`\n👻 Ghost Node Scanner — network: ${network}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  for (const r of results) {
    const icon = STATUS_ICONS[r.status];
    const label = STATUS_LABELS[r.status];
    const pid = short(r.peer.peerId);
    console.log(`${icon} ${label}: ${pid} (${r.detail})`);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const counts = { alive: 0, ghost: 0, stale: 0, unreachable: 0 };
  for (const r of results) counts[r.status]++;

  const parts: string[] = [];
  if (counts.alive)        parts.push(`${counts.alive} alive`);
  if (counts.ghost)       parts.push(`${counts.ghost} ghost`);
  if (counts.stale)       parts.push(`${counts.stale} stale`);
  if (counts.unreachable) parts.push(`${counts.unreachable} unreachable`);

  console.log(`Summary: ${parts.join(", ") || "no peers found"}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  try {
    let results: ClassifyResult[];

    if (args.jsonPath) {
      // Offline / CI mode — no libp2p required
      results = await scanJsonAsync(args.jsonPath, args.probe);
    } else {
      // Live DHT scan
      results = await scanDHT(args.network, args.bootstrap, args.probe);
    }

    formatOutput(args.network, results);

    const ghostCount = results.filter((r) => r.status === "ghost").length;
    process.exit(ghostCount > 0 ? 1 : 0);
  } catch (err) {
    console.error(`❌ Scan failed: ${(err as Error).message}`);
    process.exit(2);
  }
}

main();
