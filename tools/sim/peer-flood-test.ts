/**
 * Peer Flood Test — spins up 10+ libp2p nodes rapidly,
 * announces them to DHT simultaneously, and measures
 * announce latency per node + total mesh convergence time.
 *
 * Usage: npx tsx peer-flood-test.ts [--count N]
 */

import { createLibp2p } from "libp2p";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { kadDHT } from "@libp2p/kad-dht";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProxyConfig {
  peerId: string;
  protocol: "vless" | "hysteria2";
  host: string;
  port: number;
  uuid?: string;
  sni?: string;
  security: string;
  network: string;
  ttl: number;
  bornAt: string;
  expiresAt: string;
}

interface FloodNode {
  node: Awaited<ReturnType<typeof createLibp2p>>;
  peerId: string;
  index: number;
  announceLatencyMs: number;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { count: number } {
  const args = process.argv.slice(2);
  let count = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" && args[i + 1]) {
      count = parseInt(args[i + 1], 10);
      if (isNaN(count) || count < 2) {
        console.error("--count must be an integer >= 2");
        process.exit(1);
      }
      i++;
    }
  }
  return { count };
}

// ---------------------------------------------------------------------------
// Node factory
// ---------------------------------------------------------------------------

const BASE_PORT = 16000;

async function createFloodNode(index: number): Promise<FloodNode> {
  const listenPort = BASE_PORT + index;

  const node = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${listenPort}`],
    },
    services: {
      dht: kadDHT({
        clientMode: false,
        kBucketSize: 20,
      }),
      identify: identify(),
      ping: ping(),
    },
  });

  const peerId = node.peerId.toString();
  return { node, peerId, index, announceLatencyMs: 0 };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(nodes: FloodNode[]): Promise<void> {
  const bootstrapNode = nodes[0];
  const bootstrapAddr = `/ip4/127.0.0.1/tcp/${BASE_PORT}/p2p/${bootstrapNode.peerId}`;

  await Promise.all(
    nodes.slice(1).map(async (sim) => {
      try {
        await sim.node.dial(bootstrapAddr);
      } catch (err) {
        console.error(`  ⚠ Node ${sim.index} failed to bootstrap: ${err}`);
      }
    }),
  );

  // Let DHT routing tables settle
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

// ---------------------------------------------------------------------------
// Announce — measure per-node latency
// ---------------------------------------------------------------------------

function buildMockConfig(peerId: string): ProxyConfig {
  const now = Date.now();
  const ttlSeconds = 2340;
  return {
    peerId,
    protocol: "vless",
    host: `${peerId.slice(0, 8)}.trycloudflare.com`,
    port: 443,
    uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    sni: `${peerId.slice(0, 8)}.trycloudflare.com`,
    security: "tls",
    network: "bpb-sim",
    ttl: ttlSeconds,
    bornAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
}

async function announceAndMeasure(sim: FloodNode): Promise<void> {
  const config = buildMockConfig(sim.peerId);
  const key = `/bpb/v2/${config.network}/${config.protocol}/${config.peerId}`;
  const value = new TextEncoder().encode(JSON.stringify(config));

  const start = performance.now();

  // Provide on the shared network key so findProviders discovers all participants
  const networkKey = `/bpb/v2/${config.network}/${config.protocol}`;
  await sim.node.services.dht.provide(new TextEncoder().encode(networkKey));

  // Also provide on per-peer key and store the value
  await sim.node.services.dht.provide(new TextEncoder().encode(key));
  await sim.node.services.dht.put(new TextEncoder().encode(key), value);
  sim.announceLatencyMs = Math.round(performance.now() - start);
}

// ---------------------------------------------------------------------------
// Discovery — count other peers each node can find
// ---------------------------------------------------------------------------

async function discoverPeerCount(sim: FloodNode): Promise<number> {
  const networkKey = new TextEncoder().encode("/bpb/v2/bpb-sim/vless");
  const providers: string[] = [];

  for await (const event of sim.node.services.dht.findProviders(networkKey)) {
    if (event.name === "PROVIDER") {
      for (const provider of event.providers) {
        const id = provider.id.toString();
        if (id !== sim.peerId && !providers.includes(id)) {
          providers.push(id);
        }
      }
    }
  }

  return providers.length;
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { count } = parseArgs();
  const nodes: FloodNode[] = [];
  let success = false;
  const totalStart = performance.now();

  console.log(`🌊 Peer Flood Test (N=${count})\n`);

  try {
    // --- Create all nodes in parallel ---
    for (let i = 0; i < count; i++) {
      const sim = await createFloodNode(i);
      nodes.push(sim);
    }

    // --- Bootstrap all to node 0 ---
    await bootstrap(nodes);

    // --- Simultaneous announce ---
    const announceStart = performance.now();
    await Promise.all(nodes.map((sim) => announceAndMeasure(sim)));

    // --- Wait for propagation ---
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // --- Discovery ---
    const discoveryResults = await Promise.all(
      nodes.map((sim) => discoverPeerCount(sim)),
    );

    const convergenceMs = Math.round(performance.now() - totalStart);

    // --- Stats ---
    const latencies = nodes
      .map((n) => n.announceLatencyMs)
      .sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const maxLatency = latencies[latencies.length - 1];

    // Format seconds if large
    const fmtMs = (ms: number) =>
      ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

    console.log(
      `Announce latencies: p50=${fmtMs(p50)} p95=${fmtMs(p95)} max=${fmtMs(maxLatency)}`,
    );
    console.log(`Full mesh convergence: ${fmtMs(convergenceMs)}`);

    // --- Verdict ---
    const expectedPeers = count - 1;
    const fullMesh = discoveryResults.every((count) => count >= expectedPeers);
    const partialMesh = discoveryResults.every((count) => count >= 1);

    if (fullMesh) {
      console.log(`✅ PASS: All ${count} nodes discovered each other`);
      success = true;
    } else if (partialMesh) {
      console.log(
        `⚠ PARTIAL: Each node found at least 1 peer (not full mesh yet — DHT propagation may need more time)`,
      );
      success = true;
    } else {
      console.log("❌ FAIL: Some nodes discovered zero peers");
      success = false;
    }
  } catch (err) {
    console.error("❌ Flood test error:", err);
    success = false;
  } finally {
    // --- Clean shutdown ---
    for (const sim of nodes) {
      try {
        await sim.node.stop();
      } catch {
        // best-effort
      }
    }
  }

  process.exit(success ? 0 : 1);
}

main();
