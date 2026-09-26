// Source-grep regression for src/persistence/UserSampleRepository.ts.
//
// UserSampleRepository backs the user's uploaded / recorded samples -
// a smaller universe than ProjectRepository but the same IndexedDB
// discipline applies: every mutation goes through `tx()`, every
// public method has a stable return shape, and the helper functions
// around it (userSampleId, recordedTakeSampleId, ...) own their
// naming so a UUID drift never desyncs the two stores.
//
// Guards:
//   1. PUBLIC INTERFACES - UserSampleAsset, UserSampleAudio,
//      PcmRecordingAudioRef must stay `export interface`.
//   2. PUBLIC HELPERS - isPcmRecordingAudio, userSampleId,
//      recordedTakeSampleId, restoreUserSampleAudioMemoized stay
//      `export function`.
//   3. PUBLIC CLASS - UserSampleRepository is exported as a class
//      with 5 public methods (list, save, loadAudio, listAudio,
//      remove).
//   4. TRANSACTION GUARD - the mutating methods (save, remove)
//      must each contain a tx(...) call.
//   5. INTERNAL NOT-EXPORTED - isBlob, defaultDecodeAudioBytes stay
//      module-private.
//   6. MODULE-PRIVATE STATE - the restoreByBank WeakMap stays
//      non-exported.
//   7. AUDIT - any novel export outside the known sets fails.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "src/persistence/UserSampleRepository.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(FILE, "utf8").split(/\r?\n/);
});

function findExport(lines: string[], kind: "class" | "interface" | "function" | "const", name: string): number | null {
  const prefix = "export " + kind + " " + name;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith(prefix)) return i;
  }
  return null;
}

function findClassMethod(lines: string[], classIdx: number, methodName: string, visibility: "public" | "private"): number | null {
  const explicitRe = new RegExp("^\\s+(public|private)\\s+(?:async\\s+)?" + methodName + "\\s*\\(");
  const implicitRe = new RegExp("^\\s+(?:async\\s+)?" + methodName + "\\s*\\(");
  for (let i = classIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (visibility === "public") {
      if (explicitRe.test(ln) && /^\s+public\s+/.test(ln)) return i;
      if (!/^\s+private\s+/.test(ln) && implicitRe.test(ln)) return i;
    } else {
      if (explicitRe.test(ln) && /^\s+private\s+/.test(ln)) return i;
    }
  }
  return null;
}

function readBody(lines: string[], startIdx: number): string[] {
  let openParens = 0;
  let bodyStart = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    for (const c of ln) {
      if (c === "(") openParens++;
      else if (c === ")") openParens--;
    }
    if (openParens <= 0 && /\{/.test(ln)) {
      bodyStart = i;
      break;
    }
  }
  if (bodyStart < 0) return [];
  const buf: string[] = [];
  let depth = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    const ln = lines[i];
    depth += (ln.match(/\{/g) || []).length;
    depth -= (ln.match(/\}/g) || []).length;
    buf.push(ln);
    if (depth <= 0) break;
  }
  return buf;
}

const PUBLIC_INTERFACES: string[] = [
  "UserSampleAsset",
  "UserSampleAudio",
  "PcmRecordingAudioRef",
];

const PUBLIC_HELPERS: string[] = [
  "isPcmRecordingAudio",
  "userSampleId",
  "recordedTakeSampleId",
  "restoreUserSampleAudioMemoized",
];

const INTERNAL_HELPERS: string[] = [
  "isBlob",
  "defaultDecodeAudioBytes",
];

const MODULE_STATE: string[] = ["restoreByBank"];

const CLASS_API_PUBLIC: string[] = ["list", "save", "loadAudio", "listAudio", "remove"];

const TX_REQUIRED_METHODS: string[] = ["save", "remove"];

describe("persistence/UserSampleRepository.ts — user-sample contract (source-grep)", () => {
  it("reads UserSampleRepository.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("public interfaces — must stay `export interface`", () => {
    for (const name of PUBLIC_INTERFACES) {
      const title = name + " is an exported interface";
      it(title, () => {
        const idx = findExport(lines, "interface", name);
        expect(idx, name + " must be `export interface`").not.toBeNull();
        const classIdx = findExport(lines, "class", name);
        expect(classIdx, name + " must not drift to `export class`").toBeNull();
      });
    }
  });

  describe("public helper functions — must stay exported", () => {
    for (const name of PUBLIC_HELPERS) {
      const title = name + " is an exported function";
      it(title, () => {
        const idx = findExport(lines, "function", name);
        expect(
          idx,
          name + " must be `export function` — drop-routes from the project store and the sample library depend on this symbol reaching other modules.",
        ).not.toBeNull();
      });
    }
  });

  describe("public class — UserSampleRepository surface", () => {
    it("class is exported", () => {
      const idx = findExport(lines, "class", "UserSampleRepository");
      expect(idx, "UserSampleRepository must be `export class`").not.toBeNull();
    });

    describe("public methods — stay on the class", () => {
      for (const method of CLASS_API_PUBLIC) {
        const title = "UserSampleRepository." + method + " is a public method";
        it(title, () => {
          const classIdx = findExport(lines, "class", "UserSampleRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          expect(
            methodIdx,
            "UserSampleRepository." + method + " missing or drifted to private/static.",
          ).not.toBeNull();
        });
      }
    });

    describe("transaction guard — mutating methods must use tx(...)", () => {
      for (const method of TX_REQUIRED_METHODS) {
        const title = "UserSampleRepository." + method + " body uses tx(...)";
        it(title, () => {
          const classIdx = findExport(lines, "class", "UserSampleRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          if (methodIdx === null) throw new Error("method " + method + " missing");
          const body = readBody(lines, methodIdx);
          const matches = body.filter((ln) => /\btx\s*\(/.test(ln));
          expect(
            matches.length,
            "UserSampleRepository." + method + " must open its work via tx(...). Found " +
              matches.length +
              " tx(...) call site(s).",
          ).toBeGreaterThan(0);
        });
      }
    });
  });

  describe("internal helpers — must NOT be exported", () => {
    for (const name of INTERNAL_HELPERS) {
      const title = name + " stays a non-exported internal helper";
      it(title, () => {
        const reExp = new RegExp("^export\\s+function\\s+" + name + "\\b");
        const reClass = new RegExp("^export\\s+class\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !reExp.test(ln) && !reClass.test(ln),
            name + " is now exported from UserSampleRepository.ts. isBlob is a type predicate, defaultDecodeAudioBytes is a one-shot decoder — both are implementation details that callers should not couple to.",
          ).toBe(true);
        }
      });
    }
  });

  describe("module-private state — must NOT be exported", () => {
    it("restoreByBank WeakMap stays module-private", () => {
      const reExp = new RegExp("^export\\s+const\\s+restoreByBank\\b");
      const reLet = new RegExp("^export\\s+let\\s+restoreByBank\\b");
      for (const ln of lines) {
        expect(
          !reExp.test(ln) && !reLet.test(ln),
          "restoreByBank is now exported. The WeakMap of sample-bank restore promises is a memoization cache - exposing it lets callers reset in-flight restores and trigger concurrent re-issuance of the same restore.",
        ).toBe(true);
      }
    });
  });

  describe("audit — every export is accounted for", () => {
    it("no orphan const / function / class / interface / type outside the known sets", () => {
      const re = /^export\s+(const|function|class|interface|type)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const tracked = new Set<string>([
        ...PUBLIC_INTERFACES,
        ...PUBLIC_HELPERS,
        "UserSampleRepository",
      ]);
      const novel: string[] = [];
      for (const item of seen) {
        if (!tracked.has(item.name)) novel.push(item.name + ":" + item.kind);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in UserSampleRepository.ts not yet tracked: " +
            novel.join(", ") +
            " — add them to the appropriate whitelist before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[user-sample-audit] UserSampleRepository.ts — exports: " +
          seen.length +
          " (" +
          seen.map((s) => s.name).join(", ") +
          "), public methods: " +
          CLASS_API_PUBLIC.length,
      );
    });
  });
});
