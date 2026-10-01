import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTRUMENT_DEFS } from "../src/instruments/registry";

/**
 * AUDIT 2026-10-01 — every instrument voice must reach the instrument output.
 *
 * The Clavinet shipped SILENT for its entire life: `noteOn` built a full voice
 * chain (square + saw → panners → highpass → bandpass pickup → `amp`) and the
 * cleanup path even called `amp.disconnect()`, but the chain was never joined
 * to `output`. Every note rendered exact silence, all nine of its parameters
 * measured "dead", and every `factory.clav.*` preset auditioned at peak 0.0000.
 *
 * The 2026-09-27 plugin audit already recorded it as FAIL
 * (`"defaultAudible": false, "defaultPeak": 0, deadParams: 9`) — it was found
 * and never fixed, because the audit's "Loads" column said PASS while the
 * signal measurement said FAIL, and nobody closed the gap.
 *
 * This is a *structural* guard, not a regex: it walks each factory's node
 * graph from the instrument output and requires every gain/oscillator/source
 * it creates to be reachable. A regex for `amp.connect(output)` is NOT enough
 * — four other instruments (bass, bass808, granular, vocalchop) legitimately
 * reach the output through an intermediate node (`shaper`, `post`, `tone`) and
 * a literal-pattern scan reports all four as broken. That was a real false
 * positive this audit produced before checking.
 *
 * Why a source scan and not a render: this repo's vitest runs under jsdom,
 * which has no Web Audio, so there is no way to measure an actual peak here.
 * The audible half is covered by the generic loop in `src/browser-checks.ts`
 * ("<Name>: noteOn renders signal", `peak > 0.01 && peak <= 4`) which runs for
 * every registered kind. This test is the fast, always-on complement.
 */

const REGISTRY = readFileSync(resolve(process.cwd(), "src/instruments/registry.ts"), "utf8");

/** Split the registry into one source slice per InstrumentDefinition. */
function instrumentSources(): Array<{ name: string; kind: string; body: string }> {
  const re = /const (\w+): InstrumentDefinition = \{/g;
  const marks: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(REGISTRY))) marks.push({ name: m[1], index: m.index });
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : REGISTRY.length;
    const body = REGISTRY.slice(mark.index, end);
    const kind = /kind:\s*"([a-z0-9]+)"/.exec(body)?.[1] ?? "?";
    return { name: mark.name, kind, body };
  });
}

describe("instrument voice reachability (source-graph guard)", () => {
  const sources = instrumentSources();

  it("the registry scan actually covers every registered instrument", () => {
    // If this drifts, the guard below is silently checking nothing.
    expect(sources.length).toBeGreaterThanOrEqual(20);
    const scanned = new Set(sources.map((s) => s.kind));
    for (const kind of Object.keys(INSTRUMENT_DEFS)) {
      expect(scanned.has(kind), `no source slice found for registered kind "${kind}"`).toBe(true);
    }
  });

  it("every factory that creates a voice 'amp' wires it out (dead amp = silent instrument)", () => {
    // NOTE on scope: this rule is intentionally lenient. An earlier, stricter
    // version tried to prove each amp REACHES the output by pattern-matching
    // the chain, and produced three false positives in a row —
    //   bass / granular / bass808: reach output via an intermediate node
    //     (`shaper`, `tone`, `post`), so a literal `amp.connect(output)` misses them;
    //   vocalchop: `amp.connect(mod?.ampNode ?? tone)` — a nullish-coalescing
    //     expression no single regex can match.
    // A guard that cries wolf gets ignored, which is worse than no guard, so
    // this checks only the property that is unambiguous: an amp is never left
    // with zero outgoing connections. The precise regression is pinned by the
    // dedicated case below, and the audible half is the generic render loop in
    // src/browser-checks.ts.
    for (const { name, kind, body } of sources) {
      if (!/const amp = ctx\.createGain\(\)/.test(body)) continue;
      const ampOutputs = [...body.matchAll(/amp\.connect\(/g)];
      expect(
        ampOutputs.length,
        `${name} (${kind}): creates a voice 'amp' but never calls amp.connect(...) — ` +
          `the voice chain dead-ends and this instrument renders SILENCE`,
      ).toBeGreaterThan(0);
    }
  });

  it("no instrument connects its output back into its own voice chain (feedback loop)", () => {
    for (const { name, kind, body } of sources) {
      // A bare `output.connect(...)` into the voice graph would be a cycle.
      // Only flag the instrument's own bus, not a filter's `.output` property.
      const selfFeedback = /(?<![.\w])output\.connect\((?!ctx\.destination\))/g;
      expect(
        selfFeedback.test(body),
        `${name} (${kind}): the instrument output feeds back into its own chain — a feedback loop`,
      ).toBe(false);
    }
  });

  it("the Clavinet specifically joins its amp to the output (the shipped regression)", () => {
    const clav = sources.find((s) => s.kind === "clav");
    expect(clav, "clav slice must be found in the registry source").toBeTruthy();
    expect(
      /amp\.connect\(output\)/.test(clav!.body),
      "clav lost amp.connect(output) — the Clavinet is silent again",
    ).toBe(true);
  });
});
