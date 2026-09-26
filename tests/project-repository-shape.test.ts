// Source-grep regression for src/persistence/ProjectRepository.ts.
//
// ProjectRepository is the IndexedDB-backed persistence contract: every
// mutation goes through a transaction opened via the shared `tx()` helper
// from db.ts. A regression that:
//   - bypasses `tx()` (writes outside a transaction) breaks atomicity
//     and silently corrupts the project graph
//   - drops migration through migrateProject / validateProjectShape
//     re-loads a doc that fails the runtime shape checks
//   - exposes KEY_RECENT externally lets callers corrupt the
//     "Continue last project" pointer
//   - promotes the metaOf helper to an export lets UI build the
//     SavedProjectMeta shape directly and skip the doc-validating
//     path
//
// Guards:
//   1. PUBLIC CLASS - ProjectRepository is exported; its surface
//      methods stay on the class (not module-level functions).
//   2. RETURN-SHAPE COVERAGE - the methods that callers rely on
//      stay declared with the right return type:
//        save -> Promise<void>
//        load -> Promise<ProjectDocument | null>
//        listAll -> Promise<SavedProjectMeta[]>
//        delete -> Promise<void>
//        loadMostRecent -> Promise<ProjectDocument | null>
//   3. PUBLIC INTERFACES - SavedProjectMeta + IncompatibleProjectMeta
//      stay `export interface`.
//   4. INTERNAL NOT-EXPORTED - metaOf, KEY_RECENT stay private to
//      the module. safeMigrate + db() stay private methods on the
//      class.
//   5. STORAGE PATH - mutating methods (save, delete, rename,
//      duplicate) must each contain a `tx(` call. A regression
//      that opens the raw `db.transaction(...)` or calls
//      IDBDatabase directly would lose atomicity.
//   6. AUDIT - any novel `export class/function/interface/const`
//      outside the known sets fails.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "src/persistence/ProjectRepository.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(FILE, "utf8").split(/\r?\n/);
});

function findExport(lines: string[], kind: "class" | "interface" | "function" | "const", name: string): number | null {
  const re = new RegExp("^export\\s+" + kind + "\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function findAny(lines: string[], kind: "class" | "interface" | "function" | "const", name: string): number | null {
  const re = new RegExp("^(?:export\\s+)?" + kind + "\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function findClassMethod(lines: string[], classIdx: number, methodName: string, visibility?: "public" | "private"): number | null {
  // In TypeScript classes, methods without an explicit visibility modifier
  // are public by default. Match either `<vis> METHOD(` (where <vis> is the
  // explicit modifier) or the no-modifier form when looking for public.
  const explicitRe = new RegExp("^\\s+(public|private)\\s+(?:async\\s+)?" + methodName + "\\s*\\(");
  const implicitRe = new RegExp("^\\s+(?:async\\s+)?" + methodName + "\\s*\\(");
  for (let i = classIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (visibility === "public") {
      // Accept explicit `public` OR no-modifier (default public). Reject `private`.
      if (explicitRe.test(ln) && /^\s+public\s+/.test(ln)) return i;
      if (!/^\s+private\s+/.test(ln) && implicitRe.test(ln)) return i;
    } else if (visibility === "private") {
      if (explicitRe.test(ln) && /^\s+private\s+/.test(ln)) return i;
    } else {
      if (explicitRe.test(ln) || implicitRe.test(ln)) return i;
    }
  }
  return null;
}

function readSignature(lines: string[], startIdx: number, maxLines = 12): string {
  let sig = "";
  let openParens = 0;
  let started = false;
  let i = startIdx;
  while (i < lines.length && i - startIdx < maxLines) {
    sig += lines[i] + "\n";
    for (const c of lines[i]) {
      if (c === "(") {
        openParens++;
        started = true;
      } else if (c === ")") openParens--;
    }
    if (started && openParens === 0 && /\)(\s*:|\s*\{)/.test(lines[i])) return sig;
    i++;
  }
  return sig;
}

function signatureDeclaresReturn(sig: string, typeName: string): boolean {
  // Accept either `): Promise<Type>` or `: Promise<Type>` union.
  const re = new RegExp("Promise\\s*<\\s*" + typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
  return re.test(sig);
}

function readMethodBody(lines: string[], startIdx: number): string[] {
  // Find the opening `{` of the method on signature lines, then walk braces.
  let inBody = false;
  let depth = 0;
  const buf: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    if (!inBody) {
      if (/^\s*\)\s*\{/.test(ln) || /\)\s*\{/.test(ln)) {
        inBody = true;
        depth = 1;
        buf.push(ln);
        continue;
      }
      // Walk forward through the signature.
      buf.push(ln);
      continue;
    }
    depth += (ln.match(/\{/g) || []).length;
    depth -= (ln.match(/\}/g) || []).length;
    buf.push(ln);
    if (depth <= 0) break;
  }
  return buf;
}

const CLASS_API_PUBLIC: string[] = [
  "save",
  "load",
  "listAll",
  "listIncompatible",
  "referencedFrozenBufferIds",
  "delete",
  "rename",
  "duplicate",
  "loadMostRecent",
];

const CLASS_API_PRIVATE: string[] = ["db", "safeMigrate"];

const INTERFACES: string[] = ["SavedProjectMeta", "IncompatibleProjectMeta"];

const MODULE_PRIVATE: string[] = ["KEY_RECENT", "metaOf"];

// Methods that must perform storage I/O through the shared `tx(` helper.
// Each method's body must contain a `tx(` substring.
const TX_REQUIRED_METHODS: string[] = ["save", "delete", "rename", "duplicate"];

describe("persistence/ProjectRepository.ts — IndexedDB contract (source-grep)", () => {
  it("reads ProjectRepository.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("public class — ProjectRepository surface", () => {
    it("class is exported", () => {
      const idx = findExport(lines, "class", "ProjectRepository");
      expect(idx, "ProjectRepository must be exported as a class").not.toBeNull();
    });

    describe("public methods — stay on the class with stable signatures", () => {
      for (const method of CLASS_API_PUBLIC) {
        const title = "ProjectRepository." + method + " is a public method";
        it(title, () => {
          const classIdx = findExport(lines, "class", "ProjectRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          expect(
            methodIdx,
            "ProjectRepository." + method + " missing or drifted to private/static. Callers chain off this method on the project service.",
          ).not.toBeNull();
        });
      }
    });

    describe("private methods — stay private", () => {
      for (const method of CLASS_API_PRIVATE) {
        const title = "ProjectRepository." + method + " stays private";
        it(title, () => {
          const classIdx = findExport(lines, "class", "ProjectRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "private");
          expect(
            methodIdx,
            "ProjectRepository." + method + " must be `private` so its IndexedDB-lifecycle state stays encapsulated.",
          ).not.toBeNull();
          // Must NOT have a public override.
          const pubIdx = findClassMethod(lines, classIdx, method, "public");
          expect(
            pubIdx,
            "ProjectRepository." + method + " now has a public override. The private helper holds db-promise caching / schema-migration logic that should not be reachable from the public API.",
          ).toBeNull();
        });
      }
    });

    describe("return-shape coverage — selected public methods", () => {
      const checkReturn = (method: string, expectedReturn: string): void => {
        it("ProjectRepository." + method + " returns " + expectedReturn, () => {
          const classIdx = findExport(lines, "class", "ProjectRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          if (methodIdx === null) throw new Error("method " + method + " missing");
          const sig = readSignature(lines, methodIdx);
          expect(
            signatureDeclaresReturn(sig, expectedReturn),
            "ProjectRepository." + method + " must return Promise<" + expectedReturn + ">. Got:\n" + sig,
          ).toBe(true);
        });
      };
      checkReturn("save", "void");
      checkReturn("load", "ProjectDocument");
      checkReturn("listAll", "SavedProjectMeta");
      checkReturn("delete", "void");
      checkReturn("loadMostRecent", "ProjectDocument");
    });

    describe("transaction guard — mutating methods must use tx(...)", () => {
      for (const method of TX_REQUIRED_METHODS) {
        const title = "ProjectRepository." + method + " body uses tx(...)";
        it(title, () => {
          const classIdx = findExport(lines, "class", "ProjectRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          if (methodIdx === null) throw new Error("method " + method + " missing");
          const body = readMethodBody(lines, methodIdx);
          const matches = body.filter((ln) => /\btx\s*\(/.test(ln));
          expect(
            matches.length,
            "ProjectRepository." + method + " must open its work via the shared `tx(...)` helper. Found " +
              matches.length +
              " tx(...) call site(s) — opening the transaction by hand or calling IDBDatabase directly would lose atomicity and risk corrupting the project graph on a tab suspend.",
          ).toBeGreaterThan(0);
        });
      }
    });
  });

  describe("public interfaces — stay exported", () => {
    for (const name of INTERFACES) {
      const title = name + " is an exported interface";
      it(title, () => {
        const idx = findExport(lines, "interface", name);
        expect(idx, name + " must be `export interface`").not.toBeNull();
        // Not a class drift.
        const classIdx = findExport(lines, "class", name);
        expect(classIdx, name + " must not drift to `export class`").toBeNull();
      });
    }
  });

  describe("module-private state — must NOT be exported", () => {
    for (const name of MODULE_PRIVATE) {
      const title = name + " stays module-private";
      it(title, () => {
        const reConst = new RegExp("^export\\s+const\\s+" + name + "\\b");
        const reFn = new RegExp("^export\\s+function\\s+" + name + "\\b");
        const reClass = new RegExp("^export\\s+class\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !reConst.test(ln) && !reFn.test(ln) && !reClass.test(ln),
            name + " is now exported from ProjectRepository.ts. " +
              (name === "KEY_RECENT"
                ? "The recent-project pointer is a module-private slot — exposing it lets callers corrupt the resume state without going through save."
                : "metaOf converts a ProjectDocument to its meta shape only when migration passes — exposing it bypasses the migration gate."),
          ).toBe(true);
        }
        const anyIdx = findAny(lines, "const", name) || findAny(lines, "function", name);
        expect(anyIdx, name + " must still exist in ProjectRepository.ts").not.toBeNull();
      });
    }
  });

  describe("audit — every export class/function/interface/const is accounted for", () => {
    it("no orphan outside the known sets", () => {
      const re = /^export\s+(class|function|interface|const|type)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const tracked = new Set<string>([
        "ProjectRepository",
        ...INTERFACES,
      ]);
      const novel: string[] = [];
      for (const item of seen) {
        if (!tracked.has(item.name)) novel.push(item.name + ":" + item.kind);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in ProjectRepository.ts not yet tracked: " +
            novel.join(", ") +
            " — add to INTERFACES or a new tracked-set before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[repository-audit] ProjectRepository.ts — exports: " +
          seen.length +
          " (" +
          seen.map((s) => s.name).join(", ") +
          "), public methods: " +
          CLASS_API_PUBLIC.length +
          ", private methods: " +
          CLASS_API_PRIVATE.length,
      );
    });
  });
});
