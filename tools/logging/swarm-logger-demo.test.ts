import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Demo mode — verifies the demo block at the bottom of swarm-logger.ts runs
// without errors and produces structured console output.
//
// The demo block is guarded by `isMain`, which checks process.argv[1].
// We set process.argv before each test, call vi.resetModules() to clear the
// module cache, then use vi.importActual() so the module body re-executes
// with our custom argv.
// ---------------------------------------------------------------------------

describe("swarm-logger demo mode", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let origArgv: string[];

	beforeEach(() => {
		// Spy on ALL console methods to capture every demo output
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		origArgv = [...process.argv];
		// Set process.argv so the isMain guard inside swarm-logger.ts triggers
		process.argv = ["node", "swarm-logger.ts"];
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		process.argv = origArgv;
	});

	it("demo mode logs to console", async () => {
		vi.resetModules();
		await vi.importActual("./swarm-logger.ts");

		// Merge all captured output from all console methods
		const allLines = [
			...logSpy.mock.calls.map((c) => c[0] as string),
			...warnSpy.mock.calls.map((c) => c[0] as string),
			...errorSpy.mock.calls.map((c) => c[0] as string),
		];

		// The demo prints a header, subsystem lines, and a footer
		expect(allLines.length).toBeGreaterThan(0);

		// Header
		expect(allLines.some((l) => l.includes("Swarm Logger Demo"))).toBe(true);

		// At least one subsystem should appear in the output
		const subsystemTags = ["DHT", "BOOTSTRAP", "GHOST", "TUNNEL", "LIFECYCLE"];
		for (const tag of subsystemTags) {
			expect(allLines.some((l) => l.includes(`[${tag}]`))).toBe(true);
		}

		// Footer
		expect(allLines.some((l) => l.includes("End Demo"))).toBe(true);
	});

	it("demo mode creates loggers for all subsystems", async () => {
		vi.resetModules();
		await vi.importActual("./swarm-logger.ts");

		const allLines = [
			...logSpy.mock.calls.map((c) => c[0] as string),
			...warnSpy.mock.calls.map((c) => c[0] as string),
			...errorSpy.mock.calls.map((c) => c[0] as string),
		];

		// Verify each static factory's subsystem tag appears
		expect(allLines.some((l) => /\[DHT\]/.test(l))).toBe(true);
		expect(allLines.some((l) => /\[BOOTSTRAP\]/.test(l))).toBe(true);
		expect(allLines.some((l) => /\[GHOST\]/.test(l))).toBe(true);
		expect(allLines.some((l) => /\[TUNNEL\]/.test(l))).toBe(true);
		expect(allLines.some((l) => /\[LIFECYCLE\]/.test(l))).toBe(true);
	});

	it("demo mode does not throw", async () => {
		// If the demo block throws, vi.importActual rejects — this test fails
		vi.resetModules();
		await expect(vi.importActual("./swarm-logger.ts")).resolves.not.toThrow();
	});
});
