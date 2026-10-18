import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AGENT MAP GATE (Package 4, 2026-10-17)
 *
 * A map nobody checks is a map that lies. This gate parses `docs/AGENT-MAP.md`
 * and fails when:
 *   - a "Start with" / "Guarded by" path stops existing,
 *   - a gate cell names an npm script that no longer exists,
 *   - an invariant row loses its guard (the guard file must contain `expect(`),
 *   - a table is gutted below its floor,
 *   - `AGENTS.md` stops pointing at the map (discoverability).
 *
 * The validation is a pure function so its own teeth are testable: a bogus map
 * with a missing path and an unknown script MUST report both.
 */

const ROOT = resolve(__dirname, "..");

const ROUTING_FLOOR = 10;
const INVARIANT_FLOOR = 12;

interface MapRow {
  cells: string[];
}

function rowsOfSection(markdown: string, heading: string): MapRow[] {
  const start = markdown.indexOf(heading);
  if (start < 0) return [];
  const body = markdown.slice(start + heading.length);
  const rows: MapRow[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" && rows.length > 0) break;
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue; // separator row
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    // Skip the markdown header row (either table's first cell).
    if (cells.length > 0 && cells[0] !== "I need to…" && cells[0] !== "Invariant") rows.push({ cells });
  }
  return rows;
}

/** Backticked tokens of a cell, in order. */
function tokensOf(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

export interface MapValidation {
  errors: string[];
}

export function validateAgentMap(
  markdown: string,
  options: {
    exists: (path: string) => boolean;
    read: (path: string) => string;
    scripts: ReadonlySet<string>;
  },
): MapValidation {
  const errors: string[] = [];
  const pathLike = (token: string) => token.includes("/") || /\.[a-z]+$/.test(token);

  /** A cell token is either a bare path, a bare script name, or a shell command. */
  const validateToken = (token: string, where: string) => {
    const words = token.split(/\s+/).filter((word) => word.length > 0);
    if (words[0] === "npm" && words[1] === "run") {
      const script = words[2];
      if (!script || !options.scripts.has(script)) {
        errors.push(`${where} references an unknown npm script: ${token}`);
      }
      return;
    }
    if (words.length > 1) {
      // A shell command: every path-like word after the command must exist.
      for (const word of words.slice(1)) {
        if (pathLike(word) && !options.exists(word)) {
          errors.push(`${where} references a missing path: ${word} (in "${token}")`);
        }
      }
      return;
    }
    if (options.exists(token)) return;
    if (options.scripts.has(token)) return;
    errors.push(`${where} references a missing path or script: ${token}`);
  };

  const routing = rowsOfSection(markdown, "## 2. Task routing");
  if (routing.length < ROUTING_FLOOR) {
    errors.push(`routing table has ${routing.length} rows — floor is ${ROUTING_FLOOR}`);
  }
  for (const row of routing) {
    const cells = row.cells;
    if (cells.length !== 3) {
      errors.push(`routing row has ${cells.length} cells: ${cells.join(" | ")}`);
      continue;
    }
    for (const token of [...tokensOf(cells[1]), ...tokensOf(cells[2])]) {
      if (!pathLike(token) && !/^npm run /.test(token)) continue; // deliberate prose token (e.g. SCHEMA_VERSION)
      validateToken(token, "routing");
    }
  }

  const invariants = rowsOfSection(markdown, "## 3. Invariant register");
  if (invariants.length < INVARIANT_FLOOR) {
    errors.push(`invariant register has ${invariants.length} rows — floor is ${INVARIANT_FLOOR}`);
  }
  for (const row of invariants) {
    if (row.cells.length !== 3) {
      errors.push(`invariant row has ${row.cells.length} cells: ${row.cells.join(" | ")}`);
      continue;
    }
    const guards = tokensOf(row.cells[1]);
    if (guards.length === 0) {
      errors.push(`invariant without a guard: ${row.cells[0].slice(0, 60)}`);
      continue;
    }
    for (const guard of guards) {
      if (!options.exists(guard)) {
        errors.push(`guard does not exist: ${guard}`);
        continue;
      }
      let body = "";
      try {
        body = options.read(guard);
      } catch {
        body = "";
      }
      if (!body.includes("expect(")) errors.push(`guard has no assertion: ${guard}`);
    }
  }

  return { errors };
}

const scripts = new Set(
  Object.keys(
    (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts,
  ),
);
const fileExists = (path: string) => existsSync(resolve(ROOT, path));
const readText = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("agent map gate", () => {
  it("AGENTS.md points every future agent at the map", () => {
    expect(readText("AGENTS.md")).toContain("AGENT-MAP.md");
  });

  it("every path, script and guard in the map is real", () => {
    const markdown = readText("docs/AGENT-MAP.md");
    const { errors } = validateAgentMap(markdown, { exists: fileExists, read: readText, scripts });
    expect(errors, "the map drifted from the tree — fix the map or the reference it points at").toEqual([]);
  });

  it("NEGATIVE: the validator catches a missing path, an unknown script and a gutted table", () => {
    const bogus = [
      "## 2. Task routing — “I need to change X”",
      "| I need to… | Start with | Run before done |",
      "| --- | --- | --- |",
      "| Fix the thing | `src/does-not-exist.ts` | `npm run no-such-script` |",
      "",
      "## 3. Invariant register — hard-won truths and their guards",
      "| Invariant | Guarded by | Why it exists |",
      "| --- | --- | --- |",
      "| Something true | `tests/golden-doctor.test.ts` | because |",
      "",
    ].join("\n");
    const { errors } = validateAgentMap(bogus, { exists: fileExists, read: readText, scripts });
    expect(errors.some((error) => error.includes("src/does-not-exist.ts"))).toBe(true);
    expect(errors.some((error) => error.includes("no-such-script"))).toBe(true);
    expect(errors.some((error) => error.includes("floor is"))).toBe(true);
  });

  it("NEGATIVE: a guard file without assertions is refused", () => {
    const mapWithWeakGuard = [
      "## 2. Task routing — “I need to change X”",
      "| I need to… | Start with | Run before done |",
      "| --- | --- | --- |",
      ...Array.from(
        { length: ROUTING_FLOOR },
        (_, i) => `| task ${i} | \`src/audio-engine/AudioEngine.ts\` | \`npm run typecheck\` |`,
      ),
      "",
      "## 3. Invariant register — hard-won truths and their guards",
      "| Invariant | Guarded by | Why it exists |",
      "| --- | --- | --- |",
      ...Array.from({ length: INVARIANT_FLOOR }, (_, i) => `| invariant ${i} | \`docs/AGENT-MAP.md\` | because |`),
      "",
    ].join("\n");
    const { errors } = validateAgentMap(mapWithWeakGuard, { exists: fileExists, read: readText, scripts });
    expect(errors.some((error) => error.includes("has no assertion"))).toBe(true);
  });
});
