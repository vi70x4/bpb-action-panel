import { publishTombstone } from "./announce.js";
import type { Libp2p } from "libp2p";

export interface LifecycleOptions {
	ttlMinutes: number;
	network: string;
	protocol: string;
	peerId: string;
	reannounceIntervalSeconds?: number;
}

export function startLifecycle(
	node: Libp2p,
	options: LifecycleOptions,
): { stop: () => Promise<void> } {
	const ttlMs = options.ttlMinutes * 60 * 1000;
	let isShuttingDown = false;

	const ttlTimer = setTimeout(async () => {
		if (!isShuttingDown) {
			console.log(
				`⏰ TTL of ${options.ttlMinutes} minutes expired. Shutting down...`,
			);
			await gracefulShutdown();
		}
	}, ttlMs);

	process.on("SIGTERM", async () => {
		console.log("📡 SIGTERM received. Graceful shutdown...");
		await gracefulShutdown();
	});

	process.on("SIGINT", async () => {
		console.log("📡 SIGINT received. Graceful shutdown...");
		await gracefulShutdown();
	});

	async function gracefulShutdown() {
		if (isShuttingDown) return;
		isShuttingDown = true;

		clearTimeout(ttlTimer);

		try {
			await publishTombstone(
				node,
				options.network,
				options.protocol,
				options.peerId,
			);
		} catch (err) {
			console.error("Failed to publish tombstone:", err);
		}

		try {
			await node.stop();
			console.log("🛑 DHT node stopped");
		} catch (err) {
			console.error("Error stopping DHT node:", err);
		}

		setTimeout(() => process.exit(0), 1000);
	}

	return { stop: gracefulShutdown };
}
