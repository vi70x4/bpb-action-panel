import { describe, expect, it, vi } from "vitest";
import type { HarnessNode } from "./types.js";
import {
	verifyCrossDiscovery,
	verifyTombstone,
	verifyTopology,
} from "./verifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
	overrides: {
		id?: string;
		peerId: string;
		getPeers?: () => { toString: () => string }[];
		contentRouting?: {
			get: (key: Uint8Array) => Promise<Uint8Array | null | undefined>;
		};
		announced?: boolean;
	} = { peerId: "peer-0" },
): HarnessNode {
	const { id, peerId, getPeers, contentRouting, announced } = overrides;
	return {
		id: id ?? peerId,
		peerId,
		libp2pNode: getPeers
			? { getPeers, contentRouting }
			: contentRouting
				? { contentRouting }
				: null,
		multiaddrs: [],
		announced: announced ?? false,
		tombstoned: false,
	};
}

// ---------------------------------------------------------------------------
// verifyTopology
// ---------------------------------------------------------------------------

describe("verifyTopology", () => {
	it("returns empty edges when no nodes have peers", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0", getPeers: () => [] }),
			makeNode({ peerId: "peer-1", getPeers: () => [] }),
		];

		const result = await verifyTopology(nodes);

		expect(result.edges).toEqual([]);
		expect(result.nodes).toBe(nodes);
		expect(result.isolatedPeerIds).toEqual([]);
		expect(result.connectivityScore).toBe(0);
	});

	it("detects edges between connected peers", async () => {
		const peer1 = { toString: () => "peer-1" };
		const peer2 = { toString: () => "peer-2" };

		const nodes = [
			makeNode({ peerId: "peer-0", getPeers: () => [peer1, peer2] }),
			makeNode({ peerId: "peer-1", getPeers: () => [peer2] }),
			makeNode({ peerId: "peer-2", getPeers: () => [] }),
		];

		const result = await verifyTopology(nodes);

		// Should have edges: peer-0→peer-1, peer-0→peer-2, peer-1→peer-2
		expect(result.edges.length).toBe(3);
		expect(result.edges).toEqual(
			expect.arrayContaining([
				{ from: "peer-0", to: "peer-1", observed: true },
				{ from: "peer-0", to: "peer-2", observed: true },
				{ from: "peer-1", to: "peer-2", observed: true },
			]),
		);
	});

	it("deduplicates bidirectional edges for connectivity score", async () => {
		const peer1 = { toString: () => "peer-1" };
		const peer0 = { toString: () => "peer-0" };

		// Both nodes see each other (bidirectional)
		const nodes = [
			makeNode({ peerId: "peer-0", getPeers: () => [peer1] }),
			makeNode({ peerId: "peer-1", getPeers: () => [peer0] }),
		];

		const result = await verifyTopology(nodes);

		// Two raw edges, but one unique edge key
		expect(result.edges.length).toBe(2);
		// 1 unique edge / 1 possible edge = 1.0
		expect(result.connectivityScore).toBeCloseTo(1.0);
	});

	it("identifies isolated announced nodes", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0", getPeers: () => [], announced: true }),
			makeNode({ peerId: "peer-1", getPeers: () => [], announced: true }),
			makeNode({ peerId: "peer-2", getPeers: () => [] }),
		];

		const result = await verifyTopology(nodes);

		// Both announced nodes are isolated (no edges)
		expect(result.isolatedPeerIds).toEqual(["peer-0", "peer-1"]);
	});

	it("does not mark non-announced nodes as isolated", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0", getPeers: () => [], announced: false }),
			makeNode({ peerId: "peer-1", getPeers: () => [], announced: true }),
		];

		const result = await verifyTopology(nodes);

		// Only announced nodes count as isolated
		expect(result.isolatedPeerIds).toEqual(["peer-1"]);
	});

	it("skips nodes without libp2pNode", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }), // no libp2pNode
			makeNode({ peerId: "peer-1" }), // no libp2pNode
		];

		const result = await verifyTopology(nodes);

		expect(result.edges).toEqual([]);
		expect(result.connectivityScore).toBe(0);
	});

	it("handles empty nodes array", async () => {
		const result = await verifyTopology([]);

		expect(result.edges).toEqual([]);
		expect(result.nodes).toEqual([]);
		expect(result.isolatedPeerIds).toEqual([]);
		expect(result.connectivityScore).toBe(0);
	});

	it("handles single node gracefully", async () => {
		const nodes = [makeNode({ peerId: "peer-0", getPeers: () => [] })];

		const result = await verifyTopology(nodes);

		expect(result.edges).toEqual([]);
		expect(result.connectivityScore).toBe(0);
	});

	it("computes connectivity score for partial mesh", async () => {
		const peer1 = { toString: () => "peer-1" };
		const peer2 = { toString: () => "peer-2" };

		// 3 nodes, but only peer-0 is connected to the others
		const nodes = [
			makeNode({ peerId: "peer-0", getPeers: () => [peer1, peer2] }),
			makeNode({ peerId: "peer-1", getPeers: () => [] }),
			makeNode({ peerId: "peer-2", getPeers: () => [] }),
		];

		const result = await verifyTopology(nodes);

		// 2 unique edges / 3 possible = 0.667
		expect(result.connectivityScore).toBeCloseTo(2 / 3);
	});

	it("handles nodes with getPeers returning undefined", async () => {
		const nodes = [
			makeNode({
				peerId: "peer-0",
				getPeers: () => undefined as unknown as [],
			}),
			makeNode({ peerId: "peer-1", getPeers: () => [] }),
		];

		const result = await verifyTopology(nodes);

		expect(result.edges).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// verifyCrossDiscovery
// ---------------------------------------------------------------------------

describe("verifyCrossDiscovery", () => {
	it("returns empty discoveries when node has no contentRouting", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }), // no contentRouting
			makeNode({ peerId: "peer-1" }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		expect(result).toEqual({
			"peer-0": [],
			"peer-1": [],
		});
	});

	it("discovers all peers when DHT returns values", async () => {
		const mockGet = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-2", contentRouting: { get: mockGet } }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		// Each peer should discover the other 2
		expect(result["peer-0"]).toEqual(["peer-1", "peer-2"]);
		expect(result["peer-1"]).toEqual(["peer-0", "peer-2"]);
		expect(result["peer-2"]).toEqual(["peer-0", "peer-1"]);
	});

	it("skips self in discovery", async () => {
		const mockGet = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		// No other peers to discover
		expect(result["peer-0"]).toEqual([]);
	});

	it("does not include peer when DHT returns null", async () => {
		const mockGet = vi.fn().mockResolvedValue(null);

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		expect(result["peer-0"]).toEqual([]);
		expect(result["peer-1"]).toEqual([]);
	});

	it("handles DHT query failure gracefully", async () => {
		const mockGet = vi.fn().mockRejectedValue(new Error("DHT timeout"));

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		// Failure means undiscovered
		expect(result["peer-0"]).toEqual([]);
		expect(result["peer-1"]).toEqual([]);
	});

	it("builds correct DHT key path", async () => {
		// Track keys that are queried
		const queriedKeys: string[] = [];
		const mockGet = vi.fn().mockImplementation((key: Uint8Array) => {
			const decoded = new TextDecoder().decode(key);
			queriedKeys.push(decoded);
			return new Uint8Array([1]);
		});

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		await verifyCrossDiscovery(nodes, "my-network", "hysteria2");

		// Should query /bpb/v2/my-network/hysteria2/peer-1 from peer-0
		expect(queriedKeys).toContain("/bpb/v2/my-network/hysteria2/peer-1");
		// Should query /bpb/v2/my-network/hysteria2/peer-0 from peer-1
		expect(queriedKeys).toContain("/bpb/v2/my-network/hysteria2/peer-0");
	});

	it("handles empty nodes array", async () => {
		const result = await verifyCrossDiscovery([], "test", "vless");

		expect(result).toEqual({});
	});

	it("handles mixed nodes with and without contentRouting", async () => {
		const mockGet = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1" }), // no contentRouting
			makeNode({ peerId: "peer-2", contentRouting: { get: mockGet } }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		// peer-0 has contentRouting, so it can query (mock returns values for all)
		expect(result["peer-0"]).toEqual(["peer-1", "peer-2"]);
		// peer-1 has no contentRouting, so empty
		expect(result["peer-1"]).toEqual([]);
		// peer-2 has contentRouting, so it can query
		expect(result["peer-2"]).toEqual(["peer-0", "peer-1"]);
	});
});

// ---------------------------------------------------------------------------
// verifyTombstone
// ---------------------------------------------------------------------------

describe("verifyTombstone", () => {
	it("returns deadNodeAbsentFromDHT=true when no survivors have the record", async () => {
		const mockGet = vi.fn().mockResolvedValue(null);

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		expect(result.deadNodeAbsentFromDHT).toBe(true);
		expect(result.staleRecordCount).toBe(0);
	});

	it("counts stale records when non-tombstone values exist", async () => {
		const mockGet = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode('{"proxy":"some-config"}'));

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		expect(result.deadNodeAbsentFromDHT).toBe(false);
		expect(result.staleRecordCount).toBe(2);
	});

	it("accepts tombstone marker as valid (not stale)", async () => {
		const mockGet = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode('{"tombstone":true}'));

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		// Tombstone marker means node is tracked as dead, but not stale
		expect(result.deadNodeAbsentFromDHT).toBe(false);
		expect(result.staleRecordCount).toBe(0);
	});

	it("accepts 'dead' marker as valid (not stale)", async () => {
		const mockGet = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode('{"dead":true}'));

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		expect(result.deadNodeAbsentFromDHT).toBe(false);
		expect(result.staleRecordCount).toBe(0);
	});

	it("skips survivors without contentRouting", async () => {
		const mockGet = vi.fn().mockResolvedValue(null);

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0" }), // no contentRouting
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		// peer-0 skipped, peer-1 returns null → absent
		expect(result.deadNodeAbsentFromDHT).toBe(true);
		expect(result.staleRecordCount).toBe(0);
	});

	it("handles DHT query error as absent", async () => {
		const mockGet = vi.fn().mockRejectedValue(new Error("Network error"));

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		// Error treated as absent
		expect(result.deadNodeAbsentFromDHT).toBe(true);
		expect(result.staleRecordCount).toBe(0);
	});

	it("handles empty surviving nodes array", async () => {
		const tombstonedNode = makeNode({ peerId: "dead-peer" });

		const result = await verifyTombstone(tombstonedNode, [], "test", "vless");

		// No survivors → absent from all
		expect(result.deadNodeAbsentFromDHT).toBe(true);
		expect(result.staleRecordCount).toBe(0);
	});

	it("builds correct DHT key for tombstoned node", async () => {
		const queriedKeys: string[] = [];
		const mockGet = vi.fn().mockImplementation((key: Uint8Array) => {
			const decoded = new TextDecoder().decode(key);
			queriedKeys.push(decoded);
			return null;
		});

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
		];

		await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"my-net",
			"hysteria2",
		);

		expect(queriedKeys).toEqual(["/bpb/v2/my-net/hysteria2/dead-peer"]);
	});

	it("reports partial staleness when mix of stale and missing records", async () => {
		// First survivor has stale record, second doesn't
		const mockGet = vi
			.fn()
			.mockResolvedValueOnce(
				new TextEncoder().encode('{"proxy":"stale-config"}'),
			)
			.mockResolvedValueOnce(null);

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
		];

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		// One stale record, one absent → not absent from all
		expect(result.deadNodeAbsentFromDHT).toBe(false);
		expect(result.staleRecordCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Integration-style tests
// ---------------------------------------------------------------------------

describe("verifier integration scenarios", () => {
	it("verifyTopology handles large mesh correctly", async () => {
		// 5-node full mesh
		const peerIds = ["peer-0", "peer-1", "peer-2", "peer-3", "peer-4"];

		const nodes = peerIds.map((id, idx) => {
			const peers = peerIds
				.filter((_, i) => i !== idx)
				.map((p) => ({ toString: () => p }));
			return makeNode({ peerId: id, getPeers: () => peers });
		});

		const result = await verifyTopology(nodes);

		// 5 nodes → 10 possible edges (n*(n-1)/2)
		// Each node sees 4 peers → 20 raw edges → 10 unique
		expect(result.edges.length).toBe(20);
		expect(result.connectivityScore).toBeCloseTo(1.0);
		expect(result.isolatedPeerIds).toEqual([]);
	});

	it("verifyCrossDiscovery handles partial DHT failures", async () => {
		// First call succeeds, second fails
		let callCount = 0;
		const mockGet = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return new Uint8Array([1]);
			}
			throw new Error("timeout");
		});

		const nodes = [
			makeNode({ peerId: "peer-0", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-1", contentRouting: { get: mockGet } }),
			makeNode({ peerId: "peer-2", contentRouting: { get: mockGet } }),
		];

		const result = await verifyCrossDiscovery(nodes, "test", "vless");

		// peer-0 → peer-1: succeeds, peer-2: fails
		expect(result["peer-0"]).toEqual(["peer-1"]);
	});

	it("verifyTombstone handles all stale scenario", async () => {
		const mockGet = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode('{"proxy":"old-config"}'));

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = Array.from({ length: 5 }, (_, i) =>
			makeNode({ peerId: `peer-${i}`, contentRouting: { get: mockGet } }),
		);

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		expect(result.deadNodeAbsentFromDHT).toBe(false);
		expect(result.staleRecordCount).toBe(5);
	});

	it("verifyTombstone handles all absent scenario", async () => {
		const mockGet = vi.fn().mockResolvedValue(null);

		const tombstonedNode = makeNode({ peerId: "dead-peer" });
		const survivingNodes = Array.from({ length: 5 }, (_, i) =>
			makeNode({ peerId: `peer-${i}`, contentRouting: { get: mockGet } }),
		);

		const result = await verifyTombstone(
			tombstonedNode,
			survivingNodes,
			"test",
			"vless",
		);

		expect(result.deadNodeAbsentFromDHT).toBe(true);
		expect(result.staleRecordCount).toBe(0);
	});
});
