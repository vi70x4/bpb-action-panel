import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

const mockRunHarness = vi.fn<(opts: unknown) => Promise<unknown>>();
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

vi.mock("./runner.js", () => ({
	runHarness: (opts: unknown) => mockRunHarness(opts),
}));

// Mock process.exit to prevent test termination - must use hoisted to be
// available before the module is imported. The mock throws so we can catch it.
// We track call count to avoid infinite loop in the catch handler.
const mockExit = vi.hoisted(() => {
	let callCount = 0;
	return vi.fn((code?: number) => {
		callCount++;
		// Only throw on the first call (from main). The catch handler also calls
		// process.exit, which we let through silently to avoid infinite loop.
		if (callCount === 1) {
			throw new Error(`process.exit(${code})`);
		}
	});
});
vi.hoisted(() => vi.spyOn(process, "exit").mockImplementation(mockExit));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

// We need to import dynamically since the module calls main() on import
async function importHarnessIndex() {
	vi.resetModules();
	return import("./index.js");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
	overrides: {
		success?: boolean;
		health?: "GREEN" | "YELLOW" | "RED";
		connectivityScore?: number;
		discoveryScore?: number;
		tombstoneScore?: number;
		isolatedCount?: number;
		durationMs?: number;
		errors?: string[];
		discoveryResults?: Record<string, string[]>;
	} = {},
) {
	const {
		success = true,
		health = "GREEN",
		connectivityScore = 0.95,
		discoveryScore = 0.9,
		tombstoneScore = 1.0,
		isolatedCount = 0,
		durationMs = 1234,
		errors = [],
		discoveryResults = {},
	} = overrides;

	return {
		success,
		metrics: {
			health,
			connectivityScore,
			discoveryScore,
			tombstoneScore,
			staleRecordCount: 0,
			isolatedCount,
			peerCounts: {},
			discoveryResults,
		},
		topology: {
			nodes: [],
			edges: [],
			isolatedPeerIds: [],
			connectivityScore: 0.95,
		},
		errors,
		durationMs,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("harness CLI", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset argv to default
		process.argv = ["node", "index.ts"];
		// Reset module cache so main() runs again on each test
		vi.resetModules();
	});

	// ---------------------------------------------------------------------------
	// Smoke mode (default)
	// ---------------------------------------------------------------------------

	describe("smoke mode (default)", () => {
		it("uses smoke options when no mode is provided", async () => {
			mockRunHarness.mockResolvedValue(makeResult());

			await importHarnessIndex();

			expect(mockRunHarness).toHaveBeenCalledTimes(1);
			const opts = mockRunHarness.mock.calls[0][0] as {
				nodeCount: number;
				network: string;
				convergenceTimeoutMs: number;
				ttlSeconds: number;
				protocol: string;
				verifyTombstones: boolean;
				killNodeIndex: number;
			};

			expect(opts.nodeCount).toBe(3);
			expect(opts.network).toBe("harness-smoke");
			expect(opts.convergenceTimeoutMs).toBe(15000);
			expect(opts.ttlSeconds).toBe(300);
			expect(opts.protocol).toBe("vless");
			expect(opts.verifyTombstones).toBe(true);
			expect(opts.killNodeIndex).toBe(2);
		});

		it("uses smoke mode when 'smoke' is passed explicitly", async () => {
			process.argv = ["node", "index.ts", "smoke"];
			mockRunHarness.mockResolvedValue(makeResult());

			await importHarnessIndex();

			expect(mockRunHarness).toHaveBeenCalledTimes(1);
			const opts = mockRunHarness.mock.calls[0][0] as { network: string };
			expect(opts.network).toBe("harness-smoke");
		});
	});

	// ---------------------------------------------------------------------------
	// Stress mode
	// ---------------------------------------------------------------------------

	describe("stress mode", () => {
		it("uses stress options when 'stress' is passed", async () => {
			process.argv = ["node", "index.ts", "stress"];
			mockRunHarness.mockResolvedValue(makeResult());

			await importHarnessIndex();

			expect(mockRunHarness).toHaveBeenCalledTimes(1);
			const opts = mockRunHarness.mock.calls[0][0] as {
				nodeCount: number;
				network: string;
				convergenceTimeoutMs: number;
				ttlSeconds: number;
				protocol: string;
				verifyTombstones: boolean;
				killNodeIndex: number;
			};

			expect(opts.nodeCount).toBe(5);
			expect(opts.network).toBe("harness-stress");
			expect(opts.convergenceTimeoutMs).toBe(20000);
			expect(opts.ttlSeconds).toBe(600);
			expect(opts.protocol).toBe("vless");
			expect(opts.verifyTombstones).toBe(true);
			expect(opts.killNodeIndex).toBe(4);
		});
	});

	// ---------------------------------------------------------------------------
	// Output formatting
	// ---------------------------------------------------------------------------

	describe("output formatting", () => {
		it("prints the harness header", async () => {
			mockRunHarness.mockResolvedValue(makeResult());

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain("Swarm Truth Harness v1");
			expect(output).toContain("Mode: smoke");
			expect(output).toContain("Nodes: 3");
			expect(output).toContain("Network: harness-smoke");
		});

		it("prints success indicator when harness succeeds", async () => {
			mockRunHarness.mockResolvedValue(makeResult({ success: true }));

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain("Success: ✅");
		});

		it("prints failure indicator when harness fails", async () => {
			mockRunHarness.mockResolvedValue(makeResult({ success: false }));

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain("Success: ❌");
		});

		it("prints metrics summary", async () => {
			mockRunHarness.mockResolvedValue(
				makeResult({
					health: "GREEN",
					connectivityScore: 0.95,
					discoveryScore: 0.88,
					tombstoneScore: 1.0,
					isolatedCount: 0,
					durationMs: 2500,
				}),
			);

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain("Health: GREEN");
			expect(output).toContain("Connectivity: 95.0%");
			expect(output).toContain("Discovery: 88.0%");
			expect(output).toContain("Tombstone: 100.0%");
			expect(output).toContain("Isolated nodes: 0");
			expect(output).toContain("Duration: 2500ms");
		});

		it("prints errors when present", async () => {
			mockRunHarness.mockResolvedValue(
				makeResult({
					errors: [
						"Cluster spawn failed: timeout",
						"Topology verification failed",
					],
				}),
			);

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain("⚠️  Errors:");
			expect(output).toContain("Cluster spawn failed: timeout");
			expect(output).toContain("Topology verification failed");
		});

		it("prints discovery matrix when available", async () => {
			mockRunHarness.mockResolvedValue(
				makeResult({
					discoveryResults: {
						"peer-0-1234567890ab": ["peer-1", "peer-2"],
						"peer-1-1234567890ab": ["peer-0"],
					},
				}),
			);

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain("🔍 Discovery matrix:");
			// The format is: querier.slice(0, 12) + "..." and d.slice(0, 8) + "..."
			expect(output).toContain("peer-0-12345... found: [peer-1..., peer-2...]");
			expect(output).toContain("peer-1-12345... found: [peer-0...]");
		});

		it("prints full JSON result", async () => {
			const result = makeResult({ success: true });
			mockRunHarness.mockResolvedValue(result);

			await importHarnessIndex();

			const output = mockConsoleLog.mock.calls
				.map((c) => c.join(" "))
				.join("\n");
			expect(output).toContain('"success": true');
		});
	});

	// ---------------------------------------------------------------------------
	// Exit codes
	// ---------------------------------------------------------------------------

	describe("exit codes", () => {
		it("exits with 0 on success", async () => {
			mockRunHarness.mockResolvedValue(makeResult({ success: true }));

			// The import resolves after process.exit throws, which is caught by
			// main().catch(). We just need to verify mockExit was called.
			await importHarnessIndex();

			expect(mockExit).toHaveBeenCalledWith(0);
		});

		it("exits with 1 on failure", async () => {
			mockRunHarness.mockResolvedValue(makeResult({ success: false }));

			await importHarnessIndex();

			expect(mockExit).toHaveBeenCalledWith(1);
		});

		it("exits with 2 on fatal error", async () => {
			mockRunHarness.mockRejectedValue(new Error("Fatal: something broke"));

			await importHarnessIndex();

			// Fatal error causes main().catch() to call process.exit(2)
			expect(mockExit).toHaveBeenCalledWith(2);
		});
	});

	// ---------------------------------------------------------------------------
	// Edge cases
	// ---------------------------------------------------------------------------

	describe("edge cases", () => {
		it("handles unknown mode by using smoke defaults", async () => {
			process.argv = ["node", "index.ts", "unknown-mode"];
			mockRunHarness.mockResolvedValue(makeResult());

			await importHarnessIndex();

			// Unknown mode should fall through to smoke defaults
			const opts = mockRunHarness.mock.calls[0][0] as { network: string };
			expect(opts.network).toBe("harness-smoke");
		});

		it("handles empty argv by using smoke defaults", async () => {
			process.argv = ["node"];
			mockRunHarness.mockResolvedValue(makeResult());

			await importHarnessIndex();

			const opts = mockRunHarness.mock.calls[0][0] as { network: string };
			expect(opts.network).toBe("harness-smoke");
		});
	});
});
