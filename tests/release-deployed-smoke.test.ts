import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";

type BrokenAsset = "script-mime" | "script-html-body" | "stylesheet-mime";

async function runMountedSmokeFixture(brokenAsset?: BrokenAsset) {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/kyx/" || pathname === "/kyx") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><head><title>KYX — Browser DAW</title><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>',
      );
      return;
    }
    if (pathname === "/kyx/manifest.webmanifest") {
      response.writeHead(200, { "content-type": "application/manifest+json" });
      response.end(JSON.stringify({ name: "KYX — Browser DAW", short_name: "KYX" }));
      return;
    }
    if (pathname.endsWith("/assets/app.js")) {
      const isHtmlBody = brokenAsset === "script-html-body";
      const contentType = brokenAsset === "script-mime" ? "text/html" : "application/javascript";
      response.writeHead(200, { "content-type": contentType });
      response.end(
        isHtmlBody ? "<!doctype html><html>SPA fallback</html>" : "window.fixtureLoaded = true;".padEnd(96, " "),
      );
      return;
    }
    if (pathname.endsWith("/assets/app.css")) {
      response.writeHead(200, {
        "content-type": brokenAsset === "stylesheet-mime" ? "text/html" : "text/css",
      });
      response.end("#root { display: block; }");
      return;
    }
    if (/\/(?:bitcrusher-worklet|core-worklet|fxeq-worklet|ultina-worklet|ozvena-worklet|sw)\.js$/.test(pathname)) {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("self.fixtureLoaded = true;".padEnd(96, " "));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a local smoke fixture port");

  let output = "";
  try {
    const child = spawn(process.execPath, ["scripts/release-deployed-smoke.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KYX_DEPLOY_URL: `http://127.0.0.1:${address.port}/kyx`,
        KYX_DEPLOY_SMOKE_TIMEOUT_MS: "3000",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? -1));
    });
    return { exitCode, output };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("deployed app-shell runtime asset gate", () => {
  it("accepts a mounted shell when its same-origin JavaScript and CSS have valid MIME", async () => {
    const result = await runMountedSmokeFixture();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("/kyx/assets/app.js serves JS with application/javascript");
    expect(result.output).toContain("/kyx/assets/app.css serves CSS with text/css");
  }, 10_000);

  it.each([
    ["JavaScript served as HTML", "script-mime", "invalid JS Content-Type: text/html"],
    ["HTML fallback mislabeled as JavaScript", "script-html-body", "returned an HTML document instead of JS content"],
    ["CSS served as HTML", "stylesheet-mime", "invalid CSS Content-Type: text/html"],
  ] as const)(
    "rejects %s even when the server responds with HTTP 200",
    async (_label, brokenAsset, diagnostic) => {
      const result = await runMountedSmokeFixture(brokenAsset);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(diagnostic);
      expect(result.output).toContain("[release-deployed-smoke] FAIL");
    },
    10_000,
  );
});
