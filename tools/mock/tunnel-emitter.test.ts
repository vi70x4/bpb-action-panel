import { describe, expect, it } from "vitest";
import {
	generateEndpoint,
	isoNow,
	parseArgs,
	randomHex,
	randomIp,
	randomLatency,
	randomPort,
	randomWord,
	type TunnelProvider,
	validateProvider,
	WORDS,
} from "./tunnel-emitter.ts";

// ---------------------------------------------------------------------------
// generateEndpoint
// ---------------------------------------------------------------------------

describe("generateEndpoint", () => {
	it("trycloudflare: host ends with .trycloudflare.com, port 443, url starts with https://", () => {
		const ep = generateEndpoint("trycloudflare");
		expect(ep.host).toMatch(/\.trycloudflare\.com$/);
		expect(ep.port).toBe(443);
		expect(ep.url).toBe(`https://${ep.host}`);
	});

	it("trycloudflare with hostOverride uses override", () => {
		const ep = generateEndpoint(
			"trycloudflare",
			"custom.trycloudflare.com",
			8443,
		);
		expect(ep.host).toBe("custom.trycloudflare.com");
		expect(ep.port).toBe(8443);
		expect(ep.url).toBe("https://custom.trycloudflare.com");
	});

	it("trycloudflare with portOverride uses override", () => {
		const ep = generateEndpoint("trycloudflare", undefined, 8443);
		expect(ep.port).toBe(8443);
	});

	it("pinggy: host a.pinggy.io, random port, url format host:port", () => {
		const ep = generateEndpoint("pinggy");
		expect(ep.host).toBe("a.pinggy.io");
		expect(ep.port).toBeGreaterThanOrEqual(10_000);
		expect(ep.port).toBeLessThan(65_000);
		expect(ep.url).toBe(`a.pinggy.io:${ep.port}`);
	});

	it("pinggy with overrides uses provided host and port", () => {
		const ep = generateEndpoint("pinggy", "custom.pinggy.io", 9090);
		expect(ep.host).toBe("custom.pinggy.io");
		expect(ep.port).toBe(9090);
		expect(ep.url).toBe("custom.pinggy.io:9090");
	});

	it("direct: random IP, random port, url format host:port", () => {
		const ep = generateEndpoint("direct");
		expect(ep.host).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
		expect(ep.port).toBeGreaterThanOrEqual(10_000);
		expect(ep.url).toBe(`${ep.host}:${ep.port}`);
	});

	it("direct with overrides uses provided host and port", () => {
		const ep = generateEndpoint("direct", "10.0.0.1", 2222);
		expect(ep.host).toBe("10.0.0.1");
		expect(ep.port).toBe(2222);
	});
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	it("empty argv → empty object", () => {
		expect(parseArgs(["node", "script.ts"])).toEqual({});
	});

	it("--provider trycloudflare → { provider: 'trycloudflare' }", () => {
		expect(
			parseArgs(["node", "script.ts", "--provider", "trycloudflare"]),
		).toEqual({
			provider: "trycloudflare",
		});
	});

	it("--provider trycloudflare --port 8080 → both", () => {
		expect(
			parseArgs([
				"node",
				"script.ts",
				"--provider",
				"trycloudflare",
				"--port",
				"8080",
			]),
		).toEqual({
			provider: "trycloudflare",
			port: "8080",
		});
	});

	it("--verbose (no value) → { verbose: 'true' }", () => {
		expect(parseArgs(["node", "script.ts", "--verbose"])).toEqual({
			verbose: "true",
		});
	});

	it("mixed flags and key-value pairs parse correctly", () => {
		const result = parseArgs([
			"node",
			"script.ts",
			"--key",
			"value1",
			"--flag",
			"--key2",
			"value2",
		]);
		expect(result).toEqual({
			key: "value1",
			flag: "true",
			key2: "value2",
		});
	});
});

// ---------------------------------------------------------------------------
// validateProvider
// ---------------------------------------------------------------------------

describe("validateProvider", () => {
	it('"trycloudflare" → "trycloudflare"', () => {
		expect(validateProvider("trycloudflare")).toBe("trycloudflare");
	});

	it('"pinggy" → "pinggy"', () => {
		expect(validateProvider("pinggy")).toBe("pinggy");
	});

	it('"direct" → "direct"', () => {
		expect(validateProvider("direct")).toBe("direct");
	});

	it('"invalid" → throws', () => {
		expect(() => validateProvider("invalid")).toThrow(/--provider must be/);
	});

	it("undefined → throws with '(missing)'", () => {
		expect(() => validateProvider(undefined)).toThrow(/\(missing\)/);
	});
});

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

describe("randomWord", () => {
	it("returns a string from WORDS array, non-empty", () => {
		const word = randomWord();
		expect(typeof word).toBe("string");
		expect(word.length).toBeGreaterThan(0);
		expect(WORDS).toContain(word);
	});
});

describe("randomHex", () => {
	it("returns n hex chars", () => {
		const hex = randomHex(8);
		expect(hex).toHaveLength(8);
		expect(hex).toMatch(/^[0-9a-f]+$/);
	});

	it("returns different lengths for different n", () => {
		expect(randomHex(4)).toHaveLength(4);
		expect(randomHex(16)).toHaveLength(16);
	});
});

describe("randomPort", () => {
	it("returns number in valid port range (10000-64999)", () => {
		const port = randomPort();
		expect(port).toBeGreaterThanOrEqual(10_000);
		expect(port).toBeLessThanOrEqual(64_999);
		expect(Number.isInteger(port)).toBe(true);
	});
});

describe("randomIp", () => {
	it("returns dotted quad format with 4 octets 1-254", () => {
		const ip = randomIp();
		const octets = ip.split(".");
		expect(octets).toHaveLength(4);
		for (const octet of octets) {
			const n = Number(octet);
			expect(n).toBeGreaterThanOrEqual(1);
			expect(n).toBeLessThanOrEqual(254);
		}
	});
});

describe("randomLatency", () => {
	it("returns a positive number in expected range", () => {
		const lat = randomLatency();
		expect(lat).toBeGreaterThan(0);
		expect(lat).toBeGreaterThanOrEqual(2000);
		expect(lat).toBeLessThanOrEqual(5999);
	});
});

describe("isoNow", () => {
	it("returns a valid ISO date string", () => {
		const iso = isoNow();
		expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(new Date(iso).toISOString()).toBe(iso);
	});
});
