/**
 * BPB Action Panel - Cloudflare Worker Coordinator
 *
 * Coordinates between GitHub Actions runners and end users.
 * Receives proxy configs from runners, serves Hiddify subscriptions.
 *
 * Auth: AUTH_TOKEN secret must be set. Runners pass it as Bearer token.
 * Storage: KV (persistent) or in-memory (fallback, resets on redeploy).
 */

export interface Env {
  BPB_KV?: KVNamespace;
  AUTH_TOKEN?: string;
}

// ----- KV wrappers with in-memory fallback -----

const memoryStore = new Map<string, { value: string; expires: number }>();

function hasKV(env: Env): boolean {
  return !!env.BPB_KV;
}

async function kvPut(env: Env, key: string, value: string, ttlSeconds: number) {
  if (hasKV(env)) {
    return env.BPB_KV!.put(key, value, { expirationTtl: ttlSeconds });
  }
  memoryStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

async function kvGet(env: Env, key: string): Promise<string | null> {
  if (hasKV(env)) {
    return env.BPB_KV!.get(key);
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

async function kvDelete(env: Env, key: string) {
  if (hasKV(env)) {
    return env.BPB_KV!.delete(key);
  }
  memoryStore.delete(key);
}

async function kvList(env: Env, prefix: string): Promise<string[]> {
  if (hasKV(env)) {
    const list = await env.BPB_KV!.list({ prefix });
    return list.keys.map((k) => k.name);
  }
  const now = Date.now();
  // Clean expired + collect live keys
  const keys: string[] = [];
  for (const [k, v] of memoryStore) {
    if (now > v.expires) {
      memoryStore.delete(k);
    } else if (k.startsWith(prefix)) {
      keys.push(k);
    }
  }
  return keys;
}

// ----- Auth -----

function checkAuth(request: Request, env: Env): boolean {
  // If no AUTH_TOKEN is configured, allow all (dev mode)
  if (!env.AUTH_TOKEN) return true;

  const auth = request.headers.get("Authorization");
  if (!auth) return false;

  // Support "Bearer <token>" and "<token>" formats
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return token === env.AUTH_TOKEN;
}

// ----- Types -----

interface ProxyConfig {
  protocol: "vless" | "hysteria2";
  id: string;
  host: string;
  port: number;
  password?: string;
  uuid?: string;
  tls?: boolean;
  sni?: string;
  createdAt: string;
  expiresAt: string;
}

// ----- Subscription generators -----

function generateVlessURL(config: ProxyConfig): string {
  const params = new URLSearchParams({
    security: "tls",
    encryption: "none",
    headerType: "none",
    type: "ws",
    path: "/ws",
  });
  if (config.sni) params.set("sni", config.sni);
  return `vless://${config.uuid}@${config.host}:${config.port}?${params.toString()}#BPB-Action-${config.id}`;
}

function generateHysteria2URL(config: ProxyConfig): string {
  const params = new URLSearchParams({ insecure: "1" });
  if (config.sni) params.set("sni", config.sni);
  return `hysteria2://${config.password}@${config.host}:${config.port}?${params.toString()}#BPB-Action-${config.id}`;
}

function generateSubscription(configs: ProxyConfig[]): string {
  return configs
    .map((c) => {
      if (c.protocol === "vless") return generateVlessURL(c);
      if (c.protocol === "hysteria2") return generateHysteria2URL(c);
      return "";
    })
    .filter((u) => u.length > 0)
    .join("\n");
}

// ----- Duration helper -----

function ttlToSeconds(ttlMinutes: number): number {
  // KV TTL is 60s minimum, max 30 days. Proxy TTL is 15-60 min.
  return Math.max(60, ttlMinutes * 60);
}

// ----- Main handler -----

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check — no auth required
      if (path === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            service: "BPB Action Coordinator",
            version: "1.1.0",
            kv: hasKV(env) ? "connected" : "in-memory",
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // Register proxy (requires auth)
      if (path === "/register" && request.method === "POST") {
        if (!checkAuth(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const data = (await request.json()) as ProxyConfig;
        if (!data.id || !data.host || !data.port) {
          return new Response(
            JSON.stringify({
              error: "Missing required fields: id, host, port",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        // Calculate TTL: expiresAt minus now, default 1 hour
        let ttlSeconds = 3600;
        if (data.expiresAt) {
          const expires = new Date(data.expiresAt).getTime();
          const remaining = Math.floor((expires - Date.now()) / 1000);
          if (remaining > 0) ttlSeconds = remaining;
          // Add 5 min buffer so record outlives the runner slightly
          ttlSeconds = Math.min(ttlSeconds + 300, 7200);
        }

        await kvPut(env, `proxy:${data.id}`, JSON.stringify(data), ttlSeconds);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Proxy registered",
            subscriptionUrl: `${url.origin}/sub/all`,
            ttlSeconds,
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // Heartbeat — runner pings to keep its KV record alive (re-registers with fresh TTL)
      if (path === "/heartbeat" && request.method === "POST") {
        if (!checkAuth(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const data = (await request.json()) as {
          id: string;
          expiresAt?: string;
        };
        if (!data.id) {
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const existing = await kvGet(env, `proxy:${data.id}`);
        if (!existing) {
          return new Response(JSON.stringify({ error: "Proxy not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Refresh TTL
        const config: ProxyConfig = JSON.parse(existing);
        let ttlSeconds = 3600;
        if (data.expiresAt) {
          const remaining = Math.floor(
            (new Date(data.expiresAt).getTime() - Date.now()) / 1000,
          );
          if (remaining > 0) ttlSeconds = remaining + 300;
        }
        await kvPut(
          env,
          `proxy:${data.id}`,
          JSON.stringify(config),
          ttlSeconds,
        );

        return new Response(JSON.stringify({ success: true, ttlSeconds }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Subscription — all proxies (no auth, public)
      if (path === "/sub/all" && request.method === "GET") {
        const keys = await kvList(env, "proxy:");
        const configs: ProxyConfig[] = [];
        for (const key of keys) {
          const data = await kvGet(env, key);
          if (data) configs.push(JSON.parse(data));
        }

        const subscription = generateSubscription(configs);
        return new Response(subscription, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
            ...corsHeaders,
          },
        });
      }

      // Subscription — specific proxy
      if (path.startsWith("/sub/") && request.method === "GET") {
        const id = path.replace("/sub/", "");
        if (id === "all") {
          // Handled above, but just in case
          const keys = await kvList(env, "proxy:");
          const configs: ProxyConfig[] = [];
          for (const key of keys) {
            const data = await kvGet(env, key);
            if (data) configs.push(JSON.parse(data));
          }
          return new Response(generateSubscription(configs), {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...corsHeaders,
            },
          });
        }

        const data = await kvGet(env, `proxy:${id}`);
        if (!data) {
          return new Response(JSON.stringify({ error: "Proxy not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        return new Response(generateSubscription([JSON.parse(data)]), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...corsHeaders,
          },
        });
      }

      // List active proxies (JSON, no auth for now)
      if (path === "/proxies" && request.method === "GET") {
        const keys = await kvList(env, "proxy:");
        const proxies = [];
        for (const key of keys) {
          const data = await kvGet(env, key);
          if (data) {
            const c: ProxyConfig = JSON.parse(data);
            proxies.push({
              id: c.id,
              protocol: c.protocol,
              host: c.host,
              port: c.port,
              createdAt: c.createdAt,
              expiresAt: c.expiresAt,
            });
          }
        }
        return new Response(JSON.stringify(proxies, null, 2), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Delete proxy (requires auth)
      if (path.startsWith("/delete/") && request.method === "DELETE") {
        if (!checkAuth(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        const id = path.replace("/delete/", "");
        await kvDelete(env, `proxy:${id}`);
        return new Response(
          JSON.stringify({ success: true, message: "Proxy deleted" }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // API index
      return new Response(
        JSON.stringify({
          name: "BPB Action Coordinator",
          version: "1.1.0",
          endpoints: {
            "POST /register": "Register a new proxy (auth required)",
            "POST /heartbeat": "Refresh proxy TTL (auth required)",
            "GET /sub/all": "Get subscription for all proxies",
            "GET /sub/{id}": "Get subscription for specific proxy",
            "GET /proxies": "List all active proxies",
            "DELETE /delete/{id}": "Delete a proxy (auth required)",
            "GET /health": "Health check",
          },
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    } catch (error) {
      console.error("Error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};
