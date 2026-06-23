import { beforeEach, describe, expect, it, vi } from "vitest";
import { runHarness } from "./runner.js";
import type { HarnessOptions, HarnessResult } from "./types.js";

// ---------------------------------------------------------------------------
// Mock dependencies (hoisted)
// ---------------------------------------------------------------------------

vi.mock("./cluster.js", () => ({
	spawnCluster: vi.fn(),
}));

vi.mock("./verifier.js", () => ({
	verifyTopology: vi.fn(),
	verifyCrossDiscovery: vi.fn(),
	verifyTombstone: vi.fn(),
}));

vi.mock("./metrics.js", () => ({
	computeMetrics: vi.fn(),
}));

vi.mock("../../node/src/announce.js", () => ({
	publishTombstone: vi.fn(),
}));

// Mock process.exit in case it's called
vi.hoisted(() => vi.spyOn(process, "exit").mockImplementation(() => {}));

import { publishTombstone } from "../../node/src/announce.js";
import { spawnCluster } from "./cluster.js";
import { computeMetrics } from "./metrics.js";
import {
	verifyCrossDiscovery,
	verifyTombstone,
	verifyTopology,
} from "./verifier.js";

const mockSpawnCluster = vi.mocked(spawnCluster);
const mockVerifyTopology = vi.mocked(verifyTopology);
const mockVerifyCrossDiscovery = vi.mocked(verifyCrossDiscovery);
const mockVerifyTombstone = vi.mocked(verifyTombstone);
const mockComputeMetrics = vi.mocked(computeMetrics);
const mockPublishTombstone = vi.mocked(publishTombstone);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
	overrides: {
		id?: string;
		peerId: string;
		libp2pNode?: any;
		multiaddrs?: string[];
		announced?: boolean;
		tombstoned?: boolean;
	} = { peerId: "peer-0" },
) {
	const { id, peerId, libp2pNode, multiaddrs, announced, tombstoned } =
		overrides;
	return {
		id: id ?? peerId,
		peerId,
		libp2pNode: libp2pNode ?? { getPeers: () => [], stop: vi.fn() },
		multiaddrs: multiaddrs ?? [],
		announced: announced ?? false,
		tombstoned: tombstoned ?? false,
	};
}

function makeOptions(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
	return {
		nodeCount: 3,
		convergenceTimeoutMs: 15000,
		ttlSeconds: 300,
		network: "harness-test",
		protocol: "vless",
		verifyTombstones: true,
		killNodeIndex: undefined,
		...overrides,
	};
}

function makeCluster(nodes: ReturnType<typeof makeNode>[]) {
	return {
		nodes,
		stopAll: vi.fn().mockResolvedValue(undefined),
	};
}

function makeEmptyMetrics() {
	return {
		health: "RED" as const,
		connectivityScore: 0,
		discoveryScore: 0,
		tombstoneScore: 0,
		staleRecordCount: 0,
		isolatedCount: 0,
		peerCounts: {},
		discoveryResults: {},
	};
}

function makeGreenMetrics(
	overrides: Partial<ReturnType<typeof makeEmptyMetrics>> = {},
) {
	return {
		health: "GREEN" as const,
		connectivityScore: 0.95,
		discoveryScore: 0.9,
		tombstoneScore: 1.0,
		staleRecordCount: 0,
		isolatedCount: 0,
		peerCounts: { "peer-0": 2, "peer-1": 2, "peer-2": 2 },
		discoveryResults: {
			"peer-0": ["peer-1", "peer-2"],
			"peer-1": ["peer-0", "peer-2"],
			"peer-2": ["peer-0", "peer-1"],
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// runHarness tests
// ---------------------------------------------------------------------------

describe("runHarness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// -------------------------------------------------------------------------
	// Cluster spawn failure
	// -------------------------------------------------------------------------

	it("returns RED metrics and reports error when cluster spawn fails", async () => {
		const error = new Error("spawn refused");
		mockSpawnCluster.mockRejectedValueOnce(error);

		const opts = makeOptions();
		const result = await runHarness(opts);

		expect(result.success).toBe(false);
		expect(result.metrics.health).toBe("RED");
		expect(result.metrics.connectivityScore).toBe(0);
		expect(result.topology.nodes).toEqual([]);
		expect(result.topology.edges).toEqual([]);
		expect(result.topology.isolatedPeerIds).toEqual([]);
		expect(result.topology.connectivityScore).toBe(0);
		expect(result.errors).toContain("Cluster spawn failed: spawn refused");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		// Downstream functions should not be called
		expect(mockVerifyTopology).not.toHaveBeenCalled();
		expect(mockVerifyCrossDiscovery).not.toHaveBeenCalled();
		expect(mockComputeMetrics).not.toHaveBeenCalled();
	});

	it("handles non-Error thrown from cluster spawn", async () => {
		mockSpawnCluster.mockRejectedValueOnce("mystery error");

		const result = await runHarness(makeOptions());

		expect(result.success).toBe(false);
		expect(result.errors).toContain("Cluster spawn failed: mystery error");
	});

	// -------------------------------------------------------------------------
	// Successful cluster spawn
	// -------------------------------------------------------------------------

	it("returns success=true when metrics are GREEN", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
			makeNode({ peerId: "peer-2" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({
			"peer-0": ["peer-1", "peer-2"],
			"peer-1": ["peer-0", "peer-2"],
			"peer-2": ["peer-0", "peer-1"],
		});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.success).toBe(true);
		expect(result.metrics.health).toBe("GREEN");
		expect(result.errors).toEqual([]);
		expect(mockSpawnCluster).toHaveBeenCalledWith(expect.any(Object));
		expect(mockVerifyTopology).toHaveBeenCalledWith(nodes);
		expect(mockVerifyCrossDiscovery).toHaveBeenCalledWith(
			nodes,
			expect.any(String),
			expect.any(String),
		);
		expect(mockVerifyTombstone).toHaveBeenCalled();
		expect(mockComputeMetrics).toHaveBeenCalled();
	});

	it("returns success=true when metrics are YELLOW (still considered success)", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce({
			...makeGreenMetrics(),
			health: "YELLOW" as const,
		});

		const result = await runHarness(makeOptions());

		expect(result.success).toBe(true);
		expect(result.metrics.health).toBe("YELLOW");
	});

	it("returns success=false when metrics are RED", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: ["peer-0", "peer-1"],
			connectivityScore: 0.1,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: false,
			staleRecordCount: 3,
		});
		mockComputeMetrics.mockReturnValueOnce(makeEmptyMetrics());

		const result = await runHarness(makeOptions());

		expect(result.success).toBe(false);
		expect(result.metrics.health).toBe("RED");
	});

	// -------------------------------------------------------------------------
	// Error accumulation
	// -------------------------------------------------------------------------

	it("continues and records errors if topology verification throws", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockRejectedValueOnce(new Error("topology boom"));
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain(
			"Topology verification failed: topology boom",
		);
		expect(result.success).toBe(true); // metrics still GREEN
	});

	it("continues and records errors if cross-discovery verification throws", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockRejectedValueOnce(new Error("discovery boom"));
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain(
			"Cross-discovery verification failed: discovery boom",
		);
	});

	it("continues and records errors if tombstone verification throws", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockRejectedValueOnce(new Error("tombstone boom"));
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions({ verifyTombstones: true }));

		expect(result.errors).toContain(
			"Tombstone verification failed: tombstone boom",
		);
	});

	it("records errors from cluster.stopAll() failure", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		const cluster = makeCluster(nodes);
		cluster.stopAll.mockRejectedValueOnce(new Error("stop failed"));
		mockSpawnCluster.mockResolvedValueOnce(cluster);
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain("Cleanup failed: stop failed");
	});

	// -------------------------------------------------------------------------
	// Tombstone verification conditional
	// -------------------------------------------------------------------------

	it("skips tombstone verification when verifyTombstones is false", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions({ verifyTombstones: false }));

		expect(mockVerifyTombstone).not.toHaveBeenCalled();
		expect(mockPublishTombstone).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("publishes tombstone before stopping the doomed node", async () => {
		const doomedLibp2p = {
			getPeers: () => [],
			stop: vi.fn().mockResolvedValue(undefined),
		};
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
			makeNode({ peerId: "peer-2", libp2pNode: doomedLibp2p }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const opts = makeOptions({ killNodeIndex: 2 });
		await runHarness(opts);

		expect(mockPublishTombstone).toHaveBeenCalledWith(
			doomedLibp2p,
			opts.network,
			opts.protocol,
			"peer-2",
		);
		expect(doomedLibp2p.stop).toHaveBeenCalled();
	});

	it("uses default killNodeIndex = last node when not specified", async () => {
		const doomedLibp2p = {
			getPeers: () => [],
			stop: vi.fn().mockResolvedValue(undefined),
		};
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
			makeNode({ peerId: "peer-2", libp2pNode: doomedLibp2p }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		// No killNodeIndex specified, should default to last (index 2)
		await runHarness(makeOptions({ killNodeIndex: undefined }));

		expect(mockPublishTombstone).toHaveBeenCalledWith(
			doomedLibp2p,
			expect.any(String),
			expect.any(String),
			"peer-2",
		);
	});

	it("skips tombstone verification when doomed node at killIndex is missing", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		// killIndex=5 doesn't exist in a 1-node cluster
		const result = await runHarness(makeOptions({ killNodeIndex: 5 }));

		expect(mockVerifyTombstone).not.toHaveBeenCalled();
		expect(mockPublishTombstone).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
	});

	it("records error when tombstone score is below 1.0", async () => {
		const doomedLibp2p = {
			getPeers: () => [],
			stop: vi.fn().mockResolvedValue(undefined),
		};
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
			makeNode({ peerId: "peer-2", libp2pNode: doomedLibp2p }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		// Partial tombstone: deadNodeAbsentFromDHT=true but 2 stale records
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 2,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions({ nodeCount: 3 }));

		// score = 1 - 2/3 ≈ 0.333... which is < 1.0 → error
		expect(result.errors.some((e) => e.includes("Tombstone incomplete"))).toBe(
			true,
		);
		expect(result.errors.some((e) => e.includes("33.3%"))).toBe(true);
	});

	it("records error when deadNodeAbsentFromDHT is false (score=0)", async () => {
		const doomedLibp2p = {
			getPeers: () => [],
			stop: vi.fn().mockResolvedValue(undefined),
		};
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
			makeNode({ peerId: "peer-2", libp2pNode: doomedLibp2p }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: false,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors.some((e) => e.includes("Tombstone incomplete"))).toBe(
			true,
		);
		expect(result.errors.some((e) => e.includes("0.0%"))).toBe(true); // deadNodeAbsent=false → score=0
	});

	// -------------------------------------------------------------------------
	// Result structure
	// -------------------------------------------------------------------------

	it("includes all required fields in HarnessResult", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result).toHaveProperty("success");
		expect(result).toHaveProperty("metrics");
		expect(result).toHaveProperty("topology");
		expect(result).toHaveProperty("errors");
		expect(result).toHaveProperty("durationMs");
		expect(typeof result.success).toBe("boolean");
		expect(Array.isArray(result.errors)).toBe(true);
		expect(typeof result.durationMs).toBe("number");
	});

	it("passes correct arguments to computeMetrics", async () => {
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1" }),
		];
		const topology = {
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		};
		const discoveryResults = { "peer-0": ["peer-1"], "peer-1": ["peer-0"] };
		const tombstoneResult = {
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		};

		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce(topology);
		mockVerifyCrossDiscovery.mockResolvedValueOnce(discoveryResults);
		mockVerifyTombstone.mockResolvedValueOnce(tombstoneResult);
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const opts = makeOptions({ nodeCount: 2 });
		await runHarness(opts);

		expect(mockComputeMetrics).toHaveBeenCalledWith(
			topology,
			discoveryResults,
			tombstoneResult,
			2, // nodeCount from opts
		);
	});

	it("passes topology, network, and protocol to verifyCrossDiscovery", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const opts = makeOptions({
			network: "custom-net",
			protocol: "hysteria2",
		});
		await runHarness(opts);

		expect(mockVerifyCrossDiscovery).toHaveBeenCalledWith(
			nodes,
			"custom-net",
			"hysteria2",
		);
	});

	// -------------------------------------------------------------------------
	// Duration tracking
	// -------------------------------------------------------------------------

	it("reports positive durationMs", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("computes duration even when cluster spawn fails", async () => {
		mockSpawnCluster.mockRejectedValueOnce(new Error("boom"));

		const result = await runHarness(makeOptions());

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.success).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------

	it("handles non-Error thrown from topology verification", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockRejectedValueOnce("string error");
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain(
			"Topology verification failed: string error",
		);
	});

	it("handles non-Error thrown from cross-discovery verification", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockRejectedValueOnce(42);
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain("Cross-discovery verification failed: 42");
	});

	it("handles non-Error thrown from tombstone verification", async () => {
		const doomedLibp2p = {
			getPeers: () => [],
			stop: vi.fn().mockResolvedValue(undefined),
		};
		const nodes = [
			makeNode({ peerId: "peer-0" }),
			makeNode({ peerId: "peer-1", libp2pNode: doomedLibp2p }),
		];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockRejectedValueOnce(null);
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain("Tombstone verification failed: null");
	});

	it("handles non-Error thrown from cluster.stopAll()", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		const cluster = makeCluster(nodes);
		cluster.stopAll.mockRejectedValueOnce("stop error");
		mockSpawnCluster.mockResolvedValueOnce(cluster);
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockVerifyTombstone.mockResolvedValueOnce({
			deadNodeAbsentFromDHT: true,
			staleRecordCount: 0,
		});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		const result = await runHarness(makeOptions());

		expect(result.errors).toContain("Cleanup failed: stop error");
	});

	it("passes default tombstoneResult when verifyTombstones is false", async () => {
		const nodes = [makeNode({ peerId: "peer-0" })];
		mockSpawnCluster.mockResolvedValueOnce(makeCluster(nodes));
		mockVerifyTopology.mockResolvedValueOnce({
			nodes,
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 1.0,
		});
		mockVerifyCrossDiscovery.mockResolvedValueOnce({});
		mockComputeMetrics.mockReturnValueOnce(makeGreenMetrics());

		await runHarness(makeOptions({ verifyTombstones: false }));

		// computeMetrics should receive default tombstone result
		expect(mockComputeMetrics).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			{ deadNodeAbsentFromDHT: true, staleRecordCount: 0 },
			expect.any(Number),
		);
	});
});
