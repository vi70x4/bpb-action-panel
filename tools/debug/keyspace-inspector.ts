#!/usr/bin/env node

/**
 * DHT Keyspace Inspector — read-only scanner for the BPB mesh DHT layer.
 *
 * Scans known key prefixes, parses record values, detects orphans
 * (expired keys with no tombstone), and outputs a summary.
 *
 * Modes:
 *   Live (default) — joins the DHT as a client and queries peers.
 *   Offline (--file <path>) — reads from a JSON snapshot file.
 *
 * Exit codes: 0 = no orphans, 1 = orphans detected, 2 = scan failure
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import {
	fromString as uint8fromString,
	toString as uint8toString,
} from "uint8arrays";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DHTRecord {
	peerId: string;
	protocol: string;
	host: string;
	port: number;
	uuid?: string;
	password?: string;
	sni?: string;
	security: string;
	network: string;
	ttl: number;
	bornAt: string;
	expiresAt: string;
	signature?: string;
}

export interface TombstoneRecord {
	deadPeer: string;
	diedAt: string;
	successor: string | null;
	lastKnownPeers?: string[];
}

interface FileSnapshot {
	networkId: string;
	keys: Array<{ key: string; value: DHTRecord | TombstoneRecord }>;
}

export interface ScanEntry {
	key: string;
	value: DHTRecord | TombstoneRecord | null;
	kind: "vless" | "hysteria2" | "tombstone";
	peerId: string;
}

interface ScanResult {
	entries: ScanEntry[];
	tombstonePeerIds: Set<string>;
	orphanCount: number;
}

export interface Summary {
	vless: number;
	hysteria2: number;
	tombstones: number;
	orphans: number;
	expiredAlive: number;
	total: number;
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CLIOpts {
	network: string;
	bootstrap: string | null;
	json: boolean;
	file: string | null;
}

export function parseArgs(argv: string[]): CLIOpts {
	const args = argv.slice(2);
	const opts: CLIOpts = {
		network: "bpb-default",
		bootstrap: null,
		json: false,
		file: null,
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--network":
				opts.network = args[++i] ?? opts.network;
				break;
			case "--bootstrap":
				opts.bootstrap = args[++i] ?? null;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--file":
				opts.file = args[++i] ?? null;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
		}
	}

	return opts;
}

function printHelp(): void {
	console.log(`
DHT Keyspace Inspector — read-only scanner for BPB mesh DHT

Usage:
  tsx keyspace-inspector.ts [options]

Options:
  --network <id>        Network ID to scan (default: bpb-default)
  --bootstrap <addr>    DHT bootstrap peer multiaddr
  --json                Machine-readable JSON output
  --file <path>         Read from JSON snapshot file (offline mode)
  -h, --help            Show this help

Exit codes:
  0  No orphans detected
  1  Orphaned keys detected
  2  Scan failure
`);
}

// ---------------------------------------------------------------------------
// DHT key helpers
// ---------------------------------------------------------------------------

export function makePrefix(network: string, kind: string): string {
	return `/bpb/v2/${network}/${kind}/`;
}

export function extractPeerIdFromKey(key: string): string {
	const parts = key.split("/");
	return parts[parts.length - 1];
}

export function classifyKey(
	key: string,
): "vless" | "hysteria2" | "tombstone" | null {
	if (key.includes("/vless/")) return "vless";
	if (key.includes("/hysteria2/")) return "hysteria2";
	if (key.includes("/tombstone/")) return "tombstone";
	return null;
}

// ---------------------------------------------------------------------------
// Live DHT scanning
// ---------------------------------------------------------------------------

async function createClientNode(bootstrap: string | null) {
	const peerDiscovery: Array<unknown> = [];

	const node = await createLibp2p({
		transports: [tcp(), webSockets()],
		addresses: {
			listen: ["/tcp/0/ws"],
		},
		services: {
			dht: kadDHT({
				clientMode: true,
				kBucketSize: 20,
			}),
			identify: identify(),
		},
		peerDiscovery,
	});

	if (bootstrap) {
		const { multiaddr } = await import("@libp2p/peer-id-factory");
		await node.dial(bootstrap);
	}

	// Give the DHT a moment to bootstrap
	await new Promise((resolve) => setTimeout(resolve, 3000));

	return node;
}

/**
 * Scan a single DHT prefix by trying to get keys for known peer patterns.
 * Kademlia DHT doesn't natively support prefix scans, so we use
 * `get` on constructed keys and rely on provider records.
 *
 * For a more complete scan, callers should use the offline --file mode
 * with a pre-collected snapshot.
 */
async function scanPrefixLive(
	node: { services: { dht: { get: (k: Uint8Array) => Promise<Uint8Array> } } },
	prefix: string,
	kind: "vless" | "hysteria2" | "tombstone",
): Promise<ScanEntry[]> {
	const entries: ScanEntry[] = [];

	// DHT.get requires exact keys — we provide this as a known-key lookup.
	// For prefix enumeration the operator should pre-dump keys via
	// a bootstrap node and feed them via --file mode.
	// This live helper is still useful for targeted inspection.
	try {
		// Query the prefix itself as a sentinel
		const prefixKey = uint8fromString(prefix);
		const raw = await node.services.dht.get(prefixKey);
		if (raw.length > 0) {
			const value = parseValue(raw, kind);
			entries.push({
				key: prefix,
				value,
				kind,
				peerId: extractPeerIdFromKey(prefix),
			});
		}
	} catch {
		// No value at prefix — expected for non-leaf keys
	}

	return entries;
}

/**
 * Scan specific known keys in live mode.
 * Takes an array of full DHT keys and queries each one.
 */
async function scanKnownKeysLive(
	node: { services: { dht: { get: (k: Uint8Array) => Promise<Uint8Array> } } },
	keys: string[],
): Promise<ScanEntry[]> {
	const entries: ScanEntry[] = [];

	for (const key of keys) {
		const kind = classifyKey(key);
		if (!kind) continue;

		try {
			const raw = await node.services.dht.get(uint8fromString(key));
			const value = parseValue(raw, kind);
			entries.push({
				key,
				value,
				kind,
				peerId: extractPeerIdFromKey(key),
			});
		} catch {
			entries.push({
				key,
				value: null,
				kind,
				peerId: extractPeerIdFromKey(key),
			});
		}
	}

	return entries;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

export function parseValue(
	raw: Uint8Array,
	kind: "vless" | "hysteria2" | "tombstone",
): DHTRecord | TombstoneRecord | null {
	try {
		const text = uint8toString(raw);
		const obj = JSON.parse(text);

		if (kind === "tombstone") {
			return obj as TombstoneRecord;
		}
		return obj as DHTRecord;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Offline mode — read from snapshot file
// ---------------------------------------------------------------------------

async function scanFromFile(
	filePath: string,
	network: string,
): Promise<ScanResult> {
	const raw = await readFile(resolve(filePath), "utf-8");
	const snapshot: FileSnapshot = JSON.parse(raw);

	const effectiveNetwork = snapshot.networkId ?? network;
	const entries: ScanEntry[] = [];
	const tombstonePeerIds = new Set<string>();

	for (const entry of snapshot.keys) {
		const kind = classifyKey(entry.key);
		if (!kind) continue;

		const peerId = extractPeerIdFromKey(entry.key);

		if (kind === "tombstone") {
			tombstonePeerIds.add(peerId);
		}

		entries.push({
			key: entry.key,
			value: entry.value,
			kind,
			peerId,
		});
	}

	// Detect orphans
	let orphanCount = 0;
	for (const entry of entries) {
		if (entry.kind === "tombstone" || !entry.value) continue;
		const record = entry.value as DHTRecord;
		if (isExpired(record) && !tombstonePeerIds.has(entry.peerId)) {
			orphanCount++;
		}
	}

	return { entries, tombstonePeerIds, orphanCount };
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export function isExpired(record: DHTRecord): boolean {
	try {
		return new Date(record.expiresAt).getTime() < Date.now();
	} catch {
		return false;
	}
}

export function expiresIn(record: DHTRecord): string {
	try {
		const ms = new Date(record.expiresAt).getTime() - Date.now();
		if (ms <= 0) return "EXPIRED";
		const minutes = Math.floor(ms / 60_000);
		if (minutes >= 60) {
			const h = Math.floor(minutes / 60);
			const m = minutes % 60;
			return `${h}h ${m}m`;
		}
		return `${minutes}m`;
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

export function formatEntry(
	entry: ScanEntry,
	tombstonePeerIds: Set<string>,
): string {
	const { key, value, kind, peerId } = entry;

	if (kind === "tombstone" && value) {
		const ts = value as TombstoneRecord;
		const reason = ts.successor ? `successor: ${ts.successor}` : "TTL expired";
		return [
			`🪦 ${key}`,
			`   peer: ${ts.deadPeer}  reason: ${reason}  died: ${ts.diedAt}`,
		].join("\n");
	}

	if (!value) {
		return [`🔑 ${key}`, `   peer: ${peerId}  ⚠️ VALUE UNREADABLE`].join("\n");
	}

	const record = value as DHTRecord;
	const expired = isExpired(record);
	const orphaned = expired && !tombstonePeerIds.has(peerId);

	if (orphaned) {
		return [
			`⚠️ ORPHAN: ${key}`,
			`   peer: ${peerId}  EXPIRED but NO TOMBSTONE — ghost record!`,
			`   born: ${record.bornAt}  expires: ${record.expiresAt}  TTL: ${record.ttl}s`,
		].join("\n");
	}

	const status = expired
		? "🪦 EXPIRED (tombstoned)"
		: `✅ ALIVE (expires in ${expiresIn(record)})`;

	const protocol = record.protocol;
	const hostPort = `${record.host}:${record.port}`;
	const sniPart = record.sni ? `  sni: ${record.sni}` : "";

	return [
		`📦 ${key}`,
		`   peer: ${peerId}  protocol: ${protocol}  host: ${hostPort}${sniPart}`,
		`   born: ${record.bornAt}  expires: ${record.expiresAt}  TTL: ${record.ttl}s`,
		`   status: ${status}`,
	].join("\n");
}

export function computeSummary(
	entries: ScanEntry[],
	tombstonePeerIds: Set<string>,
): Summary {
	let vless = 0;
	let hysteria2 = 0;
	let tombstones = 0;
	let orphans = 0;
	let expiredAlive = 0;

	for (const entry of entries) {
		switch (entry.kind) {
			case "vless":
				vless++;
				break;
			case "hysteria2":
				hysteria2++;
				break;
			case "tombstone":
				tombstones++;
				continue;
		}

		if (entry.value) {
			const record = entry.value as DHTRecord;
			const expired = isExpired(record);
			if (expired && !tombstonePeerIds.has(entry.peerId)) {
				orphans++;
			} else if (expired) {
				expiredAlive++;
			}
		}
	}

	return {
		vless,
		hysteria2,
		tombstones,
		orphans,
		expiredAlive,
		total: entries.length,
	};
}

export function formatSummary(s: Summary): string {
	const orphanFlag = s.orphans > 0 ? " ⚠️" : "";
	return [
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"Summary:",
		`  VLESS records:   ${s.vless}`,
		`  Hy2 records:     ${s.hysteria2}`,
		`  Tombstones:      ${s.tombstones}`,
		`  Orphaned keys:   ${s.orphans}${orphanFlag}`,
		`  Expired (alive): ${s.expiredAlive}`,
		`  Total keys:      ${s.total}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

interface JsonResult {
	network: string;
	entries: Array<{
		key: string;
		peerId: string;
		kind: string;
		value: DHTRecord | TombstoneRecord | null;
		status: "alive" | "expired" | "tombstoned" | "orphaned" | "unreadable";
	}>;
	summary: Summary;
}

export function buildJsonOutput(
	network: string,
	entries: ScanEntry[],
	tombstonePeerIds: Set<string>,
): JsonResult {
	return {
		network,
		entries: entries.map((e) => {
			let status: JsonResult["entries"][number]["status"] = "alive";

			if (e.kind === "tombstone") {
				status = "tombstoned";
			} else if (!e.value) {
				status = "unreadable";
			} else {
				const record = e.value as DHTRecord;
				const expired = isExpired(record);
				if (expired && !tombstonePeerIds.has(e.peerId)) {
					status = "orphaned";
				} else if (expired) {
					status = "expired";
				}
			}

			return {
				key: e.key,
				peerId: e.peerId,
				kind: e.kind,
				value: e.value,
				status,
			};
		}),
		summary: computeSummary(entries, tombstonePeerIds),
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const opts = parseArgs(process.argv);
	let result: ScanResult;

	if (opts.file) {
		// ── Offline mode ──────────────────────────────────────────────
		try {
			result = await scanFromFile(opts.file, opts.network);
		} catch (err) {
			console.error(`Failed to read snapshot: ${err}`);
			return 2;
		}
	} else {
		// ── Live DHT mode ─────────────────────────────────────────────
		console.log("Connecting to DHT mesh...");
		let node: Awaited<ReturnType<typeof createClientNode>> | null = null;

		try {
			// Quick type to get the service shape
			node = await createClientNode(opts.bootstrap);

			const prefixes: Array<{
				kind: "vless" | "hysteria2" | "tombstone";
				prefix: string;
			}> = [
				{ kind: "vless", prefix: makePrefix(opts.network, "vless") },
				{ kind: "hysteria2", prefix: makePrefix(opts.network, "hysteria2") },
				{ kind: "tombstone", prefix: makePrefix(opts.network, "tombstone") },
			];

			const allEntries: ScanEntry[] = [];
			for (const { kind, prefix } of prefixes) {
				const entries = await scanPrefixLive(
					node as unknown as {
						services: {
							dht: {
								get: (k: Uint8Array) => Promise<Uint8Array>;
							};
						};
					},
					prefix,
					kind,
				);
				allEntries.push(...entries);
			}

			const tombstonePeerIds = new Set<string>();
			let orphanCount = 0;

			for (const entry of allEntries) {
				if (entry.kind === "tombstone") {
					tombstonePeerIds.add(entry.peerId);
				}
			}

			for (const entry of allEntries) {
				if (entry.kind === "tombstone" || !entry.value) continue;
				const record = entry.value as DHTRecord;
				if (isExpired(record) && !tombstonePeerIds.has(entry.peerId)) {
					orphanCount++;
				}
			}

			result = { entries: allEntries, tombstonePeerIds, orphanCount };
		} catch (err) {
			console.error(`DHT scan failed: ${err}`);
			return 2;
		} finally {
			if (node) {
				await node.stop();
			}
		}
	}

	// ── Output ─────────────────────────────────────────────────────
	if (opts.json) {
		const json = buildJsonOutput(
			opts.network,
			result.entries,
			result.tombstonePeerIds,
		);
		console.log(JSON.stringify(json, null, 2));
	} else {
		console.log();
		console.log(`🔑 DHT Keyspace Inspector — network: ${opts.network}`);
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log();

		for (const entry of result.entries) {
			console.log(formatEntry(entry, result.tombstonePeerIds));
			console.log();
		}

		console.log(
			formatSummary(computeSummary(result.entries, result.tombstonePeerIds)),
		);
	}

	// Exit code: 0 = clean, 1 = orphans, 2 = scan failure (returned earlier)
	return result.orphanCount > 0 ? 1 : 0;
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((err) => {
		console.error(`Fatal: ${err}`);
		process.exit(2);
	});
