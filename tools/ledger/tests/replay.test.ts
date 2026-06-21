import { describe, it, expect, beforeEach } from "vitest";
import { replay, replayAt, replaySummary } from "../src/replay.js";
import { makeTestEvent, resetClock } from "./helpers.js";

beforeEach(() => resetClock());

const baseEvents = () => [
  makeTestEvent({ key: "dht.peer.count", tool: "sim", run_id: "r1", logical_time: 1, timestamp: 1000 }),
  makeTestEvent({ key: "ghost.count", tool: "ghost", run_id: "r1", logical_time: 2, timestamp: 2000, node_id: "n1" }),
  makeTestEvent({ key: "tunnel.status", tool: "tunnel", run_id: "r2", logical_time: 3, timestamp: 3000 }),
  makeTestEvent({ key: "dht.peer.count", tool: "bootstrap", run_id: "r1", logical_time: 4, timestamp: 4000 }),
];

// ---------------------------------------------------------------------------
// replay — no filter
// ---------------------------------------------------------------------------
describe("replay", () => {
  it("returns all events in causal order when no filter", () => {
    const result = replay(baseEvents());
    expect(result.events.length).toBe(4);
    expect(result.events[0].logical_time).toBe(1);
    expect(result.events[3].logical_time).toBe(4);
  });

  it("returns empty for empty input", () => {
    const result = replay([]);
    expect(result.events.length).toBe(0);
  });

  it("sorts events even if input is out of order", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", logical_time: 5 }),
      makeTestEvent({ key: "ghost.count", tool: "ghost", logical_time: 1 }),
    ];
    const result = replay(events);
    expect(result.events[0].logical_time).toBe(1);
    expect(result.events[1].logical_time).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// replay — filters
// ---------------------------------------------------------------------------
describe("replay — tool filter", () => {
  it("filters by tool name", () => {
    const result = replay(baseEvents(), { tool: "sim" });
    expect(result.events.length).toBe(1);
    expect(result.events[0].tool).toBe("sim");
  });

  it("returns empty when no events match tool", () => {
    const result = replay(baseEvents(), { tool: "nonexistent" });
    expect(result.events.length).toBe(0);
  });
});

describe("replay — node_id filter", () => {
  it("filters by node_id", () => {
    const result = replay(baseEvents(), { node_id: "n1" });
    expect(result.events.length).toBe(1);
    expect(result.events[0].node_id).toBe("n1");
  });

  it("returns empty when no events match node_id", () => {
    const result = replay(baseEvents(), { node_id: "unknown" });
    expect(result.events.length).toBe(0);
  });
});

describe("replay — run_id filter", () => {
  it("filters by run_id", () => {
    const result = replay(baseEvents(), { run_id: "r2" });
    expect(result.events.length).toBe(1);
    expect(result.events[0].run_id).toBe("r2");
  });
});

describe("replay — logical time range", () => {
  it("since_logical includes events at that time", () => {
    const result = replay(baseEvents(), { since_logical: 3 });
    expect(result.events.length).toBe(2);
    expect(result.events[0].logical_time).toBe(3);
  });

  it("until_logical includes events at that time", () => {
    const result = replay(baseEvents(), { until_logical: 2 });
    expect(result.events.length).toBe(2);
    expect(result.events[1].logical_time).toBe(2);
  });

  it("both since and until create a window", () => {
    const result = replay(baseEvents(), { since_logical: 2, until_logical: 3 });
    expect(result.events.length).toBe(2);
  });

  it("returns empty when window excludes all events", () => {
    const result = replay(baseEvents(), { since_logical: 100 });
    expect(result.events.length).toBe(0);
  });
});

describe("replay — timestamp range", () => {
  it("since_timestamp filters correctly", () => {
    const result = replay(baseEvents(), { since_timestamp: 2500 });
    expect(result.events.length).toBe(2); // timestamps 3000 and 4000
  });

  it("until_timestamp filters correctly", () => {
    const result = replay(baseEvents(), { until_timestamp: 2500 });
    expect(result.events.length).toBe(2); // timestamps 1000 and 2000
  });
});

describe("replay — key_prefix filter", () => {
  it("filters by key prefix", () => {
    const result = replay(baseEvents(), { key_prefix: "dht." });
    expect(result.events.length).toBe(2);
    for (const e of result.events) {
      expect(e.key.startsWith("dht.")).toBe(true);
    }
  });

  it("returns empty when no keys match prefix", () => {
    const result = replay(baseEvents(), { key_prefix: "nonexistent." });
    expect(result.events.length).toBe(0);
  });
});

describe("replay — combined filters", () => {
  it("applies multiple filters as AND", () => {
    const result = replay(baseEvents(), { tool: "sim", run_id: "r1" });
    expect(result.events.length).toBe(1);
    expect(result.events[0].tool).toBe("sim");
    expect(result.events[0].run_id).toBe("r1");
  });

  it("returns empty when filters conflict", () => {
    const result = replay(baseEvents(), { tool: "sim", run_id: "r2" });
    expect(result.events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replay — fingerprint check
// ---------------------------------------------------------------------------
describe("replay — fingerprint_check", () => {
  it("no warning when no fingerprint event exists", () => {
    const result = replay(baseEvents(), { fingerprint_check: true });
    expect(result.fingerprint_warning).toBeUndefined();
  });

  it("no warning when fingerprint event has no meta.env", () => {
    const events = [
      makeTestEvent({ key: "env.fingerprint", tool: "system", meta: {} }),
    ];
    const result = replay(events, { fingerprint_check: true });
    expect(result.fingerprint_warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// replayAt
// ---------------------------------------------------------------------------
describe("replayAt", () => {
  it("returns events up to and including the given logical time", () => {
    const result = replayAt(baseEvents(), 3);
    expect(result.length).toBe(3);
    expect(result[2].logical_time).toBe(3);
  });

  it("returns all events when time is beyond max", () => {
    const result = replayAt(baseEvents(), 100);
    expect(result.length).toBe(4);
  });

  it("returns empty when time is before all events", () => {
    const result = replayAt(baseEvents(), 0);
    expect(result.length).toBe(0);
  });

  it("results are sorted by logical_time", () => {
    const events = [
      makeTestEvent({ key: "dht.peer.count", tool: "sim", logical_time: 5 }),
      makeTestEvent({ key: "ghost.count", tool: "ghost", logical_time: 2 }),
    ];
    const result = replayAt(events, 10);
    expect(result[0].logical_time).toBe(2);
    expect(result[1].logical_time).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// replaySummary
// ---------------------------------------------------------------------------
describe("replaySummary", () => {
  it("returns no-events message for empty input", () => {
    expect(replaySummary([])).toBe("No events in replay window.");
  });

  it("includes event count", () => {
    const text = replaySummary(baseEvents());
    expect(text).toContain("4 events");
  });

  it("includes logical time range", () => {
    const text = replaySummary(baseEvents());
    expect(text).toContain("1");
    expect(text).toContain("4");
  });

  it("includes tool names", () => {
    const text = replaySummary(baseEvents());
    expect(text).toContain("sim");
    expect(text).toContain("ghost");
    expect(text).toContain("tunnel");
    expect(text).toContain("bootstrap");
  });

  it("includes key names", () => {
    const text = replaySummary(baseEvents());
    expect(text).toContain("dht.peer.count");
    expect(text).toContain("ghost.count");
  });

  it("works with single event", () => {
    const events = [makeTestEvent({ key: "dht.peer.count", tool: "sim", logical_time: 1, timestamp: 1000 })];
    const text = replaySummary(events);
    expect(text).toContain("1 events");
    expect(text).toContain("sim");
  });
});
