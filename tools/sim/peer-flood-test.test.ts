import { describe, expect, it, vi } from "vitest";
import { buildMockConfig, parseArgs, percentile } from "./peer-flood-test.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake process.argv array for parseArgs() tests.
 * The first two entries are Node + script path (ignored by parseArgs).
 */
function makeArgv(...args: string[]): string[] {
	return ["node", "peer-flood-test.ts", ...args];
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	it("returns default count of 10 when no args are provided", () => {
		const originalArgv = process.argv;
		process.argv = makeArgv();
		try {
			const result = parseArgs();
			expect(result.count).toBe(10);
		} finally {
			process.argv = originalArgv;
		}
	});

	it("parses --count N from argv", () => {
		const originalArgv = process.argv;
		process.argv = makeArgv("--count", "5");
		try {
			const result = parseArgs();
			expect(result.count).toBe(5);
		} finally {
			process.argv = originalArgv;
		}
	});

	it("exits with code 1 when --count is not a number", () => {
		const originalArgv = process.argv;
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		process.argv = makeArgv("--count", "abc");
		try {
			parseArgs();
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(errorSpy).toHaveBeenCalledWith("--count must be an integer >= 2");
		} finally {
			process.argv = originalArgv;
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("exits with code 1 when --count is less than 2", () => {
		const originalArgv = process.argv;
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		process.argv = makeArgv("--count", "1");
		try {
			parseArgs();
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(errorSpy).toHaveBeenCalledWith("--count must be an integer >= 2");
		} finally {
			process.argv = originalArgv;
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("exits with code 1 when --count is negative", () => {
		const originalArgv = process.argv;
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		process.argv = makeArgv("--count", "-3");
		try {
			parseArgs();
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			process.argv = originalArgv;
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("ignores --count at the end of argv without a following value", () => {
		const originalArgv = process.argv;
		process.argv = makeArgv("--count");
		try {
			// No value after --count → args[i + 1] is undefined → falsy check fails →
			// the loop exits silently and the default count (10) is returned.
			const result = parseArgs();
			expect(result.count).toBe(10);
		} finally {
			process.argv = originalArgv;
		}
	});

	it("accepts --count with a large number", () => {
		const originalArgv = process.argv;
		process.argv = makeArgv("--count", "1000");
		try {
			const result = parseArgs();
			expect(result.count).toBe(1000);
		} finally {
			process.argv = originalArgv;
		}
	});
});

// ---------------------------------------------------------------------------
// buildMockConfig
// ---------------------------------------------------------------------------

describe("buildMockConfig", () => {
	it("returns a valid ProxyConfig for a given peerId", () => {
		const peerId = "12D3KooWRby97UB99e3J3PNs2Ep4RQFq2ByoFkEi7AVFYvMJrKg5";
		const config = buildMockConfig(peerId);

		expect(config).toEqual({
			peerId,
			protocol: "vless",
			host: `${peerId.slice(0, 8)}.trycloudflare.com`,
			port: 443,
			uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
			sni: `${peerId.slice(0, 8)}.trycloudflare.com`,
			security: "tls",
			network: "bpb-sim",
			ttl: 2340,
			bornAt: expect.any(String),
			expiresAt: expect.any(String),
		});
	});

	it("derives host and sni from the first 8 chars of peerId", () => {
		const peerId = "abcdef1234567890";
		const config = buildMockConfig(peerId);

		expect(config.host).toBe("abcdef12.trycloudflare.com");
		expect(config.sni).toBe("abcdef12.trycloudflare.com");
	});

	it("sets bornAt to current ISO time and expiresAt to bornAt + ttl seconds", () => {
		const peerId = "testpeer1234567890";
		const before = Date.now();
		const config = buildMockConfig(peerId);
		const after = Date.now();

		const bornAtMs = new Date(config.bornAt).getTime();
		const expiresAtMs = new Date(config.expiresAt).getTime();

		// bornAt is between before and after
		expect(bornAtMs).toBeGreaterThanOrEqual(before);
		expect(bornAtMs).toBeLessThanOrEqual(after);

		// expiresAt = bornAt + ttl * 1000
		expect(expiresAtMs - bornAtMs).toBe(config.ttl * 1000);
	});

	it("uses a fixed TTL of 2340 seconds (39 minutes)", () => {
		const config = buildMockConfig("anypeerId");
		expect(config.ttl).toBe(2340);
	});

	it("always uses protocol vless and network bpb-sim", () => {
		const config = buildMockConfig("peer");
		expect(config.protocol).toBe("vless");
		expect(config.network).toBe("bpb-sim");
		expect(config.security).toBe("tls");
		expect(config.port).toBe(443);
	});

	it("uses a fixed UUID", () => {
		const config = buildMockConfig("peer");
		expect(config.uuid).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
	});
});

// ---------------------------------------------------------------------------
// percentile
// ---------------------------------------------------------------------------

describe("percentile", () => {
	it("returns the median (p50) for an odd-length array", () => {
		const sorted = [1, 2, 3, 4, 5];
		// idx = ceil(0.5 * 5) - 1 = ceil(2.5) - 1 = 3 - 1 = 2 → sorted[2] = 3
		expect(percentile(sorted, 50)).toBe(3);
	});

	it("returns the median (p50) for an even-length array", () => {
		const sorted = [1, 2, 3, 4, 5, 6];
		// idx = ceil(0.5 * 6) - 1 = ceil(3) - 1 = 3 - 1 = 2 → sorted[2] = 3
		expect(percentile(sorted, 50)).toBe(3);
	});

	it("returns the maximum for p100", () => {
		const sorted = [10, 20, 30, 40, 50];
		// idx = ceil(1.0 * 5) - 1 = 5 - 1 = 4 → sorted[4] = 50
		expect(percentile(sorted, 100)).toBe(50);
	});

	it("returns the minimum for p0", () => {
		const sorted = [10, 20, 30, 40, 50];
		// idx = ceil(0 * 5) - 1 = 0 - 1 = -1 → max(0, -1) = 0 → sorted[0] = 10
		expect(percentile(sorted, 0)).toBe(10);
	});

	it("returns the minimum for p1", () => {
		const sorted = [10, 20, 30, 40, 50];
		// idx = ceil(0.01 * 5) - 1 = ceil(0.05) - 1 = 1 - 1 = 0 → sorted[0] = 10
		expect(percentile(sorted, 1)).toBe(10);
	});

	it("handles a single-element array", () => {
		const sorted = [42];
		// idx = ceil(p/100 * 1) - 1 = ceil(p/100) - 1
		// For p=50: ceil(0.5) - 1 = 1 - 1 = 0 → sorted[0] = 42
		expect(percentile(sorted, 50)).toBe(42);
		expect(percentile(sorted, 100)).toBe(42);
		expect(percentile(sorted, 0)).toBe(42);
	});

	it("handles a two-element array", () => {
		const sorted = [10, 20];
		// p50: ceil(0.5 * 2) - 1 = ceil(1) - 1 = 1 - 1 = 0 → sorted[0] = 10
		expect(percentile(sorted, 50)).toBe(10);
		// p95: ceil(0.95 * 2) - 1 = ceil(1.9) - 1 = 2 - 1 = 1 → sorted[1] = 20
		expect(percentile(sorted, 95)).toBe(20);
	});

	it("returns the last element for high percentiles", () => {
		const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		// p95: ceil(0.95 * 10) - 1 = ceil(9.5) - 1 = 10 - 1 = 9 → sorted[9] = 10
		expect(percentile(sorted, 95)).toBe(10);
	});

	it("does not mutate the input array", () => {
		const sorted = [5, 3, 1, 4, 2];
		const copy = [...sorted];
		percentile(sorted, 50);
		expect(sorted).toEqual(copy);
	});

	it("works with already-sorted large arrays", () => {
		const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentile(sorted, 50)).toBe(50);
		expect(percentile(sorted, 95)).toBe(95);
		expect(percentile(sorted, 99)).toBe(99);
	});
});
