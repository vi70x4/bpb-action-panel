// ---------------------------------------------------------------------------
// TunnelEmitter class tests
// ---------------------------------------------------------------------------
// Covers the TunnelEmitter class (lines ~158-304 of tunnel-emitter.ts).
// Existing tunnel-emitter.test.ts only covers pure helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must appear before importing the module under test
// ---------------------------------------------------------------------------
vi.mock("node:crypto", () => ({
	randomBytes: vi.fn((len: number) => Buffer.alloc(len, 0x42)),
}));

vi.mock("cloudflared", () => ({
	startTunnel: vi.fn(() => ({
		url: "https://mock-try-cloudflare.example.com",
		close: vi.fn(),
	})),
}));
vi.mock("localtunnel", () => ({
	startTunnel: vi.fn(() => ({
		url: "https://mock-localtunnel.example.com",
		close: vi.fn(),
	})),
}));

import { TunnelEmitter } from "./tunnel-emitter.ts";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

type TunnelConfig = {
	provider: "trycloudflare" | "pinggy" | "localtunnel";
	latencyMs?: number;
	failureRate?: number;
	reconnectRate?: number;
	host?: string;
	port?: number;
};

function makeConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
	return {
		provider: "trycloudflare",
		port: 3000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TunnelEmitter", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		}) as unknown as ReturnType<typeof vi.spyOn>;
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		processExitSpy.mockRestore();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Constructor --------------------------------------------------------------
	describe("constructor — initializes with inactive state", () => {
		it("stores config from the supplied arguments", () => {
			const config = makeConfig({ provider: "pinggy", port: 4000 });
			const emitter = new TunnelEmitter(config);

			expect(emitter.config).toEqual(config);
		});

		it("starts as inactive", () => {
			const emitter = new TunnelEmitter(makeConfig());
			expect(emitter.active).toBe(false);
		});
	});

	// start() -----------------------------------------------------------------
	describe("start — sets active and emits TUNNEL_STARTING", () => {
		it("marks the emitter as active", () => {
			const emitter = new TunnelEmitter(makeConfig());
			expect(emitter.active).toBe(false);

			emitter.start();
			expect(emitter.active).toBe(true);
		});

		it("emits TUNNEL_STARTING before any provider-specific work", () => {
			const onStarting = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_STARTING", onStarting);

			emitter.start();
			expect(onStarting).toHaveBeenCalledTimes(1);
		});
	});

	describe("start — tryCloudflare provider schedules ready event", () => {
		it("emits TUNNEL_READY after latency elapses", () => {
			vi.useFakeTimers();
			const onReady = vi.fn();
			const emitter = new TunnelEmitter(
				makeConfig({
					provider: "trycloudflare",
					latencyMs: 500,
					failureRate: 0,
				}),
			);
			emitter.on("TUNNEL_READY", onReady);

			emitter.start();
			expect(onReady).not.toHaveBeenCalled();

			vi.advanceTimersByTime(500);

			expect(onReady).toHaveBeenCalledTimes(1);
			expect(onReady).toHaveBeenCalledWith(
				expect.objectContaining({
					url: expect.stringContaining("trycloudflare"),
				}),
			);
		});
	});

	describe("start — pinggy provider schedules ready event", () => {
		it("emits TUNNEL_READY after latency elapses", () => {
			vi.useFakeTimers();
			const onReady = vi.fn();
			const emitter = new TunnelEmitter(
				makeConfig({ provider: "pinggy", latencyMs: 500, failureRate: 0 }),
			);
			emitter.on("TUNNEL_READY", onReady);

			emitter.start();
			expect(onReady).not.toHaveBeenCalled();

			vi.advanceTimersByTime(500);

			expect(onReady).toHaveBeenCalledTimes(1);
			expect(onReady).toHaveBeenCalledWith(
				expect.objectContaining({
					url: expect.stringContaining("pinggy"),
				}),
			);
		});
	});

	// fail() ------------------------------------------------------------------
	describe("fail — emits TUNNEL_FAILED", () => {
		it("emits TUNNEL_FAILED exactly once", () => {
			const onFailed = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_FAILED", onFailed);

			emitter.start();
			emitter.fail();

			expect(onFailed).toHaveBeenCalledTimes(1);
		});

		it("does not change active state (fail is a signal, not a stop)", () => {
			const emitter = new TunnelEmitter(makeConfig());
			emitter.start();
			expect(emitter.active).toBe(true);

			// fail() emits the event but does not set _stopped, so active stays true
			emitter.fail();
			expect(emitter.active).toBe(true);

			// Only close() transitions to inactive
			emitter.close();
			expect(emitter.active).toBe(false);
		});
	});

	describe("fail — includes error message in payload", () => {
		it("passes the supplied error through to the listener", () => {
			const onFailed = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_FAILED", onFailed);

			emitter.fail(new Error("boom"));

			expect(onFailed).toHaveBeenCalledTimes(1);
			const payload = onFailed.mock.calls[0][0];
			expect(payload).toBeDefined();
			expect(payload.error).toBeInstanceOf(Error);
			expect(payload.error.message).toBe("boom");
		});

		it("handles fail() without an argument", () => {
			const onFailed = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_FAILED", onFailed);

			emitter.fail();

			expect(onFailed).toHaveBeenCalledTimes(1);
		});
	});

	// reconnectAfter() --------------------------------------------------------
	describe("reconnectAfter — emits TUNNEL_RECONNECTING after delay", () => {
		it("does not emit immediately", () => {
			vi.useFakeTimers();

			const onReconnecting = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_RECONNECTING", onReconnecting);

			emitter.reconnectAfter(5000);
			expect(onReconnecting).not.toHaveBeenCalled();

			vi.advanceTimersByTime(4999);
			expect(onReconnecting).not.toHaveBeenCalled();
		});

		it("emits exactly once when the delay elapses", () => {
			vi.useFakeTimers();

			const onReconnecting = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_RECONNECTING", onReconnecting);

			emitter.reconnectAfter(5000);

			try {
				vi.advanceTimersByTime(5000);
			} catch {
				// process.exit mock may throw — ignore
			}

			expect(onReconnecting).toHaveBeenCalledTimes(1);
		});
	});

	// close() -----------------------------------------------------------------
	describe("close — emits TUNNEL_CLOSED and clears state", () => {
		it("emits TUNNEL_CLOSED and marks the emitter inactive", () => {
			const onClosed = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_CLOSED", onClosed);

			emitter.start();
			expect(emitter.active).toBe(true);

			emitter.close();

			expect(onClosed).toHaveBeenCalledTimes(1);
			expect(emitter.active).toBe(false);
		});

		it("clears any pending reconnect timer so TUNNEL_RECONNECTING does not fire", () => {
			vi.useFakeTimers();

			const onReconnecting = vi.fn();
			const onClosed = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_RECONNECTING", onReconnecting);
			emitter.on("TUNNEL_CLOSED", onClosed);

			emitter.start();
			emitter.reconnectAfter(10_000);

			// Close before the timer fires.
			emitter.close();
			vi.advanceTimersByTime(20_000);

			expect(onClosed).toHaveBeenCalledTimes(1);
			expect(onReconnecting).not.toHaveBeenCalled();
		});
	});

	describe("close — safe to call multiple times", () => {
		it("emits TUNNEL_CLOSED only once", () => {
			const onClosed = vi.fn();
			const emitter = new TunnelEmitter(makeConfig());
			emitter.on("TUNNEL_CLOSED", onClosed);

			emitter.close();
			emitter.close();
			emitter.close();

			expect(onClosed).toHaveBeenCalledTimes(1);
		});

		it("does not throw on repeated calls", () => {
			const emitter = new TunnelEmitter(makeConfig());
			expect(() => {
				emitter.close();
				emitter.close();
			}).not.toThrow();
		});
	});

	// active getter -----------------------------------------------------------
	describe("active getter — reflects current state", () => {
		it("returns false for a fresh emitter", () => {
			const emitter = new TunnelEmitter(makeConfig());
			expect(emitter.active).toBe(false);
		});

		it("returns true after start() and false after close()", () => {
			const emitter = new TunnelEmitter(makeConfig());
			emitter.start();
			expect(emitter.active).toBe(true);

			emitter.close();
			expect(emitter.active).toBe(false);
		});

		it("returns false only after close() (not after fail())", () => {
			const emitter = new TunnelEmitter(makeConfig());
			emitter.start();
			emitter.fail();
			// fail() does not set _stopped, so active stays true
			expect(emitter.active).toBe(true);
			emitter.close();
			expect(emitter.active).toBe(false);
		});
	});
});
