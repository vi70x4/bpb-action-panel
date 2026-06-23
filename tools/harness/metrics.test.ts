import { describe, expect, it, vi } from "vitest";
import { computeMetrics } from "./metrics.js";
import type { HarnessMetrics, TopologySnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
	overrides: {
		id?: string;
		peerId: string;
		getPeers?: () => unknown[];
		multiaddrs?: string[];
		announced?: boolean;
		tombstoned?: boolean;
		config?: unknown;
	} = { peerId: "peer-0" },
) {
	const { id, peerId, getPeers, multiaddrs, announced, tombstoned, config } =
		overrides;
	return {
		id: id ?? peerId,
		peerId,
		libp2pNode: getPeers ? { getPeers } : null,
		multiaddrs: multiaddrs ?? [],
		announced: announced ?? false,
		tombstoned: tombstoned ?? false,
		config,
	};
}

function makeTopology(
	overrides: Partial<TopologySnapshot> = {},
): TopologySnapshot {
	return {
		edges: [],
		nodes: [],
		isolatedPeerIds: [],
		connectivityScore: 1.0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Health verdict
// ---------------------------------------------------------------------------

describe("computeMetrics → health verdict", () => {
	it("returns GREEN health when all scores are high", () => {
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0", getPeers: () => [1, 2] }),
				makeNode({ peerId: "peer-1", getPeers: () => [1, 2] }),
				makeNode({ peerId: "peer-2", getPeers: () => [1, 2] }),
			],
			connectivityScore: 1.0,
		});

		const metrics = computeMetrics(
			topology,
			{
				"peer-0": ["peer-1", "peer-2"],
				"peer-1": ["peer-0", "peer-2"],
				"peer-2": ["peer-0", "peer-1"],
			},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		expect(metrics.health).toBe("GREEN");
		expect(metrics.connectivityScore).toBeGreaterThan(0.8);
		expect(metrics.discoveryScore).toBeGreaterThan(0.8);
		expect(metrics.tombstoneScore).toBeGreaterThan(0.8);
	});

	it("returns YELLOW health when some scores are degraded", () => {
		// connectivity=1.0, discovery=0.67, tombstone=1.0 → not all >0.8, none <0.5
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0", getPeers: () => [1] }),
				makeNode({ peerId: "peer-1", getPeers: () => [0] }),
				makeNode({ peerId: "peer-2", getPeers: () => [0] }),
			],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});

		const metrics = computeMetrics(
			topology,
			{
				"peer-0": ["peer-1", "peer-2"],
				"peer-1": ["peer-0"],
				"peer-2": [],
			},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		// discovery = 3 / (3*2) = 0.5, tombstone=1.0, connectivity=1.0
		// Not all > 0.8 (discovery=0.5), none < 0.5 → YELLOW
		expect(metrics.health).toBe("YELLOW");
	});

	it("returns RED health when critical failures", () => {
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0", getPeers: () => [] }),
				makeNode({ peerId: "peer-1", getPeers: () => [] }),
			],
			isolatedPeerIds: ["peer-0", "peer-1"],
			connectivityScore: 0.1,
		});

		const metrics = computeMetrics(
			topology,
			{
				"peer-0": [],
				"peer-1": [],
			},
			{ deadNodeAbsentFromDHT: false, staleRecordCount: 3 },
			2,
		);

		expect(metrics.health).toBe("RED");
	});
});

// ---------------------------------------------------------------------------
// connectivityScore
// ---------------------------------------------------------------------------

describe("computeMetrics → connectivityScore", () => {
	it("computes connectivityScore from topology", () => {
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0", getPeers: () => [1, 2] }),
				makeNode({ peerId: "peer-1", getPeers: () => [1, 2] }),
				makeNode({ peerId: "peer-2", getPeers: () => [1, 2] }),
			],
			connectivityScore: 0.95,
		});

		const metrics = computeMetrics(
			topology,
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		// No isolated nodes → no penalty, clamped to [0,1]
		expect(metrics.connectivityScore).toBeCloseTo(0.95);
	});

	it("penalizes isolated nodes in connectivityScore", () => {
		const topology = makeTopology({
			nodes: [makeNode({ peerId: "peer-0" })],
			isolatedPeerIds: ["peer-0"],
			connectivityScore: 0.9,
		});

		const metrics = computeMetrics(
			topology,
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			1,
		);

		// 0.9 - 0.15 = 0.75
		expect(metrics.connectivityScore).toBeCloseTo(0.75);
	});

	it("clamps connectivityScore to minimum 0", () => {
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0" }),
				makeNode({ peerId: "peer-1" }),
				makeNode({ peerId: "peer-2" }),
			],
			isolatedPeerIds: ["peer-0", "peer-1", "peer-2"],
			connectivityScore: 0.1,
		});

		const metrics = computeMetrics(
			topology,
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		// 0.1 - 3 * 0.15 = -0.35 → clamped to 0
		expect(metrics.connectivityScore).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// discoveryScore
// ---------------------------------------------------------------------------

describe("computeMetrics → discoveryScore", () => {
	it("computes discoveryScore from discoveryResults", () => {
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0" }),
				makeNode({ peerId: "peer-1" }),
				makeNode({ peerId: "peer-2" }),
			],
		});

		const metrics = computeMetrics(
			topology,
			{
				"peer-0": ["peer-1", "peer-2"],
				"peer-1": ["peer-0", "peer-2"],
				"peer-2": ["peer-0", "peer-1"],
			},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		// 6 actual / 3*2 possible = 1.0
		expect(metrics.discoveryScore).toBeCloseTo(1.0);
	});

	it("returns 0 discoveryScore when no discoveries", () => {
		const topology = makeTopology({
			nodes: [makeNode({ peerId: "peer-0" }), makeNode({ peerId: "peer-1" })],
		});

		const metrics = computeMetrics(
			topology,
			{ "peer-0": [], "peer-1": [] },
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			2,
		);

		expect(metrics.discoveryScore).toBe(0);
	});

	it("returns 0 discoveryScore when totalNodes is 0", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			0,
		);

		expect(metrics.discoveryScore).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// tombstoneScore
// ---------------------------------------------------------------------------

describe("computeMetrics → tombstoneScore", () => {
	it("returns 1.0 when dead node is absent from DHT", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			1,
		);

		expect(metrics.tombstoneScore).toBe(1.0);
	});

	it("returns partial credit when stale records exist", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: false, staleRecordCount: 1 },
			1,
		);

		// 0.5 - 1 * 0.1 = 0.4
		expect(metrics.tombstoneScore).toBeCloseTo(0.4);
	});

	it("returns 0.5 when deadNodeAbsentFromDHT=false and staleRecordCount=0", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: false, staleRecordCount: 0 },
			1,
		);

		expect(metrics.tombstoneScore).toBeCloseTo(0.5);
	});

	it("penalizes high staleRecordCount", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 5 },
			1,
		);

		// 1.0 - 5 * 0.1 = 0.5
		expect(metrics.tombstoneScore).toBeCloseTo(0.5);
	});
});

// ---------------------------------------------------------------------------
// Isolated nodes
// ---------------------------------------------------------------------------

describe("computeMetrics → isolatedCount", () => {
	it("counts isolated nodes", () => {
		const topology = makeTopology({
			nodes: [
				makeNode({ peerId: "peer-0" }),
				makeNode({ peerId: "peer-1" }),
				makeNode({ peerId: "peer-2" }),
			],
			isolatedPeerIds: ["peer-1", "peer-2"],
		});

		const metrics = computeMetrics(
			topology,
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		expect(metrics.isolatedCount).toBe(2);
	});

	it("reports 0 isolated nodes when none are isolated", () => {
		const topology = makeTopology({
			nodes: [makeNode({ peerId: "peer-0" })],
			isolatedPeerIds: [],
		});

		const metrics = computeMetrics(
			topology,
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			1,
		);

		expect(metrics.isolatedCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("computeMetrics → edge cases", () => {
	it("handles zero total nodes without throwing", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			0,
		);

		// totalPossible = 0 → discoveryScore = 0 → RED
		expect(metrics.discoveryScore).toBe(0);
		expect(metrics.health).toBe("RED");
	});

	it("counts peers via libp2pNode.getPeers()", () => {
		const node0 = makeNode({ peerId: "peer-0", getPeers: () => [1, 2] });
		const node1 = makeNode({ peerId: "peer-1", getPeers: () => [1] });
		const node2 = makeNode({ peerId: "peer-2" }); // no getPeers

		const topology = makeTopology({
			nodes: [node0, node1, node2],
		});

		const metrics = computeMetrics(
			topology,
			{},
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			3,
		);

		expect(metrics.peerCounts).toEqual({
			"peer-0": 2,
			"peer-1": 1,
			"peer-2": 0,
		});
	});

	it("passes through staleRecordCount from tombstoneResult", () => {
		const metrics = computeMetrics(
			makeTopology(),
			{},
			{ deadNodeAbsentFromDHT: false, staleRecordCount: 7 },
			1,
		);

		expect(metrics.staleRecordCount).toBe(7);
	});

	it("passes through discoveryResults unchanged", () => {
		const discoveryResults = {
			"peer-0": ["peer-1"],
			"peer-1": ["peer-0"],
		};

		const topology = makeTopology({
			nodes: [makeNode({ peerId: "peer-0" }), makeNode({ peerId: "peer-1" })],
		});

		const metrics = computeMetrics(
			topology,
			discoveryResults,
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			2,
		);

		expect(metrics.discoveryResults).toBe(discoveryResults);
	});
});
