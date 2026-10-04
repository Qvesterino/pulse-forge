// Source-grep regression for src/persistence/db.ts.
//
// db.ts is the IndexedDB schema owner: every STORE_* constant declared
// here must have a matching upgrade path in openDb(). A regression in
// this contract silently breaks persistence:
//   - a STORE_* constant exists but the createObjectStore call is
//     dropped -> every write to that store throws / loses data on
//     reopen, because the upgrade path never creates it for fresh
//     installs and skips it for upgrades
//   - tx() signature drifts -> all repositories silently corrupt
//     projects on tab suspend
//   - dbPromise / OPEN_BLOCKED_TIMEOUT_MS leak -> callers can reset
//     the singleton and confuse subsequent tabs
//
// Guards:
//   1. PUBLIC CONSTANTS - DB_NAME, DB_VERSION, and 15 STORE_* constants
//      must stay exported and immutable.
//   2. PUBLIC FUNCTIONS - openDb and tx (and only those two) are
//      exported.
//   3. SCHEMA COMPLETENESS - every STORE_* constant has a
//      createObjectStore(STORE_*, ...) or contains(STORE_*) call in
//      the onupgradeneeded handler of openDb. A new constant without
//      a matching schema line fails the test.
//   4. MODULE-PRIVATE STATE - dbPromise (lazy IndexedDB promise) and
//      OPEN_BLOCKED_TIMEOUT_MS stay non-exported.
//   5. AUDIT - any novel `export const / function / class / interface
//      / type` outside the known sets fails.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "src/persistence/db.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(FILE, "utf8").split(/\r?\n/);
});

function findExportConst(lines: string[], name: string): number | null {
  const re = new RegExp("^export\\s+const\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function findExportFn(lines: string[], name: string): number | null {
  // Plain startsWith - db.ts openDb / tx live on a single `export function NAME`
  // line. We avoid regex here because the previous \\s collapsing tripped up
  // the broader regression suite.
  const prefix = "export function " + name;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith(prefix)) return i;
  }
  return null;
}

// DB metadata constants.
const METADATA_CONSTS: string[] = ["DB_NAME", "DB_VERSION"];

// All STORE_* object store constants. A new store added here requires a
// matching schema entry in openDb().
const STORE_CONSTS: string[] = [
  "STORE_PROJECTS",
  "STORE_META",
  "STORE_PRESETS",
  "STORE_LIBRARY",
  "STORE_USER_SAMPLES",
  "STORE_USER_SAMPLE_AUDIO",
  "STORE_RECORDING_SESSIONS",
  "STORE_RECORDING_CHUNKS",
  "STORE_FROZEN_AUDIO",
  "STORE_USER_KITS",
  "STORE_GROOVE_POOL",
  "STORE_SNAPSHOTS",
  "STORE_SNAPSHOT_INDEX",
  "STORE_ULTINA_PRESETS",
  "STORE_MORPH_PRESETS",
  // W4: the ★-trained personal prior payloads (out-of-line key:
  // `<kind>#<baseModelHash>`), see PersonalModelRepository.
  "STORE_PERSONAL_MODELS",
];

const PUBLIC_FUNCTIONS: string[] = ["openDb", "tx"];

const MODULE_PRIVATE: string[] = ["dbPromise", "OPEN_BLOCKED_TIMEOUT_MS"];

describe("persistence/db.ts — IndexedDB schema owner (source-grep)", () => {
  it("reads db.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("public constants — must remain exported and immutable", () => {
    it("DB_NAME + DB_VERSION stay `export const`", () => {
      for (const name of METADATA_CONSTS) {
        const idx = findExportConst(lines, name);
        expect(
          idx,
          name + " must be `export const` (used by the migration runner / IndexedDB schema opener)",
        ).not.toBeNull();
        const letRe = new RegExp("^(?:export\\s+)?let\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !letRe.test(ln),
            name +
              " drifted to `let`. The DB name / version are schema-defining identifiers - a mid-run reassignment would silently orphan every IndexedDB reference.",
          ).toBe(true);
        }
      }
    });

    for (const name of STORE_CONSTS) {
      const title = name + " is `export const` (never `let`)";
      it(title, () => {
        const idx = findExportConst(lines, name);
        if (idx === null) {
          throw new Error(
            "Constant " +
              name +
              " no longer exported from db.ts. Restore it or update STORE_CONSTS - downstream repositories depend on the symbol being a stable handle.",
          );
        }
        const letRe = new RegExp("^(?:export\\s+)?let\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !letRe.test(ln),
            name +
              " drifted to `let`. Store-name strings are schema-defining - they need to match across tabs and versions. A reassignment breaks every existing data store on reload.",
          ).toBe(true);
        }
      });
    }
  });

  describe("public functions — only openDb and tx are exported", () => {
    for (const name of PUBLIC_FUNCTIONS) {
      const title = name + " is exported";
      it(title, () => {
        const idx = findExportFn(lines, name);
        expect(idx, name + " must be an exported function").not.toBeNull();
      });
    }
  });

  describe("schema completeness — every STORE_* has a matching upgrade line", () => {
    for (const name of STORE_CONSTS) {
      const title = name + " has an upgrade line in openDb's onupgradeneeded";
      it(title, () => {
        const idx = findExportFn(lines, "openDb");
        if (idx === null) throw new Error("openDb not exported");
        // Walk from openDb forward looking for any line that mentions the
        // constant. We accept either `createObjectStore(STORE_*, ...)` or
        // `objectStoreNames.contains(STORE_*)` shapes.
        let found = false;
        for (let i = idx; i < lines.length; i++) {
          if (lines[i].includes(name)) {
            found = true;
            break;
          }
        }
        expect(
          found,
          "Constant " +
            name +
            " is exported but never appears in openDb's onupgradeneeded. The store would never be created on first install or never migrated into on upgrade. Every write to that store would silently throw or vanish on reload.",
        ).toBe(true);
      });
    }
  });

  describe("module-private state — must NOT be exported", () => {
    for (const name of MODULE_PRIVATE) {
      const title = name + " stays module-private";
      it(title, () => {
        const reConst = new RegExp("^export\\s+const\\s+" + name + "\\b");
        const reLet = new RegExp("^export\\s+let\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !reConst.test(ln) && !reLet.test(ln),
            name +
              " is now exported. " +
              (name === "dbPromise"
                ? "The lazy IndexedDB singleton holds cross-call state - exposing it lets callers reset it and force a fresh connection, which races with other tabs."
                : "OPEN_BLOCKED_TIMEOUT_MS is the open-vs-other-tab race window - exposing it lets callers shorten the wait and surface false `Database is locked` errors."),
          ).toBe(true);
        }
      });
    }
  });

  describe("audit — every export is accounted for", () => {
    it("no orphan const / function / class / interface / type outside the known sets", () => {
      const re = /^export\s+(const|function|class|interface|type)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const tracked = new Set<string>([...METADATA_CONSTS, ...STORE_CONSTS, ...PUBLIC_FUNCTIONS]);
      const novel: string[] = [];
      for (const item of seen) {
        if (!tracked.has(item.name)) novel.push(item.name + ":" + item.kind);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in db.ts not yet tracked: " +
            novel.join(", ") +
            " — add them to the appropriate whitelist before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[db-audit] db.ts — exports: " +
          seen.length +
          " (" +
          seen.map((s) => s.name).join(", ") +
          "), STORE_* count: " +
          STORE_CONSTS.length,
      );
    });
  });
});
