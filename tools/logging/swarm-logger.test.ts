import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Subsystem,
	SwarmLogger,
	serialize,
	swarmLog,
} from "./swarm-logger.ts";

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

describe("serialize", () => {
	it("returns empty string for undefined data", () => {
		expect(serialize(undefined)).toBe("");
	});

	it("returns empty string for empty object", () => {
		expect(serialize({})).toBe("");
	});

	it("serializes a single key-value pair", () => {
		expect(serialize({ name: "alpha" })).toBe("name=alpha");
	});

	it("serializes multiple key-value pairs as space-joined", () => {
		const result = serialize({ a: "1", b: "2" });
		expect(result).toContain("a=1");
		expect(result).toContain("b=2");
		// Space-separated order
		const parts = result.split(" ");
		expect(parts).toHaveLength(2);
	});

	it("JSON-stringifies non-string values (number)", () => {
		expect(serialize({ count: 5 })).toBe("count=5");
	});

	it("JSON-stringifies non-string values (array)", () => {
		expect(serialize({ items: [1, 2] })).toBe("items=[1,2]");
	});

	it("JSON-stringifies boolean values", () => {
		expect(serialize({ active: true })).toBe("active=true");
	});
});

// ---------------------------------------------------------------------------
// swarmLog
// ---------------------------------------------------------------------------

describe("swarmLog", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let origDebug: string | undefined;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		origDebug = process.env.DEBUG;
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		process.env.DEBUG = origDebug;
	});

	it("info level → console.log", () => {
		swarmLog("DHT", "ANNOUNCE", "info");
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("warn level → console.warn", () => {
		swarmLog("DHT", "ANNOUNCE", "warn");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("error level → console.error", () => {
		swarmLog("DHT", "FAIL", "error");
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("debug level without DEBUG env → no output", () => {
		delete process.env.DEBUG;
		swarmLog("DHT", "PROBE", "debug");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("debug level with DEBUG=swarm* → console.log", () => {
		process.env.DEBUG = "swarm*";
		swarmLog("DHT", "PROBE", "debug");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	it("log line contains [SWARM][{subsystem}][{event}]", () => {
		swarmLog("BOOTSTRAP", "JOIN", "info");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[SWARM][BOOTSTRAP][JOIN]");
	});

	it("log line without data has no trailing kv pairs", () => {
		swarmLog("GHOST", "DETECTED", "info");
		const line = logSpy.mock.calls[0][0] as string;
		// Line = timestamp + prefix, no key=value after
		const prefix = "[SWARM][GHOST][DETECTED]";
		const afterPrefix = line.split(prefix)[1];
		// After prefix there should be nothing (just timestamp before it)
		expect(line).toMatch(
			/^\d{4}-\d{2}-\d{2}T.*\[SWARM\]\[GHOST\]\[DETECTED\]$/,
		);
	});

	it("log line with data includes key=value pairs", () => {
		swarmLog("DHT", "ANNOUNCE", "info", { peer: "abc" });
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("peer=abc");
	});
});

// ---------------------------------------------------------------------------
// SwarmLogger
// ---------------------------------------------------------------------------

describe("SwarmLogger", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let origDebug: string | undefined;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		origDebug = process.env.DEBUG;
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		process.env.DEBUG = origDebug;
	});

	it("constructor sets subsystem", () => {
		const logger = new SwarmLogger("DHT");
		// Indirectly test by calling info and checking output
		logger.info("TEST");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[DHT]");
	});

	it("info delegates to swarmLog with correct subsystem", () => {
		const logger = new SwarmLogger("TUNNEL");
		logger.info("READY");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[TUNNEL][READY]");
	});

	it("warn delegates to console.warn", () => {
		const logger = new SwarmLogger("LIFECYCLE");
		logger.warn("EXPIRE");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const line = warnSpy.mock.calls[0][0] as string;
		expect(line).toContain("[LIFECYCLE][EXPIRE]");
	});

	it("error delegates to console.error", () => {
		const logger = new SwarmLogger("GHOST");
		logger.error("LOST");
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const line = errorSpy.mock.calls[0][0] as string;
		expect(line).toContain("[GHOST][LOST]");
	});

	it("debug without DEBUG env → no output", () => {
		delete process.env.DEBUG;
		const logger = new SwarmLogger("DHT");
		logger.debug("PROBE");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("debug with DEBUG=swarm* → console.log", () => {
		process.env.DEBUG = "swarm*";
		const logger = new SwarmLogger("DHT");
		logger.debug("PROBE");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	// Static factory methods
	it("SwarmLogger.dht() returns logger with DHT subsystem", () => {
		const logger = SwarmLogger.dht();
		logger.info("TEST");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[DHT]");
	});

	it("SwarmLogger.bootstrap() returns logger with BOOTSTRAP subsystem", () => {
		const logger = SwarmLogger.bootstrap();
		logger.info("TEST");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[BOOTSTRAP]");
	});

	it("SwarmLogger.ghost() returns logger with GHOST subsystem", () => {
		const logger = SwarmLogger.ghost();
		logger.info("TEST");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[GHOST]");
	});

	it("SwarmLogger.tunnel() returns logger with TUNNEL subsystem", () => {
		const logger = SwarmLogger.tunnel();
		logger.info("TEST");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[TUNNEL]");
	});

	it("SwarmLogger.lifecycle() returns logger with LIFECYCLE subsystem", () => {
		const logger = SwarmLogger.lifecycle();
		logger.info("TEST");
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain("[LIFECYCLE]");
	});

	it("static factories return SwarmLogger instances", () => {
		expect(SwarmLogger.dht()).toBeInstanceOf(SwarmLogger);
		expect(SwarmLogger.bootstrap()).toBeInstanceOf(SwarmLogger);
		expect(SwarmLogger.ghost()).toBeInstanceOf(SwarmLogger);
		expect(SwarmLogger.tunnel()).toBeInstanceOf(SwarmLogger);
		expect(SwarmLogger.lifecycle()).toBeInstanceOf(SwarmLogger);
	});
});
