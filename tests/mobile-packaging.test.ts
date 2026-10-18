import {
  DEFAULT_PACKAGE_ID,
  assertPackageId,
  buildAssetLinks,
  buildTwaManifest,
  normalizeDeployOrigin,
  normalizeSha256,
} from "../scripts/mobile/twa-config.mjs";
import { describe, expect, it } from "vitest";

const SHA = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99";

describe("TWA manifest generation (ADR 0051)", () => {
  it("derives host, start URL and icon URLs from the deployed origin", () => {
    const manifest = buildTwaManifest({ deployUrl: "https://kyx.example" });
    expect(manifest.packageId).toBe(DEFAULT_PACKAGE_ID);
    expect(manifest.host).toBe("kyx.example");
    expect(manifest.startUrl).toBe("/");
    expect(manifest.iconUrl).toBe("https://kyx.example/pwa-512x512.png");
    expect(manifest.maskableIconUrl).toBe("https://kyx.example/maskable-512x512.png");
    expect(manifest.webManifestUrl).toBe("https://kyx.example/manifest.webmanifest");
    expect(manifest.display).toBe("standalone");
    expect(manifest.themeColor).toBe("#0b0c10");
    expect(manifest.enableNotifications).toBe(false);
  });

  it("keeps an ecosystem mount inside the start URL and asset URLs", () => {
    const manifest = buildTwaManifest({ deployUrl: "https://kyx.example/kyx/" });
    expect(manifest.host).toBe("kyx.example");
    expect(manifest.startUrl).toBe("/kyx/");
    expect(manifest.iconUrl).toBe("https://kyx.example/kyx/pwa-512x512.png");
    expect(manifest.webManifestUrl).toBe("https://kyx.example/kyx/manifest.webmanifest");
  });

  it("rejects insecure, credential-bearing or query/fragment origins", () => {
    expect(() => normalizeDeployOrigin("http://kyx.example")).toThrow(/https/);
    expect(() => normalizeDeployOrigin("https://user:pass@kyx.example")).toThrow(/credentials/);
    expect(() => normalizeDeployOrigin("https://kyx.example/?x=1")).toThrow(/query|fragment/);
    expect(() => normalizeDeployOrigin("not a url")).toThrow(/invalid/);
  });

  it("requires a reverse-DNS Android package id", () => {
    expect(assertPackageId("app.kyx.studio")).toBe("app.kyx.studio");
    expect(assertPackageId("com.example.kyx_mobile")).toBe("com.example.kyx_mobile");
    expect(() => assertPackageId("kyx")).toThrow(/package id/);
    expect(() => assertPackageId("app..kyx")).toThrow(/package id/);
    expect(() => assertPackageId("1app.kyx")).toThrow(/package id/);
  });

  it("rejects a non-positive version code", () => {
    expect(() => buildTwaManifest({ deployUrl: "https://kyx.example", versionCode: 0 })).toThrow(/versionCode/);
    expect(() => buildTwaManifest({ deployUrl: "https://kyx.example", versionCode: 1.5 })).toThrow(/versionCode/);
  });
});

describe("Digital Asset Links generation", () => {
  it("normalizes the SHA-256 fingerprint and names the Android package", () => {
    const links = buildAssetLinks({ packageId: "app.kyx.studio", sha256: SHA });
    expect(links).toHaveLength(1);
    expect(links[0].relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(links[0].target.namespace).toBe("android_app");
    expect(links[0].target.package_name).toBe("app.kyx.studio");
    expect(links[0].target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(links[0].target.sha256_cert_fingerprints[0]).toBe(SHA.toUpperCase());
  });

  it("accepts an unseparated 64-hex fingerprint", () => {
    expect(normalizeSha256(SHA.replace(/:/g, ""))).toBe(SHA.toUpperCase());
  });

  it("rejects a malformed or truncated fingerprint", () => {
    expect(() => normalizeSha256("AA:BB:CC")).toThrow(/SHA-256/);
    expect(() => normalizeSha256("")).toThrow(/SHA-256/);
    expect(() => normalizeSha256("ZZ".repeat(32))).toThrow(/SHA-256/);
  });

  it("rejects an invalid package id in asset links too", () => {
    expect(() => buildAssetLinks({ packageId: "kyx", sha256: SHA })).toThrow(/package id/);
  });
});
