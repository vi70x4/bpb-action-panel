/**
 * Tunnel Event Mock Layer — simulates tunnel lifecycle events for testing
 * reannounce logic without real cloudflared/pinggy dependencies.
 *
 * Usage:
 *   Programmatic:  import { TunnelEmitter } from "./tunnel-emitter.ts"
 *   CLI:           tsx tunnel-emitter.ts --provider trycloudflare --latency 3000
 *   Env-file:      tsx tunnel-emitter.ts --write-env /tmp/tunnel.env --provider pinggy
 *   Fail mode:     tsx tunnel-emitter.ts --provider pinggy --fail
 *   Reconnect:     tsx tunnel-emitter.ts --provider pinggy --reconnect-after 5000
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TunnelProvider = "trycloudflare" | "pinggy" | "direct";

export interface TunnelMockConfig {
	provider: TunnelProvider;
	latencyMs?: number;
	failureRate?: number;
	reconnectRate?: number;
	host?: string;
	port?: number;
}

export interface TunnelReadyPayload {
	host: string;
	port: number;
	url: string;
	provider: TunnelProvider;
}

export interface TunnelFailedPayload {
	error: string;
	provider: TunnelProvider;
}

export interface TunnelReconnectingPayload {
	provider: TunnelProvider;
}

export interface TunnelStartingPayload {
	provider: TunnelProvider;
}

export interface TunnelClosedPayload {
	provider: TunnelProvider;
}

export type TunnelEventName =
	| "TUNNEL_STARTING"
	| "TUNNEL_READY"
	| "TUNNEL_FAILED"
	| "TUNNEL_RECONNECTING"
	| "TUNNEL_CLOSED";

export interface TunnelEventMap {
	TUNNEL_STARTING: TunnelStartingPayload;
	TUNNEL_READY: TunnelReadyPayload;
	TUNNEL_FAILED: TunnelFailedPayload;
	TUNNEL_RECONNECTING: TunnelReconnectingPayload;
	TUNNEL_CLOSED: TunnelClosedPayload;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const WORDS = [
	"swift",
	"bold",
	"calm",
	"dark",
	"keen",
	"pale",
	"rich",
	"warm",
	"azure",
	"coral",
	"ivory",
	"onyx",
	"sage",
	"dusk",
	"fern",
	"glow",
	"mist",
	"peak",
	"tide",
	"vale",
];

export function randomWord(): string {
	return WORDS[Math.floor(Math.random() * WORDS.length)];
}

export function randomHex(len: number): string {
	return randomBytes(len).toString("hex").slice(0, len);
}

export function randomPort(): number {
	return 10_000 + Math.floor(Math.random() * 55_000);
}

export function randomIp(): string {
	const octet = () => Math.floor(Math.random() * 254) + 1;
	return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

export function randomLatency(): number {
	return 2000 + Math.floor(Math.random() * 4000);
}

export function isoNow(): string {
	return new Date().toISOString();
}

interface GeneratedEndpoint {
	host: string;
	port: number;
	url: string;
}

export function generateEndpoint(
	provider: TunnelProvider,
	hostOverride?: string,
	portOverride?: number,
): GeneratedEndpoint {
	switch (provider) {
		case "trycloudflare": {
			const host =
				hostOverride ?? `${randomWord()}-${randomHex(6)}.trycloudflare.com`;
			const port = portOverride ?? 443;
			return { host, port, url: `https://${host}` };
		}
		case "pinggy": {
			const host = hostOverride ?? "a.pinggy.io";
			const port = portOverride ?? randomPort();
			return { host, port, url: `${host}:${port}` };
		}
		case "direct": {
			const host = hostOverride ?? randomIp();
			const port = portOverride ?? randomPort();
			return { host, port, url: `${host}:${port}` };
		}
	}
}

// ---------------------------------------------------------------------------
// TunnelEmitter
// ---------------------------------------------------------------------------

export class TunnelEmitter extends EventEmitter {
	private config: Required<Pick<TunnelMockConfig, "provider">> &
		Pick<
			TunnelMockConfig,
			"latencyMs" | "failureRate" | "reconnectRate" | "host" | "port"
		>;

	private _started = false;
	private _stopped = false;

	constructor(config: TunnelMockConfig) {
		super();
		this.config = {
			provider: config.provider,
			latencyMs: config.latencyMs,
			failureRate: config.failureRate,
			reconnectRate: config.reconnectRate,
			host: config.host,
			port: config.port,
		};
	}

	/** Whether the mock has been started and not yet stopped. */
	get active(): boolean {
		return this._started && !this._stopped;
	}

	/**
	 * Start the mock tunnel lifecycle.
	 * Emits TUNNEL_STARTING immediately, then after simulated latency
	 * emits TUNNEL_READY or TUNNEL_FAILED depending on failureRate.
	 */
	start(): void {
		if (this._started) return;
		this._started = true;
		this.emit("TUNNEL_STARTING", {
			provider: this.config.provider,
		} satisfies TunnelStartingPayload);

		const latency = this.config.latencyMs ?? randomLatency();
		const shouldFail = Math.random() < (this.config.failureRate ?? 0.1);

		setTimeout(() => {
			if (this._stopped) return;

			if (shouldFail) {
				this.emit("TUNNEL_FAILED", {
					error: `${this.config.provider} tunnel failed to establish (simulated)`,
					provider: this.config.provider,
				} satisfies TunnelFailedPayload);
				return;
			}

			const ep = generateEndpoint(
				this.config.provider,
				this.config.host,
				this.config.port,
			);
			this.emit("TUNNEL_READY", {
				host: ep.host,
				port: ep.port,
				url: ep.url,
				provider: this.config.provider,
			} satisfies TunnelReadyPayload);

			// Possibly schedule a mid-life reconnect
			const shouldReconnect =
				Math.random() < (this.config.reconnectRate ?? 0.05);
			if (shouldReconnect) {
				const reconnectDelay = 4000 + Math.floor(Math.random() * 8000);
				setTimeout(() => {
					if (this._stopped) return;
					this.emit("TUNNEL_RECONNECTING", {
						provider: this.config.provider,
					} satisfies TunnelReconnectingPayload);

					const reLatency = 1000 + Math.floor(Math.random() * 2000);
					setTimeout(() => {
						if (this._stopped) return;
						const ep2 = generateEndpoint(
							this.config.provider,
							this.config.host,
							this.config.port,
						);
						this.emit("TUNNEL_READY", {
							host: ep2.host,
							port: ep2.port,
							url: ep2.url,
							provider: this.config.provider,
						} satisfies TunnelReadyPayload);
					}, reLatency);
				}, reconnectDelay);
			}
		}, latency);
	}

	/**
	 * Force-emit TUNNEL_FAILED (for testing error paths).
	 * @param error Optional error message.
	 */
	fail(error?: string): void {
		this.emit("TUNNEL_FAILED", {
			error: error ?? `${this.config.provider} tunnel failed (forced)`,
			provider: this.config.provider,
		} satisfies TunnelFailedPayload);
	}

	/**
	 * Schedule a forced reconnect after `afterMs` milliseconds.
	 * First emits TUNNEL_RECONNECTING, then TUNNEL_READY after a short delay.
	 */
	reconnectAfter(afterMs: number): void {
		setTimeout(() => {
			if (this._stopped) return;
			this.emit("TUNNEL_RECONNECTING", {
				provider: this.config.provider,
			} satisfies TunnelReconnectingPayload);

			const reLatency = 1000 + Math.floor(Math.random() * 2000);
			setTimeout(() => {
				if (this._stopped) return;
				const ep = generateEndpoint(
					this.config.provider,
					this.config.host,
					this.config.port,
				);
				this.emit("TUNNEL_READY", {
					host: ep.host,
					port: ep.port,
					url: ep.url,
					provider: this.config.provider,
				} satisfies TunnelReadyPayload);
			}, reLatency);
		}, afterMs);
	}

	/**
	 * Emit TUNNEL_CLOSED and stop the mock.
	 */
	close(): void {
		if (this._stopped) return;
		this._stopped = true;
		this.emit("TUNNEL_CLOSED", {
			provider: this.config.provider,
		} satisfies TunnelClosedPayload);
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 2; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			const key = argv[i].slice(2);
			const val = argv[i + 1];
			if (val && !val.startsWith("--")) {
				args[key] = val;
				i++;
			} else {
				args[key] = "true";
			}
		}
	}
	return args;
}

export function validateProvider(val: string | undefined): TunnelProvider {
	if (val === "trycloudflare" || val === "pinggy" || val === "direct")
		return val;
	throw new Error(
		`--provider must be trycloudflare | pinggy | direct, got: ${val ?? "(missing)"}`,
	);
}

async function cli(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = validateProvider(args["provider"]);
	const latencyMs = args["latency"] ? parseInt(args["latency"], 10) : undefined;
	const envFile = args["write-env"];
	const fail = args["fail"] === "true";
	const reconnectAfter = args["reconnect-after"]
		? parseInt(args["reconnect-after"], 10)
		: undefined;

	const tunnel = new TunnelEmitter({
		provider,
		latencyMs,
		failureRate: fail ? 1.0 : 0,
		host: args["host"],
		port: args["port"] ? parseInt(args["port"], 10) : undefined,
	});

	let exitCode = 0;
	let lastReady: TunnelReadyPayload | null = null;

	// Line-delimited JSON output to stdout
	const emitLine = (
		event: TunnelEventName,
		payload: Record<string, unknown>,
	) => {
		const line = JSON.stringify({ event, ...payload, ts: isoNow() });
		process.stdout.write(line + "\n");
	};

	tunnel.on("TUNNEL_STARTING", (p: TunnelStartingPayload) => {
		emitLine("TUNNEL_STARTING", { provider: p.provider });
	});

	tunnel.on("TUNNEL_READY", (p: TunnelReadyPayload) => {
		emitLine("TUNNEL_READY", {
			provider: p.provider,
			host: p.host,
			port: p.port,
			url: p.url,
		});
		lastReady = p;

		// Write env file if requested
		if (envFile && p) {
			writeFileSync(
				envFile,
				[
					`TUNNEL_HOST=${p.host}`,
					`TUNNEL_PORT=${p.port}`,
					`TUNNEL_URL=${p.url}`,
				].join("\n") + "\n",
			);
		}
	});

	tunnel.on("TUNNEL_FAILED", (p: TunnelFailedPayload) => {
		emitLine("TUNNEL_FAILED", { provider: p.provider, error: p.error });
		exitCode = 1;
	});

	tunnel.on("TUNNEL_RECONNECTING", (p: TunnelReconnectingPayload) => {
		emitLine("TUNNEL_RECONNECTING", { provider: p.provider });
	});

	tunnel.on("TUNNEL_CLOSED", (p: TunnelClosedPayload) => {
		emitLine("TUNNEL_CLOSED", { provider: p.provider });
	});

	// Start lifecycle
	tunnel.start();

	// Optional forced reconnect
	if (reconnectAfter !== undefined) {
		tunnel.reconnectAfter(reconnectAfter);
	}

	// Wait for a final state then exit cleanly
	const settled = new Promise<void>((resolve) => {
		tunnel.on("TUNNEL_READY", () => {
			// If no reconnect scheduled, settle immediately
			if (reconnectAfter === undefined) resolve();
		});
		tunnel.on("TUNNEL_FAILED", () => resolve());
	});

	if (reconnectAfter !== undefined) {
		// Wait for the reconnected TUNNEL_READY (second one). We need to wait
		// long enough for both the reconnect-delay and re-ready latency.
		const totalWait = reconnectAfter + 5000;
		await new Promise<void>((resolve) => setTimeout(resolve, totalWait));
	} else {
		await settled;
	}

	// Give stdout a tick to flush, then exit
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	process.exit(exitCode);
}

// Run CLI when executed directly (not imported)
const isMain =
	process.argv[1]?.endsWith("tunnel-emitter.ts") ||
	process.argv[1]?.endsWith("tunnel-emitter.js");
if (isMain) {
	cli().catch((err) => {
		process.stderr.write(
			`tunnel-emitter: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
}
