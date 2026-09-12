/**
 * Verify a deployed KYX app shell and, when configured, its public collab /
 * gallery endpoint. This is intentionally a small HTTP probe: it does not
 * replace the browser/device matrix or a real two-tab jam test.
 *
 * Required:
 *   KYX_DEPLOY_URL=https://app.example.com npm run release:deployed-smoke
 *
 * Optional collaboration checks:
 *   KYX_COLLAB_URL=https://collab.example.com
 *   KYX_ALLOWED_ORIGIN=https://app.example.com
 *   KYX_GALLERY_PUBLIC=1 KYX_GALLERY_ADMIN_TOKEN=<token>
 *
 * If KYX_COLLAB_URL is omitted, the static app checks still run and the
 * output explicitly marks the server checks as skipped.
 */

function normalizeBaseUrl(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http:// or https://`);
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const deployUrl = normalizeBaseUrl(process.env.KYX_DEPLOY_URL, "KYX_DEPLOY_URL");
const collabUrl = process.env.KYX_COLLAB_URL
  ? normalizeBaseUrl(process.env.KYX_COLLAB_URL, "KYX_COLLAB_URL")
  : null;
const allowedOrigin = process.env.KYX_ALLOWED_ORIGIN?.trim() || new URL(deployUrl).origin;
const timeoutMs = positiveInt(process.env.KYX_DEPLOY_SMOKE_TIMEOUT_MS, 15_000);
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
}

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function skip(message) {
  console.log(`[SKIP] ${message}`);
}

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const detail = error?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : String(error);
    throw new Error(`${url}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function textFromBytes(bytes) {
  return new TextDecoder().decode(bytes);
}

async function requireAsset(relativePath, predicate = null) {
  const url = `${deployUrl}${relativePath}`;
  let response;
  try {
    response = await request(url, { headers: { "Cache-Control": "no-cache" } });
  } catch (error) {
    fail(String(error));
    return null;
  }
  const body = await response.arrayBuffer();
  if (response.status !== 200 || body.byteLength === 0) {
    fail(`${relativePath} returned HTTP ${response.status} with ${body.byteLength} bytes`);
    return null;
  }
  if (predicate) {
    try {
      predicate(new Uint8Array(body), response);
    } catch (error) {
      fail(`${relativePath}: ${error?.message ?? String(error)}`);
      return null;
    }
  }
  pass(`${relativePath} (${body.byteLength} bytes)`);
  return { response, body };
}

async function checkAppShell() {
  const index = await requireAsset("/");
  if (index) {
    const html = textFromBytes(index.body);
    if (!/<title>[^<]*KYX/i.test(html) && !/id=["']root["']/i.test(html)) {
      fail("deployed index does not look like the KYX app shell");
    }
    if (/pulse\s+forge|pulseforge|vocalforge/i.test(html)) {
      fail("deployed index contains a legacy public brand label");
    }
  }

  const manifest = await requireAsset("/manifest.webmanifest");
  if (manifest) {
    try {
      const parsed = JSON.parse(textFromBytes(manifest.body));
      if (parsed.name !== "KYX — Browser DAW" || parsed.short_name !== "KYX") {
        fail(`manifest identity mismatch: ${JSON.stringify({ name: parsed.name, short_name: parsed.short_name })}`);
      } else {
        pass("manifest carries the KYX public identity");
      }
    } catch {
      fail("manifest.webmanifest is not valid JSON");
    }
  }

  for (const asset of [
    "/bitcrusher-worklet.js",
    "/core-worklet.js",
    "/fxeq-worklet.js",
    "/ultina-worklet.js",
    "/ozvena-worklet.js",
    "/sw.js",
  ]) {
    await requireAsset(asset, (bytes) => {
      if (bytes.byteLength < 64) throw new Error("unexpectedly small JavaScript artifact");
    });
  }
}

async function checkCollab() {
  if (!collabUrl) {
    skip("collab/gallery checks — set KYX_COLLAB_URL for the deployed relay");
    return;
  }

  const healthUrl = `${collabUrl}/api/health`;
  let health;
  try {
    health = await request(healthUrl, { headers: { Origin: allowedOrigin } });
  } catch (error) {
    fail(String(error));
    return;
  }
  const healthText = await health.text();
  if (health.status !== 200) {
    fail(`collab health returned HTTP ${health.status}: ${healthText.slice(0, 300)}`);
  } else {
    try {
      const payload = JSON.parse(healthText);
      if (payload?.ok !== true || !payload.collab) throw new Error("missing ok/collab health fields");
      pass(`collab health is healthy (rooms=${payload.collab.rooms}, connections=${payload.collab.connections})`);
    } catch (error) {
      fail(`collab health returned invalid JSON: ${error?.message ?? String(error)}`);
    }
  }
  const allowOrigin = health.headers.get("access-control-allow-origin");
  if (allowOrigin !== allowedOrigin) {
    fail(`allowed CORS origin mismatch: expected ${allowedOrigin}, got ${allowOrigin ?? "<none>"}`);
  } else {
    pass(`collab CORS allows exactly ${allowedOrigin}`);
  }

  let rejected;
  try {
    rejected = await request(healthUrl, { headers: { Origin: "https://kyx-invalid-origin.invalid" } });
  } catch (error) {
    fail(String(error));
    rejected = null;
  }
  if (rejected) {
    const rejectedBody = await rejected.text();
    if (rejected.status === 200 || rejected.headers.get("access-control-allow-origin")) {
      fail(`disallowed origin was accepted by collab health (HTTP ${rejected.status})`);
    } else {
      pass(`collab rejects disallowed origins (HTTP ${rejected.status}: ${rejectedBody.slice(0, 80)})`);
    }
  }

  const publicGallery = /^(1|true|yes)$/i.test(String(process.env.KYX_GALLERY_PUBLIC ?? ""));
  if (!publicGallery) {
    skip("gallery moderation checks — set KYX_GALLERY_PUBLIC=1 when the gallery is public");
    return;
  }
  const adminToken = String(process.env.KYX_GALLERY_ADMIN_TOKEN ?? "").trim();
  if (adminToken.length < 16) {
    fail("KYX_GALLERY_PUBLIC=1 requires KYX_GALLERY_ADMIN_TOKEN of at least 16 characters");
    return;
  }
  const reportsUrl = `${collabUrl}/api/admin/reports`;
  try {
    const noAuth = await request(reportsUrl, { headers: { Origin: allowedOrigin } });
    await noAuth.arrayBuffer();
    if (noAuth.status !== 401) fail(`admin reports without token returned HTTP ${noAuth.status}, expected 401`);
    else pass("gallery admin endpoint rejects missing credentials");

    const auth = await request(reportsUrl, {
      headers: { Origin: allowedOrigin, Authorization: `Bearer ${adminToken}` },
    });
    const authText = await auth.text();
    if (auth.status !== 200) {
      fail(`admin reports with configured token returned HTTP ${auth.status}: ${authText.slice(0, 200)}`);
    } else {
      pass("gallery admin endpoint accepts the configured token");
    }
  } catch (error) {
    fail(String(error));
  }
}

try {
  console.log(`[release-deployed-smoke] target=${deployUrl}`);
  await checkAppShell();
  await checkCollab();
} catch (error) {
  fail(error?.message ?? String(error));
}

if (failures.length > 0) {
  console.error(`[release-deployed-smoke] FAIL — ${failures.length} check(s)`);
  process.exitCode = 1;
} else {
  console.log("[release-deployed-smoke] PASS — deployed app-shell checks completed; inspect SKIP lines for optional services");
}
