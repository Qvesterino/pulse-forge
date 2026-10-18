/**
 * Pure TWA / Digital Asset Links config builder (ADR 0051).
 *
 * Kept free of filesystem access so tests can pin the identity and validation
 * rules. `generate-twa.mjs` owns the writes; this module owns what is valid.
 */

export const DEFAULT_PACKAGE_ID = "app.kyx.studio";
export const DEFAULT_VERSION_NAME = "1.0.0";
export const DEFAULT_VERSION_CODE = 1;

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const SHA256_RE = /^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{64}$/;

export function assertPackageId(packageId) {
  const value = String(packageId ?? "").trim();
  if (!PACKAGE_RE.test(value)) {
    throw new Error(
      `invalid Android package id "${value}" — expected reverse-DNS segments (letters, digits, underscore)`,
    );
  }
  return value;
}

/**
 * Accepts `https://host` or `https://host/mount/`. Returns the origin including
 * the mount path (no trailing slash), the TWA host and the start path.
 */
export function normalizeDeployOrigin(deployUrl) {
  const raw = String(deployUrl ?? "").trim();
  if (!raw) throw new Error("deploy URL is required (KYX_DEPLOY_URL)");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid deploy URL "${raw}"`);
  }
  if (url.protocol !== "https:") throw new Error("deploy URL must use https (TWA requires a trusted origin)");
  if (url.username || url.password) throw new Error("deploy URL must not contain credentials");
  if (url.search || url.hash) throw new Error("deploy URL must not contain a query or fragment");
  const path = url.pathname.replace(/\/+$/, "");
  const origin = `${url.origin}${path}`;
  return {
    origin,
    host: url.host,
    startUrl: `${path}/`,
    manifestUrl: `${origin}/manifest.webmanifest`,
    iconUrl: `${origin}/pwa-512x512.png`,
    maskableIconUrl: `${origin}/maskable-512x512.png`,
  };
}

export function normalizeSha256(fingerprint) {
  const raw = String(fingerprint ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!SHA256_RE.test(raw)) {
    throw new Error("SHA-256 certificate fingerprint must be 32 colon-separated hex pairs or 64 hex characters");
  }
  const hex = raw.replace(/:/g, "");
  return hex.match(/.{2}/g).join(":");
}

export function buildTwaManifest({
  deployUrl,
  packageId = DEFAULT_PACKAGE_ID,
  versionName = DEFAULT_VERSION_NAME,
  versionCode = DEFAULT_VERSION_CODE,
}) {
  const origin = normalizeDeployOrigin(deployUrl);
  const pkg = assertPackageId(packageId);
  const code = Number(versionCode);
  if (!Number.isInteger(code) || code < 1) throw new Error("versionCode must be a positive integer");
  return {
    packageId: pkg,
    host: origin.host,
    name: "KYX",
    launcherName: "KYX",
    display: "standalone",
    themeColor: "#0b0c10",
    navigationColor: "#0b0c10",
    backgroundColor: "#0b0c10",
    startUrl: origin.startUrl,
    iconUrl: origin.iconUrl,
    maskableIconUrl: origin.maskableIconUrl,
    webManifestUrl: origin.manifestUrl,
    appVersionName: String(versionName),
    appVersionCode: code,
    enableNotifications: false,
    enableSiteSettingsShortcut: true,
    fallbackType: "customtabs",
    generatorApp: "bubblewrap-cli",
    minSdkVersion: 21,
    orientation: "any",
    features: {},
    shortcuts: [],
  };
}

export function buildAssetLinks({ packageId = DEFAULT_PACKAGE_ID, sha256 }) {
  const pkg = assertPackageId(packageId);
  const fingerprint = normalizeSha256(sha256);
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: pkg,
        sha256_cert_fingerprints: [fingerprint],
      },
    },
  ];
}
