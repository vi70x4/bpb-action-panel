import { describe, it, expect } from "vitest";
import {
  normalizeKey,
  isValidKey,
  keysForDomain,
  CANONICAL_KEYS,
  captureFingerprint,
  compareFingerprints,
} from "../src/schema.js";
import type { EnvFingerprint } from "../src/schema.js";

// ---------------------------------------------------------------------------
// normalizeKey — happy paths
// ---------------------------------------------------------------------------
describe("normalizeKey", () => {
  it("accepts exact canonical keys as-is", () => {
    expect(normalizeKey("dht.peer.count")).toBe("dht.peer.count");
    expect(normalizeKey("ghost.count")).toBe("ghost.count");
    expect(normalizeKey("tunnel.status")).toBe("tunnel.status");
    expect(normalizeKey("env.fingerprint")).toBe("env.fingerprint");
    expect(normalizeKey("correction")).toBe("correction");
  });

  it("normalizes hyphens to dots", () => {
    expect(normalizeKey("dht-peer-count")).toBe("dht.peer.count");
    expect(normalizeKey("ghost-count")).toBe("ghost.count");
    expect(normalizeKey("tunnel-status")).toBe("tunnel.status");
  });

  it("normalizes underscores to dots", () => {
    expect(normalizeKey("dht_peer_count")).toBe("dht.peer.count");
    expect(normalizeKey("ghost_count")).toBe("ghost.count");
    expect(normalizeKey("keyspace_vless_count")).toBe("keyspace.vless.count");
  });

  it("normalizes camelCase to dot-separated", () => {
    expect(normalizeKey("dhtPeerCount")).toBe("dht.peer.count");
    expect(normalizeKey("ghostCount")).toBe("ghost.count");
  });

  it("lowercases everything", () => {
    expect(normalizeKey("DHT.PEER.COUNT")).toBe("dht.peer.count");
    expect(normalizeKey("GHOST.COUNT")).toBe("ghost.count");
  });

  it("accepts qualified sub-keys under known prefixes", () => {
    // dht.peer.count.bootstrap is a canonical key
    expect(normalizeKey("dht.peer.count.bootstrap")).toBe("dht.peer.count.bootstrap");
    expect(normalizeKey("dht.peer.count.sim")).toBe("dht.peer.count.sim");
  });

  it("accepts non-canonical sub-keys under known domain prefixes", () => {
    // Sub-keys under known prefixes are allowed for extensibility
    expect(normalizeKey("dht.peer.count.custom_tool")).toBe("dht.peer.count.custom.tool");
    expect(normalizeKey("keyspace.vless.count.extra")).toBe("keyspace.vless.count.extra");
  });

  // Edge cases
  it("throws for completely unknown keys", () => {
    expect(() => normalizeKey("random.garbage")).toThrow(/not in the canonical registry/);
    expect(() => normalizeKey("foo")).toThrow(/not in the canonical registry/);
    expect(() => normalizeKey("x.y.z")).toThrow(/not in the canonical registry/);
  });

  it("throws for empty string", () => {
    expect(() => normalizeKey("")).toThrow();
  });

  it("normalizes mixed separators correctly", () => {
    // hyphens + underscores + dots all become dots
    expect(normalizeKey("dht-peer_count")).toBe("dht.peer.count");
    expect(normalizeKey("tunnel-status_provider")).toBe("tunnel.status.provider");
  });

  it("error message includes the raw key and valid keys list", () => {
    try {
      normalizeKey("badkey");
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("badkey");
      expect(err.message).toContain("dht.peer.count");
    }
  });
});

// ---------------------------------------------------------------------------
// isValidKey
// ---------------------------------------------------------------------------
describe("isValidKey", () => {
  it("returns true for all canonical keys", () => {
    for (const key of CANONICAL_KEYS) {
      expect(isValidKey(key)).toBe(true);
    }
  });

  it("returns true for normalizable variants", () => {
    expect(isValidKey("dht-peer-count")).toBe(true);
    expect(isValidKey("DHT_PEER_COUNT")).toBe(true);
    expect(isValidKey("dhtPeerCount")).toBe(true);
  });

  it("returns false for unknown keys", () => {
    expect(isValidKey("nope")).toBe(false);
    expect(isValidKey("x.y.z")).toBe(false);
    expect(isValidKey("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// keysForDomain
// ---------------------------------------------------------------------------
describe("keysForDomain", () => {
  it("returns all DHT domain keys", () => {
    const keys = keysForDomain("dht");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.startsWith("dht.")).toBe(true);
    }
  });

  it("returns all tunnel domain keys", () => {
    const keys = keysForDomain("tunnel");
    expect(keys).toContain("tunnel.status");
    expect(keys).toContain("tunnel.provider");
    expect(keys).toContain("tunnel.host");
    expect(keys).toContain("tunnel.port");
  });

  it("returns empty array for unknown domain", () => {
    expect(keysForDomain("nonexistent")).toEqual([]);
  });

  it("matches bare domain keys (e.g., 'correction')", () => {
    const keys = keysForDomain("correction");
    expect(keys).toContain("correction");
  });
});

// ---------------------------------------------------------------------------
// CANONICAL_KEYS registry
// ---------------------------------------------------------------------------
describe("CANONICAL_KEYS", () => {
  it("has no duplicate keys", () => {
    const set = new Set(CANONICAL_KEYS);
    expect(set.size).toBe(CANONICAL_KEYS.length);
  });

  it("all keys are dot-delimited (no underscores)", () => {
    for (const key of CANONICAL_KEYS) {
      expect(key).not.toContain("_");
    }
  });

  it("all keys are lowercase", () => {
    for (const key of CANONICAL_KEYS) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("all keys are valid via isValidKey", () => {
    for (const key of CANONICAL_KEYS) {
      expect(isValidKey(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// captureFingerprint
// ---------------------------------------------------------------------------
describe("captureFingerprint", () => {
  it("returns a fingerprint with all required fields", () => {
    const fp = captureFingerprint("run-123");
    expect(fp.run_id).toBe("run-123");
    expect(fp.node_version).toBe(process.version);
    expect(fp.platform).toBe(process.platform);
    expect(fp.arch).toBe(process.arch);
    expect(typeof fp.ci).toBe("boolean");
    expect(typeof fp.timestamp).toBe("number");
    expect(fp.seed).toBeUndefined();
  });

  it("includes seed when provided", () => {
    const fp = captureFingerprint("run-456", "my-seed");
    expect(fp.seed).toBe("my-seed");
  });

  it("timestamps are close to Date.now()", () => {
    const before = Date.now();
    const fp = captureFingerprint("run-789");
    const after = Date.now();
    expect(fp.timestamp).toBeGreaterThanOrEqual(before);
    expect(fp.timestamp).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// compareFingerprints
// ---------------------------------------------------------------------------
describe("compareFingerprints", () => {
  const baseFP: EnvFingerprint = {
    node_version: "v20.0.0",
    platform: "linux",
    arch: "x64",
    ci: true,
    run_id: "run-1",
    timestamp: 1000,
  };

  it("returns null for identical fingerprints", () => {
    const result = compareFingerprints(baseFP, { ...baseFP });
    expect(result).toBeNull();
  });

  it("detects node_version mismatch", () => {
    const other = { ...baseFP, node_version: "v18.0.0" };
    const result = compareFingerprints(baseFP, other);
    expect(result).not.toBeNull();
    expect(result).toContain("node");
  });

  it("detects platform mismatch", () => {
    const other = { ...baseFP, platform: "darwin" };
    const result = compareFingerprints(baseFP, other);
    expect(result).toContain("platform");
  });

  it("detects arch mismatch", () => {
    const other = { ...baseFP, arch: "arm64" };
    const result = compareFingerprints(baseFP, other);
    expect(result).toContain("arch");
  });

  it("reports multiple mismatches at once", () => {
    const other = { ...baseFP, node_version: "v18.0.0", platform: "win32", arch: "arm64" };
    const result = compareFingerprints(baseFP, other);
    expect(result).toContain("node");
    expect(result).toContain("platform");
    expect(result).toContain("arch");
  });

  it("ignores differences in ci, run_id, timestamp, seed", () => {
    const other: EnvFingerprint = {
      ...baseFP,
      ci: false,
      run_id: "different-run",
      timestamp: 99999,
      seed: "some-seed",
    };
    expect(compareFingerprints(baseFP, other)).toBeNull();
  });
});
