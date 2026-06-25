/**
 * Swarm Logger — structured logging for the BPB mesh.
 *
 * Standardizes log output across all mesh components:
 *   [SWARM][SUBSYSTEM][EVENT] key=value key=value
 *
 * Subsystems: DHT, BOOTSTRAP, GHOST, TUNNEL, LIFECYCLE
 *
 * Usage:
 *   import { SwarmLogger } from "./swarm-logger.js";
 *   const log = SwarmLogger.dht();
 *   log.info("ANNOUNCE", { peer: "12D3KooW...", key: "/bpb/v2/bpb-default/vless/..." });
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Subsystem = "DHT" | "BOOTSTRAP" | "GHOST" | "TUNNEL" | "LIFECYCLE";

// ---------------------------------------------------------------------------
// Data serializer — key=value pairs for readability
// ---------------------------------------------------------------------------

export function serialize(data?: Record<string, unknown>): string {
	if (!data || Object.keys(data).length === 0) return "";
	return Object.entries(data)
		.map(([k, v]) => {
			const val = typeof v === "string" ? v : JSON.stringify(v);
			return `${k}=${val}`;
		})
		.join(" ");
}

// ---------------------------------------------------------------------------
// Core log function
// ---------------------------------------------------------------------------

export function swarmLog(
	subsystem: Subsystem,
	event: string,
	level: "info" | "warn" | "error" | "debug",
	data?: Record<string, unknown>,
): void {
	const ts = new Date().toISOString();
	const prefix = `[SWARM][${subsystem}][${event}]`;
	const kv = serialize(data);
	const line = kv ? `${ts} ${prefix} ${kv}` : `${ts} ${prefix}`;

	switch (level) {
		case "error":
			console.error(line);
			break;
		case "warn":
			console.warn(line);
			break;
		case "debug":
			if (process.env.DEBUG && /swarm\*/i.test(process.env.DEBUG)) {
				console.log(line);
			}
			break;
		case "info":
		default:
			console.log(line);
			break;
	}
}

// ---------------------------------------------------------------------------
// SwarmLogger class — per-subsystem factory
// ---------------------------------------------------------------------------

export class SwarmLogger {
	constructor(private readonly subsystem: Subsystem) {}

	info(event: string, data?: Record<string, unknown>): void {
		swarmLog(this.subsystem, event, "info", data);
	}

	warn(event: string, data?: Record<string, unknown>): void {
		swarmLog(this.subsystem, event, "warn", data);
	}

	error(event: string, data?: Record<string, unknown>): void {
		swarmLog(this.subsystem, event, "error", data);
	}

	debug(event: string, data?: Record<string, unknown>): void {
		swarmLog(this.subsystem, event, "debug", data);
	}

	// --- Static factories for each subsystem ---

	static dht(): SwarmLogger {
		return new SwarmLogger("DHT");
	}

	static bootstrap(): SwarmLogger {
		return new SwarmLogger("BOOTSTRAP");
	}

	static ghost(): SwarmLogger {
		return new SwarmLogger("GHOST");
	}

	static tunnel(): SwarmLogger {
		return new SwarmLogger("TUNNEL");
	}

	static lifecycle(): SwarmLogger {
		return new SwarmLogger("LIFECYCLE");
	}
}

// ---------------------------------------------------------------------------
// Demo mode — run directly to print sample log lines
// ---------------------------------------------------------------------------

const isMain =
	typeof process !== "undefined" &&
	process.argv[1]?.endsWith("swarm-logger.ts");

if (isMain) {
	console.log("=== Swarm Logger Demo ===\n");

	const dht = SwarmLogger.dht();
	dht.info("ANNOUNCE", {
		peer: "12D3KooW...",
		key: "/bpb/v2/bpb-default/vless/12D3KooW...",
	});

	const bootstrap = SwarmLogger.bootstrap();
	bootstrap.info("OK", { peers: "3/5", latency_p50: "23ms" });
	bootstrap.warn("PARTIAL", { reachable: 2, total: 5 });

	const ghost = SwarmLogger.ghost();
	ghost.warn("DETECTED", {
		peer: "12D3KooX...",
		age: "14m",
		missing_tombstone: true,
	});

	const tunnel = SwarmLogger.tunnel();
	tunnel.info("READY", {
		provider: "trycloudflare",
		host: "abc.trycloudflare.com",
		port: 443,
	});
	tunnel.error("FAILED", { provider: "pinggy", error: "connection refused" });

	const lifecycle = SwarmLogger.lifecycle();
	lifecycle.info("SPAWN", { peer: "12D3KooW...", ttl: 2340 });
	lifecycle.warn("PRE_DEATH", { peer: "12D3KooW...", ttl_remaining: "300s" });
	lifecycle.info("DEREGISTER", { peer: "12D3KooW...", tombstone: true });

	console.log("\n=== End Demo ===");
}
