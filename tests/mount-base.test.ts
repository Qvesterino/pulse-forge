import { afterEach, describe, expect, it, vi } from "vitest";

import { appUrl, stripBasePath } from "../src/shared/mountBase";

/**
 * Subpath-mount helpers (Qvester Studio ecosystem mount, STUDIO_APP_BASE).
 * The standalone root deployment must stay byte-for-byte unchanged: both
 * helpers are no-ops when the base is "/".
 */
describe("stripBasePath", () => {
  it("is a no-op for the root deployment", () => {
    expect(stripBasePath("/studio", "/")).toBe("/studio");
    expect(stripBasePath("/", "/")).toBe("/");
  });

  it("strips the mount prefix from routed paths", () => {
    expect(stripBasePath("/pulse-forge/studio", "/pulse-forge/")).toBe("/studio");
    expect(stripBasePath("/pulse-forge/?x=1".split("?")[0]!, "/pulse-forge/")).toBe("/");
    expect(stripBasePath("/pulse-forge", "/pulse-forge/")).toBe("/");
  });

  it("leaves foreign paths alone (defensive — server already routed them)", () => {
    expect(stripBasePath("/elsewhere", "/pulse-forge/")).toBe("/elsewhere");
  });

  it("tolerates a base without trailing slash", () => {
    expect(stripBasePath("/pulse-forge/studio", "/pulse-forge")).toBe("/studio");
  });
});

describe("appUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is verbatim on the root deployment", () => {
    vi.stubEnv("BASE_URL", "/");
    expect(appUrl("/studio")).toBe("/studio");
    expect(appUrl("/?import=abc")).toBe("/?import=abc");
  });

  it("prefixes the mount base for hrefs and share links", () => {
    vi.stubEnv("BASE_URL", "/pulse-forge/");
    expect(appUrl("/studio")).toBe("/pulse-forge/studio");
    expect(appUrl("/?import=abc")).toBe("/pulse-forge/?import=abc");
    expect(appUrl("/embed/")).toBe("/pulse-forge/embed/");
  });

  it("passes non-absolute paths through untouched", () => {
    vi.stubEnv("BASE_URL", "/pulse-forge/");
    expect(appUrl("https://elsewhere.example/x")).toBe("https://elsewhere.example/x");
  });
});
