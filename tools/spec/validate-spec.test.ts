import { describe, expect, it } from "vitest";
import {
	type CheckResult,
	checkDHTKeyPrefix,
	checkNoSerialMultiHop,
	checkRecordFields,
	checkTombstoneFormat,
	checkTTLBounds,
	parseArgs,
} from "./validate-spec.ts";

// ---------------------------------------------------------------------------
// checkDHTKeyPrefix
// ---------------------------------------------------------------------------

describe("checkDHTKeyPrefix", () => {
	it("code with /bpb/v2/ → pass=true, detail mentions 'found in'", () => {
		const files = new Map<string, string>();
		files.set("dht.ts", 'const key = "/bpb/v2/test";');
		const result = checkDHTKeyPrefix(files);
		expect(result.pass).toBe(true);
		expect(result.detail).toContain("found in");
	});

	it("code without /bpb/v2/ → pass=false, detail mentions 'NOT found'", () => {
		const files = new Map<string, string>();
		files.set("dht.ts", "const key = '/something/else';");
		const result = checkDHTKeyPrefix(files);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("NOT found");
	});

	it("empty map → pass=false", () => {
		const files = new Map<string, string>();
		const result = checkDHTKeyPrefix(files);
		expect(result.pass).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkTombstoneFormat
// ---------------------------------------------------------------------------

describe("checkTombstoneFormat", () => {
	it("code with 'tombstone' (lowercase) → pass=true", () => {
		const files = new Map<string, string>();
		files.set("dht.ts", "const TOMBSTONE_KEY = '/bpb/v2/tombstone';");
		const result = checkTombstoneFormat(files);
		expect(result.pass).toBe(true);
	});

	it("code with 'TOMBSTONE' (uppercase) → pass=true (case-insensitive)", () => {
		const files = new Map<string, string>();
		files.set("dht.ts", "// TOMBSTONE marker");
		const result = checkTombstoneFormat(files);
		expect(result.pass).toBe(true);
	});

	it("code without tombstone → pass=false", () => {
		const files = new Map<string, string>();
		files.set("dht.ts", "// nothing relevant here");
		const result = checkTombstoneFormat(files);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("NOT found");
	});
});

// ---------------------------------------------------------------------------
// checkRecordFields
// ---------------------------------------------------------------------------

describe("checkRecordFields", () => {
	const allFields = "peerId protocol host port ttl bornAt expiresAt";

	it("all 7 fields present → pass=true, 7/7", () => {
		const files = new Map<string, string>();
		files.set("record.ts", allFields);
		const result = checkRecordFields(files);
		expect(result.pass).toBe(true);
		expect(result.detail).toContain("7/7");
	});

	it("missing one field → pass=false, detail shows count", () => {
		const code = "peerId protocol host port ttl bornAt"; // missing expiresAt
		const files = new Map<string, string>();
		files.set("record.ts", code);
		const result = checkRecordFields(files);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("6/7");
		expect(result.detail).toContain("missing");
	});

	it("all fields missing → pass=false, 0/7", () => {
		const files = new Map<string, string>();
		files.set("empty.ts", "// nothing here");
		const result = checkRecordFields(files);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("0/7");
	});
});

// ---------------------------------------------------------------------------
// checkTTLBounds
// ---------------------------------------------------------------------------

describe("checkTTLBounds", () => {
	it('code with "uniform(" → pass=true', () => {
		const files = new Map<string, string>();
		files.set("ttl.ts", "const ttl = uniform(15, 60);");
		const result = checkTTLBounds(files);
		expect(result.pass).toBe(true);
	});

	it('code with "15" and "60" in same content → pass=true', () => {
		const files = new Map<string, string>();
		files.set("ttl.ts", "const min = 15; const max = 60;");
		const result = checkTTLBounds(files);
		expect(result.pass).toBe(true);
	});

	it("code with nothing matching → pass=false", () => {
		const files = new Map<string, string>();
		files.set("empty.ts", "// nothing relevant");
		const result = checkTTLBounds(files);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("NOT found");
	});

	it("code with ttl = number → pass=true", () => {
		const files = new Map<string, string>();
		files.set("ttl.ts", "const ttl = 30;");
		const result = checkTTLBounds(files);
		expect(result.pass).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkNoSerialMultiHop
// ---------------------------------------------------------------------------

describe("checkNoSerialMultiHop", () => {
	it("code without forbidden patterns → pass=true", () => {
		const files = new Map<string, string>();
		files.set("clean.ts", "const route = 'direct';");
		const result = checkNoSerialMultiHop(files);
		expect(result.pass).toBe(true);
		expect(result.detail).toContain("no serial multi-hop pattern detected");
	});

	it('code with "route: []" → pass=false', () => {
		const files = new Map<string, string>();
		files.set("bad.ts", "route: []");
		const result = checkNoSerialMultiHop(files);
		expect(result.pass).toBe(false);
	});

	it('code with "multiHop" → pass=false', () => {
		const files = new Map<string, string>();
		files.set("bad.ts", "multiHop: true");
		const result = checkNoSerialMultiHop(files);
		expect(result.pass).toBe(false);
	});

	it('code with "multi-hop" → pass=false', () => {
		const files = new Map<string, string>();
		files.set("bad.ts", "multi-hop: enabled");
		const result = checkNoSerialMultiHop(files);
		expect(result.pass).toBe(false);
	});

	it("code with serial.*hop regex match → pass=false", () => {
		const files = new Map<string, string>();
		files.set("bad.ts", "serial hop is forbidden");
		const result = checkNoSerialMultiHop(files);
		expect(result.pass).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	it("returns defaults when no relevant args", () => {
		const result = parseArgs(["node", "validate-spec.ts"]);
		expect(result).toHaveProperty("specPath");
		expect(result).toHaveProperty("srcPath");
		expect(result.specPath).toContain("SPEC-V2-MESH.md");
		expect(result.srcPath).toContain("node/src");
	});

	it("--spec overrides specPath", () => {
		const result = parseArgs([
			"node",
			"validate-spec.ts",
			"--spec",
			"/tmp/custom-spec.md",
		]);
		expect(result.specPath).toContain("custom-spec.md");
	});

	it("--src overrides srcPath", () => {
		const result = parseArgs([
			"node",
			"validate-spec.ts",
			"--src",
			"/tmp/custom-src",
		]);
		expect(result.srcPath).toContain("custom-src");
	});

	it("both --spec and --src override their respective paths", () => {
		const result = parseArgs([
			"node",
			"validate-spec.ts",
			"--spec",
			"/tmp/spec.md",
			"--src",
			"/tmp/src",
		]);
		expect(result.specPath).toContain("spec.md");
		expect(result.srcPath).toContain("src");
	});
});
