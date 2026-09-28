/**
 * Generates the INTENT SFT DATASET — (instruction → canonical action) pairs
 * for fine-tuning a small local model as a KYX sound engineer.
 *
 * The DETERMINISTIC intent layer is the teacher: every corpus instruction is
 * routed through `routeIntentText` against a FIXED dataset document, and the
 * routed action is compacted by `compactIntentResponse`. Pairs whose route
 * lands on "pattern" are EXCLUDED — generation is a proposal flow, not a
 * command, and stays with the existing candidate engine.
 *
 * Output (scripts/data/intent-sft/):
 *   train.jsonl    — the full pair set (~deterministic order: corpus order)
 *   val.jsonl      — every 7th pair held out
 *   golden.jsonl   — a locked subset pinned by tests/intent-sft-golden.test.ts
 *   manifest.json  — counts per kind/language + DATASET_VERSION
 *
 * Run: npx vite-node scripts/generate-intent-dataset.mts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import type { ProjectDocument } from "../src/project-model/types";

const DATASET_VERSION = 1;
const OUT_DIR = path.join(process.cwd(), "scripts", "data", "intent-sft");

/** Fixed dataset document: deterministic ids, role scenes, two clips. */
function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  // the house template ships an arrangement clip at bar 0 — strip it so the
  // dataset clips land exactly where the corpus expects them
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}

interface Pair {
  instruction: string;
  lang: "en" | "sk";
  response: Record<string, unknown>;
}

function collect(doc: ProjectDocument, lang: "en" | "sk", instructions: string[]): Pair[] {
  const pairs: Pair[] = [];
  for (const instruction of instructions) {
    const response = compactIntentResponse(routeIntentText(instruction, doc));
    if (response.kind === "pattern") continue; // generation is not a command
    pairs.push({ instruction, lang, response });
  }
  return pairs;
}

// ── Corpus — curated EN + SK templates across every command kind ────────────

function corpus(): Array<{ lang: "en" | "sk"; instructions: string[] }> {
  return [
    {
      lang: "en",
      instructions: [
        // fader — relative
        "turn down the drums",
        "turn down the bass",
        "turn down the lead",
        "turn down the chords",
        "raise the drums",
        "raise the bass a bit",
        "lower the lead a lot",
        "quieter drums",
        "louder bass",
        "turn down the drums by 25 percent",
        "raise the bass by 10 percent",
        "turn down the drums completely",
        // fader — absolute set
        "set the bass to 50%",
        "set the drums to 100%",
        "set the lead to 25%",
        "set the bass to 0%",
        "set the master to 80%",
        "set the kick to 100%",
        // mute / solo / pan family
        "mute the drums",
        "unmute the drums",
        "mute the bass",
        "mute everything",
        "unmute everything",
        "solo the bass",
        "unsolo the bass",
        "solo the drums",
        "pan the bass left 30",
        "pan the hats 80% right",
        "pan the bass left",
        "center the bass",
        "center the hi-hats",
        // exact — tempo/key/transpose/length
        "set tempo to 140",
        "set tempo to 90 bpm",
        "tempo 138",
        "128 bpm",
        "change the key to D minor",
        "set key to F# minor",
        "transpose the lead up one octave",
        "transpose the bass down 3 semitones",
        "pattern length to 32",
        "length to 64",
        // gain dB
        "boost the drums by 2 dB",
        "lower the mix by 1.5 dB",
        "boost the mix by 3 dB",
        // track CRUD
        "add a drum track",
        "add a bass track",
        "add a keys track",
        "add a track",
        "delete the lead track",
        "duplicate the bass track",
        'rename the bass to "sub bass"',
        // transport / app
        "play",
        "pause",
        "stop",
        "metronome on",
        "metronome off",
        "loop on",
        "loop off",
        "save",
        "export wav",
        "export mp3",
        "bounce",
        "record",
        "stop recording",
        "rec",
        // select
        "select the bass",
        "select the drums",
        "select the lead",
        // presets
        "load the Warm Sub preset on the bass",
        "load the warm preset on the bass",
        "load the House Chords preset on the chords",
        "load the Reese preset on the lead",
        // effect intents
        "more reverb on the lead",
        "less reverb on the chords",
        "more delay on the bass",
        "remove reverb from the bass",
        "set the lead reverb mix to 25%",
        "more compression on the drums",
        "more saturation on the bass",
        "more chorus on the chords",
        "add reverb to the drop",
        // sends
        "more reverb send on the lead",
        "more reverb send on the drums",
        "less reverb send on the lead",
        "set the delay send to 40% on the bass",
        "no reverb send on the drums",
        "add reverb send to the lead",
        // bypass
        "bypass the delay on the lead",
        "bypass reverb on the drums",
        "enable the delay on the lead",
        // mix profile
        "more reverb",
        "drier mix",
        "huge reverb",
        "punchier",
        "no pump",
        "darker",
        "brighter",
        "warmer mix",
        // loudness
        "make it louder",
        "make it quieter",
        "loudness to -9",
        // production concepts
        "make the drums darker",
        "make the bass deeper",
        "make the drums punchier",
        "make the lead wider",
        "make the bass warmer",
        "make the drums grittier",
        "make the lead telephone",
        "make the drums lofi",
        "make the lead robotic",
        "make the drums tape",
        "make the drums stutter",
        "make the drums glue",
        "make the bass metallic",
        "make the lead wobbly",
        // revise
        "more energetic",
        "less energetic",
        "more dense",
        "less busy",
        "make the bridge more energetic",
        // clips
        "copy the intro clip to bar 9",
        "copy the clip at bar 1 to bar 9",
        "move the drop clip to bar 9",
        "trim the clip at bar 5 to 2 bars",
        "delete the clip at bar 8",
        // arrange
        "shorten the intro to 2 bars",
        "add a break before the drop",
        "duplicate the drop",
        "remove the intro",
        "auto-arrange into a song",
        // compounds
        "zníž tempo a zvýš lead",
        "mute the drums and set tempo to 140",
        "mute the drums and zníž basu",
        "set the bass to 50% and zníž lead",
        "load the Warm Sub preset on the bass and zníž lead",
        "bypass the delay on the lead and zníž basu",
        "more reverb send on the lead and turn down the drums",
        // clarify examples (declined asks teach the model to ask)
        "zníž",
        "more compression",
        "more delay on the trumpets",
        "mut the drums",
        "pann the bass left 30",
        "load the zzzblorp preset on the bass",
        "set tempo to 500",
        "set the reverb decay to 30%",
      ],
    },
    {
      lang: "sk",
      instructions: [
        "zníž basu",
        "zníž bicie",
        "hlasnejšie bicie",
        "zníž basu trochu",
        "zníž basu o 10 %",
        "zvýš 808 na 30 %",
        "stíš celý mix",
        "kick ťažší",
        "haty tichšie",
        "nastav basu na 50 %",
        "nastav master na 80 %",
        "vypni basu",
        "zapni bicie",
        "zníž tempo",
        "tempo na 128",
        "140 bpm",
        "pomalší",
        "zrýchli to",
        "všetko stíš",
        "zmaz basu",
        "pridaj basový track",
        "premenuj basu na sub",
        "ulož",
        "ulož projekt",
        "exportuj wav",
        "exportuj mp3",
        "nahrávaj",
        "prestav nahrávanie",
        "hraj",
        "pauza",
        "zastav",
        "metronome zapni",
        "loop zapni",
        "cykluj vypni",
        "vyber basu",
        "načítaj preset warm sub na basu",
        "viac reverbu na leade",
        "menej delayu na basi",
        "odstrán reverb z basy",
        "nastav delay mix na leade na 30 %",
        "viac reverb send na leade",
        "menej reverb send na leade",
        "bypass delay na leade",
        "sprav basu hlbšiu",
        "sprav bicie razantnejšie",
        "viac energie",
        "menej energie",
        "skráť intro na 2 takty",
        "pridaj break pred drop",
        "kopíruj intro clip na takt 9",
        "darker mix",
        "viac dozvuku",
        "bez pumpy",
        "razantnejšie",
        "hlbší bas",
        "siroší lead",
        "vinyl break",
        "mlčanie na leade a zníž basu",
      ],
    },
  ];
}

// ── Generation ──────────────────────────────────────────────────────────────

function main(): void {
  const doc = datasetDoc();
  const all: Array<Pair & { index: number }> = [];
  let index = 0;
  for (const { lang, instructions } of corpus()) {
    for (const pair of collect(doc, lang, instructions)) {
      all.push({ ...pair, index: index++ });
    }
  }

  // determinism double-run: identical route on a second pass
  for (const pair of all) {
    const again = compactIntentResponse(routeIntentText(pair.instruction, doc));
    if (JSON.stringify(again) !== JSON.stringify(pair.response)) {
      throw new Error(`non-deterministic route for "${pair.instruction}"`);
    }
  }

  // dedupe by instruction (keep first)
  const seen = new Set<string>();
  const unique = all.filter((pair) => {
    const key = pair.instruction.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const valSet = new Set(unique.filter((_, i) => i % 7 === 3).map((p) => p.instruction));
  const train = unique.filter((p) => !valSet.has(p.instruction));
  const val = unique.filter((p) => valSet.has(p.instruction));

  // golden: a locked cross-kind/language subset pinned by the test suite
  const goldenPicks = [
    "zníž basu",
    "set the bass to 50%",
    "mute everything",
    "turn down the drums",
    "set tempo to 140",
    "tempo na 128",
    "mute the drums",
    "solo the bass",
    "pan the bass left 30",
    "vypni basu",
    "add a drum track",
    "delete the lead track",
    'rename the bass to "sub bass"',
    "play",
    "stop",
    "loop on",
    "save",
    "export wav",
    "record",
    "select the bass",
    "load the Warm Sub preset on the bass",
    "more reverb on the lead",
    "set the lead reverb mix to 25%",
    "remove reverb from the bass",
    "more reverb send on the lead",
    "set the delay send to 40% on the bass",
    "no reverb send on the drums",
    "bypass the delay on the lead",
    "make the drums darker",
    "more energetic",
    "copy the intro clip to bar 9",
    "trim the clip at bar 5 to 2 bars",
    "shorten the intro to 2 bars",
    "more reverb",
    "make it louder",
    "zníž tempo a zvýš lead",
    "mute the drums and set tempo to 140",
    "bypass the delay on the lead and zníž basu",
    "mut the drums",
    "more compression",
    "load the zzzblorp preset on the bass",
  ];
  const byInstruction = new Map(unique.map((p) => [p.instruction, p]));
  const golden = goldenPicks.map((instruction) => byInstruction.get(instruction)).filter((p) => p != null);

  const kindCounts = new Map<string, number>();
  for (const pair of unique) {
    const kind = String(pair.response.kind);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name: string, rows: Array<Record<string, unknown>>): void =>
    writeFileSync(path.join(OUT_DIR, name), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  write("train.jsonl", train);
  write("val.jsonl", val);
  write("golden.jsonl", golden);
  writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        datasetVersion: DATASET_VERSION,
        total: unique.length,
        train: train.length,
        val: val.length,
        golden: golden.length,
        langs: { en: unique.filter((p) => p.lang === "en").length, sk: unique.filter((p) => p.lang === "sk").length },
        kinds: Object.fromEntries([...kindCounts.entries()].sort()),
      },
      null,
      2,
    ),
  );
  console.log(
    `intent-sft: ${unique.length} pairs (${train.length} train / ${val.length} val / ${golden.length} golden)`,
  );
  console.log(`kinds: ${[...kindCounts.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`);
}

main();
