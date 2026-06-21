/**
 * Test helpers — factory functions for SwarmEvent fixtures.
 */
import type { SwarmEvent } from "../src/types.js";

let _clock = 0;

export function resetClock() {
  _clock = 0;
}

export function makeTestEvent(
  overrides: Partial<SwarmEvent> & { key: string; tool: string }
): SwarmEvent {
  _clock++;
  return {
    id: overrides.id ?? `evt-${_clock}`,
    timestamp: overrides.timestamp ?? Date.now(),
    logical_time: overrides.logical_time ?? _clock,
    run_id: overrides.run_id ?? "test-run",
    key: overrides.key,
    value: overrides.value ?? null,
    confidence: overrides.confidence ?? 1.0,
    type: overrides.type ?? "FACT",
    tool: overrides.tool,
    node_id: overrides.node_id,
    parent_id: overrides.parent_id,
    meta: overrides.meta,
  };
}
