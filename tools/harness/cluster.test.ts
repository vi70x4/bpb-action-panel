import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessNode, HarnessOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks – must appear BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Hoisted mock instances so vi.mock factories can write into them
const mockDHTNode = vi.hoisted(() => ({
	peerId: { toString: () => "mock-peer-id" },
	getMultiaddrs: vi.fn(() => [{ toString: () => "/ip4/127.0.0.1/tcp/25001" }]),
	// Return 3 fake peers so the convergence check passes (minPeers = nodeCount - 1)
	getPeers: vi.fn(() => [{}, {}, {}]),
	dial: vi.fn(),
	peerStore: { merge: vi.fn() },
	stop: vi.fn(),
}));

const mockAnnounceProxyConfig = vi.fn();

vi.mock("../../node/src/dht.js", () => ({
	createDHTNode: vi.fn(() => Promise.resolve(mockDHTNode)),
}));

vi.mock("../../node/src/announce.js", () => ({
	announceProxyConfig: (...args: unknown[]) => mockAnnounceProxyConfig(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are declared
// ---------------------------------------------------------------------------

import { spawnCluster } from "./cluster.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
	return {
		nodeCount: 3,
		convergenceTimeoutMs: 5000,
		ttlSeconds: 300,
		network: "harness-test",
		protocol: "vless",
		verifyTombstones: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// spawnCluster – basic shape
// ---------------------------------------------------------------------------

describe("spawnCluster", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mock implementations to defaults — getPeers returns enough peers
		// for the convergence check to pass (minPeers = nodeCount - 1, typically 2).
		mockDHTNode.getMultiaddrs.mockImplementation(() => [
			{ toString: () => "/ip4/127.0.0.1/tcp/25001" },
		]);
		mockDHTNode.getPeers.mockImplementation(() => [{}, {}, {}]);
		mockDHTNode.dial.mockResolvedValue(undefined);
		mockDHTNode.peerStore.merge.mockResolvedValue(undefined);
		mockDHTNode.stop.mockResolvedValue(undefined);
		mockAnnounceProxyConfig.mockResolvedValue(undefined);
	});

	it("returns a Cluster handle with the expected shape", async () => {
		const opts = makeOpts({ nodeCount: 1, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster).toBeDefined();
		expect(Array.isArray(cluster.nodes)).toBe(true);
		expect(typeof cluster.stopAll).toBe("function");
		expect(typeof cluster.getMultiaddrs).toBe("function");
	});

	it("creates the requested number of nodes", async () => {
		const opts = makeOpts({ nodeCount: 3, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster.nodes).toHaveLength(3);
		expect(cluster.nodes[0].id).toBe("node-0");
		expect(cluster.nodes[1].id).toBe("node-1");
		expect(cluster.nodes[2].id).toBe("node-2");
	});

	it("assigns a peerId to each node", async () => {
		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		for (const node of cluster.nodes) {
			expect(node.peerId).toBe("mock-peer-id");
		}
	});

	it("calls createDHTNode for each node", async () => {
		const { createDHTNode } = await import("../../node/src/dht.js");
		const opts = makeOpts({ nodeCount: 3, convergenceTimeoutMs: 1000 });
		await spawnCluster(opts);

		expect(createDHTNode).toHaveBeenCalledTimes(3);
	});

	it("uses BASE_PORT for node-0 and increments by 2 for subsequent nodes", async () => {
		const { createDHTNode } = await import("../../node/src/dht.js");
		const opts = makeOpts({ nodeCount: 3, convergenceTimeoutMs: 1000 });
		await spawnCluster(opts);

		const calls = (createDHTNode as ReturnType<typeof vi.fn>).mock.calls;
		// BASE_PORT = 25001, then 25003, 25005
		expect(calls[0][0]).toBe(25001);
		expect(calls[1][0]).toBe(25003);
		expect(calls[2][0]).toBe(25005);
	});
});

// ---------------------------------------------------------------------------
// getMultiaddrs
// ---------------------------------------------------------------------------

describe("Cluster.getMultiaddrs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDHTNode.getMultiaddrs.mockImplementation(() => [
			{ toString: () => "/ip4/127.0.0.1/tcp/25001" },
		]);
		mockDHTNode.getPeers.mockImplementation(() => [{}, {}, {}]);
		mockDHTNode.dial.mockResolvedValue(undefined);
		mockDHTNode.peerStore.merge.mockResolvedValue(undefined);
		mockDHTNode.stop.mockResolvedValue(undefined);
		mockAnnounceProxyConfig.mockResolvedValue(undefined);
	});

	it("returns multiaddrs for a valid node index", async () => {
		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		const addrs = cluster.getMultiaddrs(0);
		expect(addrs).toEqual(["/ip4/127.0.0.1/tcp/25001"]);
	});

	it("returns empty array for out-of-bounds index", async () => {
		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster.getMultiaddrs(99)).toEqual([]);
		expect(cluster.getMultiaddrs(-1)).toEqual([]);
	});

	it("returns empty array when libp2pNode is null (failed node)", async () => {
		const { createDHTNode } = await import("../../node/src/dht.js");
		// Make the second node fail
		(createDHTNode as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(mockDHTNode)
			.mockRejectedValueOnce(new Error("port in use"));

		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		// node-1 should have null libp2pNode
		expect(cluster.nodes[1].libp2pNode).toBeNull();
		expect(cluster.getMultiaddrs(1)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// stopAll
// ---------------------------------------------------------------------------

describe("Cluster.stopAll", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDHTNode.getMultiaddrs.mockImplementation(() => [
			{ toString: () => "/ip4/127.0.0.1/tcp/25001" },
		]);
		mockDHTNode.getPeers.mockImplementation(() => [{}, {}, {}]);
		mockDHTNode.dial.mockResolvedValue(undefined);
		mockDHTNode.peerStore.merge.mockResolvedValue(undefined);
		mockDHTNode.stop.mockResolvedValue(undefined);
		mockAnnounceProxyConfig.mockResolvedValue(undefined);
	});

	it("calls stop() on every node with a libp2pNode", async () => {
		const opts = makeOpts({ nodeCount: 3, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		await cluster.stopAll();

		expect(mockDHTNode.stop).toHaveBeenCalledTimes(3);
	});

	it("does not throw when a node's stop() rejects", async () => {
		mockDHTNode.stop.mockRejectedValueOnce(new Error("already stopped"));

		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		// Should not throw
		await expect(cluster.stopAll()).resolves.toBeUndefined();
	});

	it("skips nodes with null libp2pNode", async () => {
		const { createDHTNode } = await import("../../node/src/dht.js");
		(createDHTNode as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(mockDHTNode)
			.mockRejectedValueOnce(new Error("port in use"));

		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		await cluster.stopAll();

		// Only node-0 has a libp2pNode
		expect(mockDHTNode.stop).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("spawnCluster error handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDHTNode.getMultiaddrs.mockImplementation(() => [
			{ toString: () => "/ip4/127.0.0.1/tcp/25001" },
		]);
		mockDHTNode.getPeers.mockImplementation(() => [{}, {}, {}]);
		mockDHTNode.dial.mockResolvedValue(undefined);
		mockDHTNode.peerStore.merge.mockResolvedValue(undefined);
		mockDHTNode.stop.mockResolvedValue(undefined);
		mockAnnounceProxyConfig.mockResolvedValue(undefined);
	});

	it("throws when bootstrap node-0 fails to start", async () => {
		const { createDHTNode } = await import("../../node/src/dht.js");
		(createDHTNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("port in use"),
		);

		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });

		await expect(spawnCluster(opts)).rejects.toThrow(
			"Failed to start bootstrap node on port 25001",
		);
	});

	it("continues when a non-bootstrap node fails to start", async () => {
		const { createDHTNode } = await import("../../node/src/dht.js");
		(createDHTNode as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(mockDHTNode)
			.mockRejectedValueOnce(new Error("port in use"));

		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster.nodes).toHaveLength(2);
		expect(cluster.nodes[1].libp2pNode).toBeNull();
		expect(cluster.nodes[1].peerId).toBe("");
	});

	it("continues when a node fails to dial bootstrap", async () => {
		mockDHTNode.dial.mockRejectedValueOnce(new Error("connection refused"));

		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster.nodes).toHaveLength(2);
		// node-1 should still exist (with its libp2pNode)
		expect(cluster.nodes[1].libp2pNode).toBe(mockDHTNode);
	});

	it("throws when DHT convergence times out", async () => {
		// Return empty peers so convergence never happens (minPeers = nodeCount-1 = 1)
		mockDHTNode.getPeers.mockImplementation(() => []);

		const opts = makeOpts({
			nodeCount: 2,
			convergenceTimeoutMs: 100, // very short timeout
		});

		await expect(spawnCluster(opts)).rejects.toThrow(
			"DHT convergence timeout after 100ms. Peer counts: node-0=0, node-1=0",
		);
	});
});

// ---------------------------------------------------------------------------
// announceProxyConfig interaction
// ---------------------------------------------------------------------------

describe("spawnCluster announceProxyConfig interaction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDHTNode.getMultiaddrs.mockImplementation(() => [
			{ toString: () => "/ip4/127.0.0.1/tcp/25001" },
		]);
		mockDHTNode.getPeers.mockImplementation(() => [{}, {}, {}]);
		mockDHTNode.dial.mockResolvedValue(undefined);
		mockDHTNode.peerStore.merge.mockResolvedValue(undefined);
		mockDHTNode.stop.mockResolvedValue(undefined);
		mockAnnounceProxyConfig.mockResolvedValue(undefined);
	});

	it("calls announceProxyConfig for each node", async () => {
		const opts = makeOpts({ nodeCount: 3, convergenceTimeoutMs: 1000 });
		await spawnCluster(opts);

		expect(mockAnnounceProxyConfig).toHaveBeenCalledTimes(3);
	});

	it("passes the libp2pNode and a ProxyConfig to announceProxyConfig", async () => {
		const opts = makeOpts({ nodeCount: 1, convergenceTimeoutMs: 1000 });
		await spawnCluster(opts);

		const call = mockAnnounceProxyConfig.mock.calls[0];
		expect(call[0]).toBe(mockDHTNode);
		expect(call[1]).toMatchObject({
			peerId: "mock-peer-id",
			protocol: "vless",
			network: "harness-test",
			ttl: 300,
		});
	});

	it("sets announced=true and stores config on successful announce", async () => {
		const opts = makeOpts({ nodeCount: 1, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster.nodes[0].announced).toBe(true);
		expect(cluster.nodes[0].config).toBeDefined();
		expect(cluster.nodes[0].config?.peerId).toBe("mock-peer-id");
	});

	it("does not set announced=true when announce fails", async () => {
		mockAnnounceProxyConfig.mockRejectedValueOnce(new Error("timeout"));

		const opts = makeOpts({ nodeCount: 1, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		expect(cluster.nodes[0].announced).toBe(false);
	});

	it("uses vless protocol to generate a UUID", async () => {
		const opts = makeOpts({
			nodeCount: 1,
			convergenceTimeoutMs: 1000,
			protocol: "vless",
		});
		const cluster = await spawnCluster(opts);

		const config = cluster.nodes[0].config;
		expect(config?.uuid).toBeDefined();
		// UUID format: 00000000-0000-4000-8000-000000000000 (index 0)
		expect(config?.uuid).toBe("00000000-0000-4000-8000-000000000000");
	});

	it("uses hysteria2 protocol to generate a password", async () => {
		const opts = makeOpts({
			nodeCount: 1,
			convergenceTimeoutMs: 1000,
			protocol: "hysteria2",
		});
		const cluster = await spawnCluster(opts);

		const config = cluster.nodes[0].config;
		expect(config?.password).toBe("harness-pw-0");
		expect(config?.uuid).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Cluster node shape
// ---------------------------------------------------------------------------

describe("Cluster node shape", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDHTNode.getMultiaddrs.mockImplementation(() => [
			{ toString: () => "/ip4/127.0.0.1/tcp/25001" },
		]);
		mockDHTNode.getPeers.mockImplementation(() => [{}, {}, {}]);
		mockDHTNode.dial.mockResolvedValue(undefined);
		mockDHTNode.peerStore.merge.mockResolvedValue(undefined);
		mockDHTNode.stop.mockResolvedValue(undefined);
		mockAnnounceProxyConfig.mockResolvedValue(undefined);
	});

	it("each node has the HarnessNode shape", async () => {
		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		for (const node of cluster.nodes) {
			expect(node).toHaveProperty("id");
			expect(node).toHaveProperty("peerId");
			expect(node).toHaveProperty("libp2pNode");
			expect(node).toHaveProperty("multiaddrs");
			expect(node).toHaveProperty("announced");
			expect(node).toHaveProperty("tombstoned");
		}
	});

	it("tombstoned defaults to false", async () => {
		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		for (const node of cluster.nodes) {
			expect(node.tombstoned).toBe(false);
		}
	});

	it("multiaddrs is an array of strings", async () => {
		const opts = makeOpts({ nodeCount: 2, convergenceTimeoutMs: 1000 });
		const cluster = await spawnCluster(opts);

		for (const node of cluster.nodes) {
			expect(Array.isArray(node.multiaddrs)).toBe(true);
			for (const addr of node.multiaddrs) {
				expect(typeof addr).toBe("string");
			}
		}
	});
});
