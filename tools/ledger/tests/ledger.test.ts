import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SwarmLedger } from "../src/ledger.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Use a unique temp dir per test run to avoid collisions
function makeTempDir(): string {
  const dir = join(tmpdir(), `swarm-ledger-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tempDir: string;
let ledger: SwarmLedger;

beforeEach(() => {
  tempDir = makeTempDir();
  ledger = new SwarmLedger(join(tempDir, "test-ledger.jsonl"));
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------
describe("SwarmLedger — constructor", () => {
  it("creates the ledger file if it doesn't exist", () => {
    const filePath = join(tempDir, "new.jsonl");
    const l = new SwarmLedger(filePath);
    expect(existsSync(filePath)).toBe(true);
  });

  it("creates parent directories if they don't exist", () => {
    const filePath = join(tempDir, "nested", "deep", "ledger.jsonl");
    const l = new SwarmLedger(filePath);
    expect(existsSync(filePath)).toBe(true);
  });

  it("loads existing events and bootstraps logical clock", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 3, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    ledger.append({ tool: "sim", key: "dht.announced", value: true, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "STATE" });

    // Create a new ledger from the same file
    const ledger2 = new SwarmLedger(join(tempDir, "test-ledger.jsonl"));
    const event = ledger2.append({ tool: "ghost", key: "ghost.count", value: 0, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    expect(event.logical_time).toBe(3); // continues from 2
  });
});

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------
describe("SwarmLedger — append", () => {
  it("assigns id and logical_time", () => {
    const event = ledger.append({
      tool: "sim",
      key: "dht.peer.count",
      value: 5,
      timestamp: Date.now(),
      run_id: "r1",
      confidence: 1.0,
      type: "FACT",
    });
    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe("string");
    expect(event.logical_time).toBe(1);
  });

  it("monotonically increases logical_time", () => {
    const e1 = ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const e2 = ledger.append({ tool: "sim", key: "dht.announced", value: true, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "STATE" });
    const e3 = ledger.append({ tool: "ghost", key: "ghost.count", value: 0, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    expect(e1.logical_time).toBe(1);
    expect(e2.logical_time).toBe(2);
    expect(e3.logical_time).toBe(3);
  });

  it("normalizes keys to canonical form", () => {
    const event = ledger.append({
      tool: "sim",
      key: "dht_peer_count", // underscores → dots
      value: 5,
      timestamp: Date.now(),
      run_id: "r1",
      confidence: 1,
      type: "FACT",
    });
    expect(event.key).toBe("dht.peer.count");
  });

  it("throws for invalid keys", () => {
    expect(() =>
      ledger.append({
        tool: "sim",
        key: "totally.invalid.key",
        value: 5,
        timestamp: Date.now(),
        run_id: "r1",
        confidence: 1,
        type: "FACT",
      })
    ).toThrow(/not in the canonical registry/);
  });

  it("preserves all provided fields", () => {
    const event = ledger.append({
      tool: "ghost",
      key: "ghost.count",
      value: 3,
      timestamp: 12345,
      run_id: "my-run",
      confidence: 0.9,
      type: "OBSERVATION",
      node_id: "peer-1",
      meta: { alive: 5 },
    });
    expect(event.tool).toBe("ghost");
    expect(event.value).toBe(3);
    expect(event.timestamp).toBe(12345);
    expect(event.run_id).toBe("my-run");
    expect(event.confidence).toBe(0.9);
    expect(event.type).toBe("OBSERVATION");
    expect(event.node_id).toBe("peer-1");
    expect(event.meta?.alive).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// correct
// ---------------------------------------------------------------------------
describe("SwarmLedger — correct", () => {
  it("creates a correction event referencing the target", () => {
    const original = ledger.append({
      tool: "sim",
      key: "dht.peer.count",
      value: 5,
      timestamp: Date.now(),
      run_id: "r1",
      confidence: 1,
      type: "FACT",
    });

    const correction = ledger.correct(original.id, 10, {
      tool: "correction-agent",
      run_id: "r1",
    });
    expect(correction.type).toBe("CORRECTION");
    expect(correction.key).toBe("correction");
    expect(correction.value).toBe(10);
    expect(correction.parent_id).toBe(original.id);
    expect(correction.meta?.target_event_id).toBe(original.id);
    expect(correction.confidence).toBe(1.0);
  });

  it("respects custom confidence", () => {
    const original = ledger.append({
      tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(),
      run_id: "r1", confidence: 1, type: "FACT",
    });
    const correction = ledger.correct(original.id, 2, {
      tool: "agent", run_id: "r1", confidence: 0.5,
    });
    expect(correction.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// loadAll
// ---------------------------------------------------------------------------
describe("SwarmLedger — loadAll", () => {
  it("returns empty array for empty ledger", () => {
    expect(ledger.loadAll()).toEqual([]);
  });

  it("returns all appended events", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    ledger.append({ tool: "ghost", key: "ghost.count", value: 0, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const events = ledger.loadAll();
    expect(events.length).toBe(2);
  });

  it("caches results (same reference on second call)", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const a = ledger.loadAll();
    const b = ledger.loadAll();
    expect(a).toBe(b);
  });

  it("invalidates cache after append", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const a = ledger.loadAll();
    ledger.append({ tool: "ghost", key: "ghost.count", value: 0, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const b = ledger.loadAll();
    expect(a).not.toBe(b);
    expect(b.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------
describe("SwarmLedger — filter", () => {
  it("returns events matching predicate", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 3, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    ledger.append({ tool: "ghost", key: "ghost.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "OBSERVATION" });
    ledger.append({ tool: "sim", key: "dht.announced", value: true, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "STATE" });

    const simEvents = ledger.filter((e) => e.tool === "sim");
    expect(simEvents.length).toBe(2);
  });

  it("returns empty when nothing matches", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 3, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    expect(ledger.filter((e) => e.tool === "nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------
describe("SwarmLedger — getById", () => {
  it("returns the event with matching id", () => {
    const appended = ledger.append({ tool: "sim", key: "dht.peer.count", value: 3, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const found = ledger.getById(appended.id);
    expect(found).toBeDefined();
    expect(found!.value).toBe(3);
  });

  it("returns undefined for unknown id", () => {
    expect(ledger.getById("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getLatestByKey
// ---------------------------------------------------------------------------
describe("SwarmLedger — getLatestByKey", () => {
  it("returns the latest event for a key by logical_time", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 5, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    const latest = ledger.getLatestByKey("dht.peer.count");
    expect(latest!.value).toBe(5);
  });

  it("returns undefined for non-existent key", () => {
    expect(ledger.getLatestByKey("dht.peer.count")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
describe("SwarmLedger — stats", () => {
  it("returns empty stats for empty ledger", () => {
    const s = ledger.stats();
    expect(s.count).toBe(0);
    expect(s.tools.size).toBe(0);
    expect(s.keys.size).toBe(0);
    expect(s.timeRange).toBeNull();
  });

  it("returns correct counts after appending", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: 1000, run_id: "r1", confidence: 1, type: "FACT" });
    ledger.append({ tool: "ghost", key: "ghost.count", value: 0, timestamp: 2000, run_id: "r1", confidence: 1, type: "FACT" });
    ledger.append({ tool: "sim", key: "dht.announced", value: true, timestamp: 3000, run_id: "r1", confidence: 1, type: "STATE" });

    const s = ledger.stats();
    expect(s.count).toBe(3);
    expect(s.tools).toContain("sim");
    expect(s.tools).toContain("ghost");
    expect(s.keys).toContain("dht.peer.count");
    expect(s.keys).toContain("ghost.count");
    expect(s.timeRange).toEqual({ min: 1000, max: 3000 });
  });
});

// ---------------------------------------------------------------------------
// validateEvents
// ---------------------------------------------------------------------------
describe("SwarmLedger — validateEvents", () => {
  it("returns no violations for valid events", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    expect(ledger.validateEvents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _reset
// ---------------------------------------------------------------------------
describe("SwarmLedger — _reset", () => {
  it("clears the ledger and resets clock", () => {
    ledger.append({ tool: "sim", key: "dht.peer.count", value: 1, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    ledger._reset();
    expect(ledger.loadAll()).toEqual([]);

    const event = ledger.append({ tool: "sim", key: "dht.peer.count", value: 2, timestamp: Date.now(), run_id: "r1", confidence: 1, type: "FACT" });
    expect(event.logical_time).toBe(1); // clock reset to 0, then ++1
  });
});
