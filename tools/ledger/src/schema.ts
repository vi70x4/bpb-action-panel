/**
 * Schema — canonical key registry + validation.
 *
 * This is the contract that prevents key fragmentation.
 * Every event key must be registered here. Adapters may only
 * emit keys from this registry. The ledger rejects unknown keys.
 *
 * Naming convention:
 *   {domain}.{measurement}[.{tool_qualifier}]
 *
 * Domains: dht, node, ghost, keyspace, tunnel, bootstrap, spec, correction
 * Separator: dot (.)
 * No hyphens, no camelCase, no underscores in domain/measurement.
 */

// ---------------------------------------------------------------------------
// Canonical key definitions
// ---------------------------------------------------------------------------

export const CANONICAL_KEYS = [
  // DHT domain
  "dht.peer.count",
  "dht.peer.count.bootstrap",
  "dht.peer.count.sim",
  "dht.active.nodes",
  "dht.orphan.keys",
  "dht.announced",
  "dht.state.clean",

  // Node domain
  "node.status",

  // Ghost domain
  "ghost.count",

  // Keyspace domain
  "keyspace.vless.count",
  "keyspace.hysteria2.count",
  "keyspace.tombstone.count",
  "keyspace.orphan.keys",

  // Tunnel domain
  "tunnel.status",
  "tunnel.provider",
  "tunnel.host",
  "tunnel.port",

  // Bootstrap domain
  "bootstrap.peer.status",

  // Spec domain
  "spec.alignment",

  // System domain
  "correction",
  "env.fingerprint",
] as const;

export type CanonicalKey = (typeof CANONICAL_KEYS)[number];

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

const KEY_SET = new Set<string>(CANONICAL_KEYS);
const KEY_PREFIXES = CANONICAL_KEYS.filter((k) => k.includes(".")).map((k) => {
  // Last segment is the measurement, everything before is the prefix
  const parts = k.split(".");
  return parts.slice(0, -1).join(".");
});
const UNIQUE_PREFIXES = [...new Set(KEY_PREFIXES)];

/**
 * Validate a key against the canonical registry.
 * Returns the normalized key if valid, or throws.
 *
 * Normalization rules:
 *   - hyphens → dots (dht-peer-count → dht.peer.count)
 *   - camelCase → snake_case (DHTPeerCount → dht.peer.count)
 *   - underscore → dot (dht_peer_count → dht.peer.count)
 *   - lowercase everything
 *
 * After normalization, the key must either:
 *   - exist in CANONICAL_KEYS exactly
 *   - or be a sub-key under a registered prefix (for future extensibility)
 */
export function normalizeKey(raw: string): string {
  let key = raw
    .toLowerCase()
    .replace(/-/g, ".")
    .replace(/_/g, ".")
    // camelCase → snake_case then dots
    .replace(/([a-z])([A-Z])/g, (_, a, b) => `${a}.${b.toLowerCase()}`);

  // Exact match
  if (KEY_SET.has(key as CanonicalKey)) return key;

  // Prefix match — allow sub-keys under known domains
  for (const prefix of UNIQUE_PREFIXES) {
    if (key.startsWith(prefix + ".")) return key;
  }

  // Unknown key — reject
  throw new Error(
    `SwarmEvent key "${raw}" (normalized: "${key}") is not in the canonical registry. ` +
    `Valid keys: ${CANONICAL_KEYS.join(", ")}. ` +
    `Extend CANONICAL_KEYS in schema.ts if this is a new measurement.`
  );
}

/**
 * Check if a key is valid without throwing.
 */
export function isValidKey(raw: string): boolean {
  try {
    normalizeKey(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all registered keys for a domain prefix.
 * E.g. keysForDomain("dht") → ["dht.peer_count", "dht.peer_count.bootstrap", ...]
 */
export function keysForDomain(domain: string): string[] {
  return CANONICAL_KEYS.filter((k) => k.startsWith(domain + ".") || k === domain);
}

// ---------------------------------------------------------------------------
// Environment fingerprint
// ---------------------------------------------------------------------------

export interface EnvFingerprint {
  node_version: string;
  platform: string;
  arch: string;
  ci: boolean;
  run_id: string;
  timestamp: number;
  seed?: string;
}

/**
 * Capture a deterministic environment fingerprint for replay binding.
 * This is attached to the first event in a run as meta.env.
 */
export function captureFingerprint(runId: string, seed?: string): EnvFingerprint {
  return {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: !!(process.env.CI || process.env.GITHUB_ACTIONS),
    run_id: runId,
    timestamp: Date.now(),
    seed,
  };
}

/**
 * Validate that two fingerprints are compatible for replay.
 * Returns null if compatible, or a description of the mismatch.
 */
export function compareFingerprints(
  recorded: EnvFingerprint,
  current: EnvFingerprint,
): string | null {
  const mismatches: string[] = [];

  if (recorded.node_version !== current.node_version) {
    mismatches.push(`node: ${recorded.node_version} → ${current.node_version}`);
  }
  if (recorded.platform !== current.platform) {
    mismatches.push(`platform: ${recorded.platform} → ${current.platform}`);
  }
  if (recorded.arch !== current.arch) {
    mismatches.push(`arch: ${recorded.arch} → ${current.arch}`);
  }

  return mismatches.length > 0
    ? `Environment mismatch: ${mismatches.join(", ")}`
    : null;
}
