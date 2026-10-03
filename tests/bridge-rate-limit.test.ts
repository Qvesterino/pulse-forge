import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BRIDGE RATE LIMITER — token-bucket DoS guard on the loopback bridge.
 * Burst 30, refill 0.5/s. The auth token stays the primary gate; this
 * throttles even authenticated floods so the renderer is never wedged by
 * a runaway agent. 401 requests run BEFORE the bucket (auth gate first).
 */

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bridge = require_(path.join(ROOT, "desktop/mcp-bridge-server.cjs")) as {
  createMcpBridgeServer(opts: {
    token: string;
    executeTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string }>;
  }): { server: http.Server };
  resetRateLimitBucket: () => void;
  RATE_LIMIT_BURST: number;
};

function post(port: number, body: string, token: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/rpc",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let server: http.Server | null = null;
let port = 0;

beforeEach(async () => {
  bridge.resetRateLimitBucket();
  server = bridge.createMcpBridgeServer({
    token: "test-tok",
    executeTool: async () => ({ text: "ok" }),
  }).server;
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server!.address() as { port: number }).port;
});

afterEach(() => {
  server?.close();
  server = null;
});

describe("bridge rate limiter", () => {
  it("allows the burst (30) then 429s the overflow", async () => {
    let ok = 0;
    let last429 = 0;
    for (let i = 0; i < 33; i++) {
      const res = await post(port, JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }), "test-tok");
      if (res.status === 200) ok += 1;
      else if (res.status === 429) last429 = res.status;
    }
    expect(ok).toBe(bridge.RATE_LIMIT_BURST);
    expect(last429).toBe(429);
  });

  it("401 requests do NOT consume tokens (auth gate runs first)", async () => {
    for (let i = 0; i < 5; i++) {
      await post(port, JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }), "wrong-tok");
    }
    let ok = 0;
    for (let i = 0; i < bridge.RATE_LIMIT_BURST; i++) {
      const res = await post(port, JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }), "test-tok");
      if (res.status === 200) ok += 1;
    }
    expect(ok).toBe(bridge.RATE_LIMIT_BURST);
  });
});
