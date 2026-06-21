import type { Libp2p } from "libp2p";

export interface ProxyConfig {
	peerId: string;
	protocol: "vless" | "hysteria2";
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
}

export async function announceProxyConfig(
	node: Libp2p,
	config: ProxyConfig,
): Promise<void> {
	const key = `/bpb/v2/${config.network}/${config.protocol}/${config.peerId}`;
	const value = new TextEncoder().encode(JSON.stringify(config));

	await node.contentRouting.put(new TextEncoder().encode(key), value);

	console.log(`📢 Announced to DHT: ${key}`);
}

export async function updateAndReannounce(
	node: Libp2p,
	existingConfig: ProxyConfig,
	tunnelHost: string,
	tunnelPort?: number,
): Promise<void> {
	existingConfig.host = tunnelHost;
	if (tunnelPort !== undefined) {
		existingConfig.port = tunnelPort;
	}
	existingConfig.sni = tunnelHost;

	// Recalculate remaining TTL
	const expiresAtMs = new Date(existingConfig.expiresAt).getTime();
	const remainingSeconds = Math.max(
		0,
		Math.floor((expiresAtMs - Date.now()) / 1000),
	);
	existingConfig.ttl = remainingSeconds;

	await announceProxyConfig(node, existingConfig);
	console.log(`🔄 Re-announced with tunnel host: ${tunnelHost}`);
}

export async function publishTombstone(
	node: Libp2p,
	network: string,
	protocol: string,
	peerId: string,
	successorId?: string,
): Promise<void> {
	const key = `/bpb/v2/${network}/tombstone/${peerId}`;
	const value = JSON.stringify({
		deadPeer: peerId,
		diedAt: new Date().toISOString(),
		successor: successorId || null,
		lastKnownPeers: node.getPeers().map((p: any) => p.toString()),
	});

	await node.contentRouting.put(
		new TextEncoder().encode(key),
		new TextEncoder().encode(value),
	);

	console.log(`🪦 Published tombstone: ${key}`);
}
