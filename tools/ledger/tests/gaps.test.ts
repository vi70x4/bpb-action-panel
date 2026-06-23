// ---------------------------------------------------------------------------
// Ledger gap coverage — targeted tests for uncovered lines
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectContradictions } from "../src/contradictions.js";
import { SwarmLedger } from "../src/ledger.js";
import { getTunnelState } from "../src/projections.js";
import type { SwarmEvent } from "../src/types.js";
import { makeTestEvent, resetClock } from "./helpers.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeTempLedger(): { ledger: SwarmLedger; dir: string } {
	const dir = join(tmpdir(), `ledger-gap-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	const ledger = new SwarmLedger(join(dir, "test.jsonl"));
	return { ledger, dir };
}

// ---------------------------------------------------------------------------
// ledger.ts — validateEvents with invalid keys
// ---------------------------------------------------------------------------

describe("SwarmLedger — validateEvents", () => {
	let ledger: SwarmLedger;
	let dir: string;

	beforeEach(() => {
		resetClock();
		const result = makeTempLedger();
		ledger = result.ledger;
		dir = result.dir;
	});

	afterEach(() => {
		ledger._reset();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns violations for events with invalid keys", () => {
		// Append a valid event first so the file is in a clean state
		ledger.append({
			tool: "test",
			key: "dht.peer.count",
			value: 5,
			type: "FACT",
			timestamp: Date.now(),
			run_id: "test-run",
		});

		// Directly inject an event with an invalid key into the JSONL file
		// (bypassing normalizeKey to simulate corrupted/external data)
		const badEvent: SwarmEvent = {
			id: "bad-event-001",
			timestamp: Date.now(),
			logical_time: 999,
			run_id: "test-run",
			key: "totally.invalid.key.that.is.not.canonical",
			value: "bad",
			confidence: 1.0,
			type: "FACT",
			tool: "test",
		};
		appendFileSync(join(dir, "test.jsonl"), JSON.stringify(badEvent) + "\n");

		// Create a new ledger instance to pick up the file contents
		const ledger2 = new SwarmLedger(join(dir, "test.jsonl"));
		const violations = ledger2.validateEvents();

		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]?.key).toBe(
			"totally.invalid.key.that.is.not.canonical",
		);
	});

	it("returns empty array when all keys are valid", () => {
		ledger.append({
			tool: "test",
			key: "dht.peer.count",
			value: 5,
			type: "FACT",
			timestamp: Date.now(),
			run_id: "test-run",
		});
		ledger.append({
			tool: "test",
			key: "node.status",
			value: "online",
			type: "FACT",
			timestamp: Date.now(),
			run_id: "test-run",
		});

		const violations = ledger.validateEvents();
		expect(violations).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// projections.ts — tunnel object host/port (lines 216-217)
// ---------------------------------------------------------------------------

describe("getTunnelState — object value host/port", () => {
	beforeEach(() => {
		resetClock();
	});

	it("extracts host from object value", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "tunnel.status",
				tool: "test",
				value: { status: "ready", host: "abc.trycloudflare.com" },
			}),
		];

		const state = getTunnelState(events);
		expect(state.host).toBe("abc.trycloudflare.com");
	});

	it("extracts port from object value", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "tunnel.status",
				tool: "test",
				value: { status: "ready", port: 8443 },
			}),
		];

		const state = getTunnelState(events);
		expect(state.port).toBe(8443);
	});

	it("extracts both host and port from object value", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "tunnel.status",
				tool: "test",
				value: {
					status: "ready",
					provider: "trycloudflare",
					host: "abc.trycloudflare.com",
					port: 443,
				},
			}),
		];

		const state = getTunnelState(events);
		expect(state.host).toBe("abc.trycloudflare.com");
		expect(state.port).toBe(443);
		expect(state.provider).toBe("trycloudflare");
		expect(state.status).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// contradictions.ts — node-liveness-consistency (lines 141-153)
// ---------------------------------------------------------------------------

describe("detectContradictions — node-liveness-consistency", () => {
	beforeEach(() => {
		resetClock();
	});

	it("no contradiction when both tools agree (both online)", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "node.status",
				tool: "ghost",
				value: "online",
				node_id: "node-abc",
			}),
			makeTestEvent({
				key: "node.status",
				tool: "sim",
				value: "online",
				node_id: "node-abc",
			}),
		];

		const report = detectContradictions(events);
		const liveness = report.contradictions.find(
			(c) => c.rule === "node-liveness-consistency",
		);
		expect(liveness).toBeUndefined();
	});

	it("no contradiction when node IDs differ", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "node.status",
				tool: "ghost",
				value: "offline",
				node_id: "node-abc",
			}),
			makeTestEvent({
				key: "node.status",
				tool: "sim",
				value: "online",
				node_id: "node-xyz",
			}),
		];

		const report = detectContradictions(events);
		const liveness = report.contradictions.find(
			(c) => c.rule === "node-liveness-consistency",
		);
		expect(liveness).toBeUndefined();
	});

	it("no contradiction when ghost and sim use different keys", () => {
		// The node-liveness-consistency invariant only checks key === "node.status"
		// for both ghost and sim. If they use different keys, no contradiction.
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "ghost.node.status",
				tool: "ghost",
				value: "offline",
				node_id: "node-abc",
			}),
			makeTestEvent({
				key: "sim.node.status",
				tool: "sim",
				value: "online",
				node_id: "node-abc",
			}),
		];

		const report = detectContradictions(events);
		const liveness = report.contradictions.find(
			(c) => c.rule === "node-liveness-consistency",
		);
		expect(liveness).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// contradictions.ts — tunnel-vs-announce consistency (extra coverage)
// ---------------------------------------------------------------------------

describe("detectContradictions — tunnel-vs-announce", () => {
	beforeEach(() => {
		resetClock();
	});

	it("detects HARD contradiction when tunnel failed but node announced", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "tunnel.status",
				tool: "tunnel-monitor",
				value: "failed",
			}),
			makeTestEvent({
				key: "dht.announced",
				tool: "bootstrap",
				value: true,
			}),
		];

		const report = detectContradictions(events);
		expect(report.consistent).toBe(false);
		expect(report.hard_count).toBeGreaterThan(0);
		const tunnelContradiction = report.contradictions.find(
			(c) => c.rule === "tunnel-vs-announce-consistency",
		);
		expect(tunnelContradiction).toBeDefined();
		expect(tunnelContradiction?.message).toContain("tunnel failed");
	});

	it("no contradiction when tunnel ready and announced", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "tunnel.status",
				tool: "tunnel-monitor",
				value: "ready",
			}),
			makeTestEvent({
				key: "dht.announced",
				tool: "bootstrap",
				value: true,
			}),
		];

		const report = detectContradictions(events);
		const tunnelContradiction = report.contradictions.find(
			(c) => c.rule === "tunnel-vs-announce-consistency",
		);
		expect(tunnelContradiction).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// contradictions.ts — keyspace-orphan consistency
// ---------------------------------------------------------------------------

describe("detectContradictions — keyspace-orphan-consistency", () => {
	beforeEach(() => {
		resetClock();
	});

	it("detects DRIFT when orphans exist but bootstrap claims clean state", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "keyspace.orphan.keys",
				tool: "keyspace-scanner",
				value: 3,
			}),
			makeTestEvent({
				key: "dht.state.clean",
				tool: "bootstrap",
				value: true,
			}),
		];

		const report = detectContradictions(events);
		expect(report.drift_count).toBeGreaterThan(0);
		const orphanContradiction = report.contradictions.find(
			(c) => c.rule === "keyspace-orphan-consistency",
		);
		expect(orphanContradiction).toBeDefined();
	});

	it("no drift when no orphans", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "keyspace.orphan.keys",
				tool: "keyspace-scanner",
				value: 0,
			}),
			makeTestEvent({
				key: "dht.state.clean",
				tool: "bootstrap",
				value: true,
			}),
		];

		const report = detectContradictions(events);
		const orphanContradiction = report.contradictions.find(
			(c) => c.rule === "keyspace-orphan-consistency",
		);
		expect(orphanContradiction).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// contradictions.ts — ghost-density
// ---------------------------------------------------------------------------

describe("detectContradictions — ghost-density", () => {
	beforeEach(() => {
		resetClock();
	});

	it("detects SOFT contradiction when ghost ratio exceeds threshold", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "ghost.count",
				tool: "ghost-detector",
				value: 8,
			}),
			makeTestEvent({
				key: "dht.peer.count",
				tool: "bootstrap",
				value: 10,
			}),
		];

		// ghost ratio = 8/10 = 0.8 > 0.5 threshold
		const report = detectContradictions(events);
		expect(report.soft_count).toBeGreaterThan(0);
		const ghostDensity = report.contradictions.find(
			(c) => c.rule === "ghost-density",
		);
		expect(ghostDensity).toBeDefined();
	});

	it("no contradiction when ghost ratio is below threshold", () => {
		const events: SwarmEvent[] = [
			makeTestEvent({
				key: "ghost.count",
				tool: "ghost-detector",
				value: 2,
			}),
			makeTestEvent({
				key: "dht.peer.count",
				tool: "bootstrap",
				value: 10,
			}),
		];

		// ghost ratio = 2/10 = 0.2 < 0.5 threshold
		const report = detectContradictions(events);
		const ghostDensity = report.contradictions.find(
			(c) => c.rule === "ghost-density",
		);
		expect(ghostDensity).toBeUndefined();
	});
});
