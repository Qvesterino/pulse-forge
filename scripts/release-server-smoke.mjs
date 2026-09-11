/**
 * Smoke the real collab-server entrypoint with production configuration.
 * This checks the local process wiring and HTTP policy; it does not replace a
 * deployed-host health check or a two-browser collaboration session.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const allowedOrigin = "https://app.example.com";
const adminToken = "release-server-smoke-token";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("could not allocate a local smoke-test port");
  }
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(url, child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`collab server exited before health became available: ${output()}`);
    }
    try {
      return await fetch(`${url}/api/health`, { headers: { Origin: allowedOrigin } });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`collab server did not become healthy: ${output()}`);
}

const port = await freePort();
const galleryFile = join(tmpdir(), `kyx-release-server-smoke-${randomUUID()}.json`);
const child = spawn(process.execPath, ["server/collab-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    CORS_ORIGIN: allowedOrigin,
    GALLERY_ADMIN_TOKEN: adminToken,
    GALLERY_FILE: galleryFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => {
  logs += String(chunk);
});
child.stderr.on("data", (chunk) => {
  logs += String(chunk);
});

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl, child, () => logs.trim());
  const healthBody = await health.json();
  if (
    health.status !== 200 ||
    healthBody.ok !== true ||
    health.headers.get("access-control-allow-origin") !== allowedOrigin
  ) {
    throw new Error(`health contract failed: ${health.status} ${JSON.stringify(healthBody)}`);
  }

  const forbidden = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://evil.example" } });
  if (forbidden.status !== 403) throw new Error(`forbidden origin returned ${forbidden.status}, expected 403`);

  const unauthenticated = await fetch(`${baseUrl}/api/admin/reports`, { headers: { Origin: allowedOrigin } });
  if (unauthenticated.status !== 401)
    throw new Error(`unauthenticated admin returned ${unauthenticated.status}, expected 401`);

  const authenticated = await fetch(`${baseUrl}/api/admin/reports`, {
    headers: { Origin: allowedOrigin, Authorization: `Bearer ${adminToken}` },
  });
  if (authenticated.status !== 200)
    throw new Error(`authenticated admin returned ${authenticated.status}, expected 200`);

  console.log("[release-server-smoke] PASS — real entrypoint health/CORS/origin/admin contract");
} finally {
  child.kill();
  if (child.exitCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await unlink(galleryFile).catch(() => undefined);
}
