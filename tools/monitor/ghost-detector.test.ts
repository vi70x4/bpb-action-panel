/**
 * Tests for ghost-detector pure functions: classifyPeer, parseArgs
 */
import { describe, expect, it, vi } from "vitest";

// Mock libp2p and related imports BEFORE importing the module,
// since the file top-level imports libp2p which won't resolve in test env.
vi.mock("libp2p", () => ({ createLibp2p: vi.fn() }));
vi.mock("@libp2p/tcp", () => ({ tcp: vi.fn() }));
vi.mock("@libp2p/websockets", () => ({ webSockets: vi.fn() }));
vi.mock("@libp2p/kad-dht", () => ({ kadDHT: vi.fn() }));
vi.mock("@libp2p/identify", () => ({ identify: vi.fn() }));
vi.mock("@libp2p/ping", () => ({ ping: vi.fn() }));
vi.mock("@chainsafe/libp2p-noise", () => ({ noise: vi.fn() }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: vi.fn() }));
vi.mock("uint8arrays", () => ({ toString: vi.fn() }));

import {
	type ClassifyResult,
	classifyPeer,
	type JsonInput,
	type PeerRecord,
	type PeerStatus,
	parseArgs,
} from "./ghost-detector";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return an ISO string `minutes` minutes from `base`. */
function addMinutes(base: Date, minutes: number): string {
	return new Date(base.getTime() + minutes * 60_000).toISOString();
}

/** Minimal valid PeerRecord; overrides spread on top. */
function makePeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
	return {
		peerId: "12D3KooWTestPeerId",
		protocol: "vless",
		host: "1.2.3.4",
		port: 443,
		expiresAt: addMinutes(new Date(), 60),
		ttl: 3600,
		tombstoned: false,
		...overrides,
	};
}

// ── classifyPeer ──────────────────────────────────────────────────────────────

describe("classifyPeer", () => {
	const now = new Date("2025-01-15T12:00:00Z");

	// ── Alive ──────────────────────────────────────────────────────────────────

	describe("alive (not expired)", () => {
		it("returns alive when expiresAt is in the future", () => {
			const peer = makePeer({ expiresAt: addMinutes(now, 30) });
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("alive");
			expect(result.detail).toContain("expires in 30m");
			expect(result.peer).toBe(peer);
		});

		it("returns alive with minsLeft = 0 when expiring in 15 seconds", () => {
			const peer = makePeer({ expiresAt: addMinutes(now, 0.25) });
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("alive");
			expect(result.detail).toContain("expires in 0m");
		});

		it("returns correct minutes for large time remaining", () => {
			const peer = makePeer({ expiresAt: addMinutes(now, 1440) }); // 1 day
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("alive");
			expect(result.detail).toContain("expires in 1440m");
		});
	});

	// ── Ghost ──────────────────────────────────────────────────────────────────

	describe("ghost (expired, no tombstone)", () => {
		it("returns ghost for expired peer with tombstoned=false", () => {
			const peer = makePeer({
				expiresAt: addMinutes(now, -10),
				tombstoned: false,
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("ghost");
			expect(result.detail).toContain("NO TOMBSTONE → GHOST");
			expect(result.detail).toContain("expired 10m ago");
		});

		it("returns ghost for long-expired peer (days ago)", () => {
			const peer = makePeer({
				expiresAt: addMinutes(now, -7200), // 5 days
				tombstoned: false,
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("ghost");
			expect(result.detail).toContain("expired 7200m ago");
			expect(result.detail).toContain("NO TOMBSTONE → GHOST");
		});
	});

	// ── Stale ──────────────────────────────────────────────────────────────────

	describe("stale (expired but tombstoned)", () => {
		it("returns stale for expired peer with tombstoned=true", () => {
			const peer = makePeer({
				expiresAt: addMinutes(now, -5),
				tombstoned: true,
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("stale");
			expect(result.detail).toContain("tombstoned but record persists");
			expect(result.detail).toContain("expired 5m ago");
		});

		it("returns stale for just-expired tombstoned peer", () => {
			// expired 1 second ago
			const peer = makePeer({
				expiresAt: new Date(now.getTime() - 1000).toISOString(),
				tombstoned: true,
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("stale");
			expect(result.detail).toContain("tombstoned but record persists");
		});
	});

	// ── Edge cases ────────────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("treats expiresAt exactly equal to now as expired (now >= expires)", () => {
			const exactNow = now.toISOString();
			const peer = makePeer({ expiresAt: exactNow, tombstoned: false });
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("ghost");
		});

		it("treats expiresAt 1ms before now as expired", () => {
			const peer = makePeer({
				expiresAt: new Date(now.getTime() - 1).toISOString(),
				tombstoned: false,
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("ghost");
		});

		it("classifies vless protocol correctly", () => {
			const peer = makePeer({
				protocol: "vless",
				expiresAt: addMinutes(now, -1),
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("ghost");
			expect(result.peer.protocol).toBe("vless");
		});

		it("classifies hysteria2 protocol correctly", () => {
			const peer = makePeer({
				protocol: "hysteria2",
				expiresAt: addMinutes(now, -1),
			});
			const result = classifyPeer(peer, now);
			expect(result.status).toBe("ghost");
			expect(result.peer.protocol).toBe("hysteria2");
		});

		it("bornAt field presence does not affect classification", () => {
			const peerWithBorn = makePeer({
				expiresAt: addMinutes(now, -1),
				bornAt: addMinutes(now, -60),
			});
			const peerWithout = makePeer({ expiresAt: addMinutes(now, -1) });

			const resultWith = classifyPeer(peerWithBorn, now);
			const resultWithout = classifyPeer(peerWithout, now);

			expect(resultWith.status).toBe(resultWithout.status);
			expect(resultWith.detail).toBe(resultWithout.detail);
		});
	});
});

// ── parseArgs ────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
	it("returns defaults for minimal argv (node + script)", () => {
		const result = parseArgs(["node", "ghost-detector.ts"]);
		expect(result).toEqual({
			network: "bpb-default",
			jsonPath: null,
			probe: false,
			bootstrap: null,
		});
	});

	it("overrides network with --network", () => {
		const result = parseArgs([
			"node",
			"ghost-detector.ts",
			"--network",
			"mynet",
		]);
		expect(result.network).toBe("mynet");
	});

	it("sets jsonPath with --json", () => {
		const result = parseArgs([
			"node",
			"ghost-detector.ts",
			"--json",
			"/path/to/snapshot.json",
		]);
		expect(result.jsonPath).toBe("/path/to/snapshot.json");
	});

	it("enables probe with --probe", () => {
		const result = parseArgs(["node", "ghost-detector.ts", "--probe"]);
		expect(result.probe).toBe(true);
	});

	it("sets bootstrap with --bootstrap", () => {
		const result = parseArgs([
			"node",
			"ghost-detector.ts",
			"--bootstrap",
			"/ip4/1.2.3.4/tcp/4001/p2p/peerid",
		]);
		expect(result.bootstrap).toBe("/ip4/1.2.3.4/tcp/4001/p2p/peerid");
	});

	it("handles all flags combined", () => {
		const result = parseArgs([
			"node",
			"ghost-detector.ts",
			"--network",
			"testnet",
			"--json",
			"/tmp/peers.json",
			"--probe",
			"--bootstrap",
			"/ip4/10.0.0.1/tcp/4001/p2p/QmPeer",
		]);
		expect(result).toEqual({
			network: "testnet",
			jsonPath: "/tmp/peers.json",
			probe: true,
			bootstrap: "/ip4/10.0.0.1/tcp/4001/p2p/QmPeer",
		});
	});

	it("reads next arg as value for --json when provided", () => {
		const result = parseArgs([
			"node",
			"ghost-detector.ts",
			"--json",
			"data.json",
		]);
		expect(result.jsonPath).toBe("data.json");
	});

	it("exits on unknown flag", () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => parseArgs(["node", "ghost-detector.ts", "--bogus"])).toThrow(
			"process.exit",
		);
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(errorSpy).toHaveBeenCalledWith("Unknown flag: --bogus");

		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
