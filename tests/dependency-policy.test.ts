import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dependency policy is an invariant of the REPOSITORY, not of a machine.
 *
 * `npm ci` in CI runs with no flags and no personal .npmrc — it reads only the
 * repository's own configuration. For 134 consecutive runs (2026-09-19 →
 * 2026-10-21) every CI job died at `npm ci` in exactly 3 seconds with:
 *
 *   npm error code EUSAGE
 *   npm error Invalid: lock file's electron-builder-squirrel-windows@26.15.3
 *   npm error does not satisfy electron-builder-squirrel-windows@26.17.0
 *
 * The cause was a policy that lived on ONE developer machine: its user-level
 * .npmrc set `legacy-peer-deps=true`, so npm did not enforce peer ranges when
 * the lockfile was written, and the lock's shape came to depend on whose
 * machine wrote it. The repository now declares the policy itself.
 *
 * The lock invariant below is the same one npm checks, restricted to the
 * unambiguous case — peer dependencies that pin an EXACT version. Optional
 * peers are excluded because npm does not require them to be present.
 *
 * The predicate is proven able to go red: a synthetic lock with one violated
 * peer declaration is detected.
 */

const ROOT = path.resolve(__dirname, "..");

interface LockEntry {
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

type Lock = { packages: Record<string, LockEntry> };

const readLock = (): Lock => JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as Lock;

/** An exact version pin — the only peer range that needs no semver. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * npm's resolution walk: from a package path, look for `node_modules/<dep>` in
 * that path, then in each ancestor's node_modules, ending at the root.
 */
function resolveFrom(packages: Record<string, LockEntry>, fromPath: string, depName: string): string | null {
  let dir = fromPath;
  for (;;) {
    const candidate = `${dir ? `${dir}/` : ""}node_modules/${depName}`;
    const hit = packages[candidate];
    if (hit) return hit.version ?? null;
    if (!dir) return null;
    const idx = dir.lastIndexOf("/node_modules/");
    dir = idx === -1 ? "" : dir.slice(0, idx);
  }
}

/**
 * Every non-optional peer dependency that pins an exact version must be
 * present in the lock at exactly that version.
 */
function peerViolations(lock: Lock): string[] {
  const violations: string[] = [];
  for (const [pkgPath, entry] of Object.entries(lock.packages)) {
    const peers = entry.peerDependencies ?? {};
    const meta = entry.peerDependenciesMeta ?? {};
    for (const [depName, range] of Object.entries(peers)) {
      if (!EXACT_VERSION.test(range)) continue;
      if (meta[depName]?.optional) continue; // npm does not require optional peers
      const resolved = resolveFrom(lock.packages, pkgPath, depName);
      if (resolved !== range) {
        violations.push(
          `${pkgPath} requires peer ${depName}@${range}, but the lock resolves it to ${resolved ?? "(absent)"}`,
        );
      }
    }
  }
  return violations;
}

describe("the dependency policy", () => {
  it("is declared by the repository, not by a developer's machine", () => {
    const npmrcPath = path.join(ROOT, ".npmrc");
    expect(existsSync(npmrcPath), "the repository must declare its own npm policy in .npmrc").toBe(true);
    const npmrc = readFileSync(npmrcPath, "utf8");
    const declared = /^legacy-peer-deps\s*=\s*(.+)$/m.exec(npmrc);
    expect(declared, ".npmrc must declare legacy-peer-deps explicitly").not.toBeNull();
    expect(
      declared?.[1]?.trim(),
      "the policy must be npm's default (false): with legacy-peer-deps=true the lockfile's shape depends on whose machine wrote it",
    ).toBe("false");
  });

  it("keeps the committed lockfile in sync with the peer dependencies it declares", () => {
    const violations = peerViolations(readLock());
    expect(violations, `npm ci would reject this lock with EUSAGE:\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("can tell a satisfied peer declaration from a violated one", () => {
    // Negative control: the predicate must be able to go red. Without this, a
    // broken detector that always returns [] would pass the spec above.
    const broken: Lock = {
      packages: {
        "node_modules/app-builder-lib": {
          version: "26.17.0",
          peerDependencies: { "electron-builder-squirrel-windows": "26.17.0" },
        },
        "node_modules/electron-builder-squirrel-windows": { version: "26.15.3" },
      },
    };
    const violations = peerViolations(broken);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("electron-builder-squirrel-windows@26.17.0");
    expect(violations[0]).toContain("26.15.3");
  });
});
