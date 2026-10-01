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
import { datasetDoc } from "./intent-sft-doc.mts";
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";

const DATASET_VERSION = 4;
const OUT_DIR = path.join(process.cwd(), "scripts", "data", "intent-sft");

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
        "transpose the bass down three semitones",
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
        // mix disambiguation — tone words that could be confused with fader
        "darker mix",
        "brighter mix",
        "warmer sound",
        "cooler mix",
        // transport disambiguation — verbs that sound like edits
        "stop playback",
        "start playing",
        "pause the transport",
        // fader with unusual targets — teach broad target coverage
        "turn down the pads by 20 percent",
        "raise the brass by 15 percent",
        "set the woodwinds to 70 percent",
        "turn up the strings",
        "lower the choir by 25 percent",
        // effectIntent vs clarify — real effect asks, not confusion
        "more delay on the trumpets",
        "add reverb to the strings",
        "less compression on the bass",
        "more saturation on the drums",
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
        // arrange depth — more section operations
        "duplicate the chorus",
        "duplicate the bridge",
        "remove the bridge",
        "add 4 bars to the chorus",
        "add a fill before the chorus",
        "add a breakdown after the drop",
        "double the drop",
        "arrange into intro-verse-chorus",
        "arrange into intro-build-drop-break-drop-outro",
        "shorten the drop to 4 bars",
        "extend the outro to 8 bars",
        "move the chorus after the bridge",
        "swap the verse and the chorus",
        // arrange — exact operation variants (the model confuses phrasings)
        "double the chorus",
        "duplicate the intro",
        "duplicate the bridge",
        "duplicate the verse",
        "repeat the drop",
        "copy the chorus",
        "lengthen the drop to 8 bars",
        "lengthen the intro to 6 bars",
        "extend the intro to 4 bars",
        "shorten the drop to 2 bars",
        "resize the chorus to 8 bars",
        "add a send to the chords",
        "add a send on the bass",
        // mix — tone disambiguation (fader confusions)
        "darker",
        "colder",
        "warmer",
        "brighter sound",
        "make the mix darker",
        "make the mix brighter",
        "make the mix warmer",
        // loudness — numeric formats
        "loudness to -12",
        "loudness to -9",
        "loudness na -9",
        "loudness na -14",
        "make it louder",
        "make it quieter",
        "itx louder",
        // transport — SK metronome/loop
        "metronome zapni",
        "metronome vypni",
        "metronome on",
        "metronome off",
        "loop on",
        "loop off",
        // clarify — misspellings route to clarify (not wrong kinds)
        "mut the drums",
        "solo the baus",
        "mute te drums",
        // mix depth — more profile vocabulary
        "wetter mix",
        "more punch in the mix",
        "less reverb in the mix",
        "more compression on the mix",
        "wider stereo",
        "narrower mix",
        "more sub in the mix",
        "less harsh on the mix",
        "punchy mix",
        "smooth mix",
        "aggressive mix",
        "dark mix",
        "airy mix",
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
        // arrange — SK exact operation variants
        "zdvojnásobuj intro",
        "zdvojnásobuj drop",
        "skopíruj refren",
        "skráti drop na 2 takty",
        "predĺž intro na 6 taktov",
        "zmeň dĺžku refrenu na 8 taktov",
        // loudness — SK numeric formats
        "hlasitosť na -12",
        "hlasitosť na -9",
        "sprav to hlasnejšie",
        "sprav to tichšie",
        // transport — SK metronome/loop EN aliases
        "metronome on",
        "metronome off",
        "loop on",
        "loop off",
        // clarify — SK misspellings
        "stiš bice",
        "zníž basu o",
        "vipni basu",
        // mix disambiguation — SK
        "tmavší mix",
        "svetlejší mix",
        "teplejší zvuk",
        "drier mix po slovensky",
        // arrange depth — SK
        "zdvojnásobuj refren",
        "odstráň bridge",
        "pridaj 4 takty do refrenu",
        "pridaj fill pred refren",
        "skráti drop na 4 takty",
        "predĺž outro na 8 taktov",
        "presuň refren za bridge",
        "vymeň verse a refren",
        "rozdeľ na intro-verse-chorus",
        // mix depth — SK
        "menej reverbu v mixe",
        "viac kompresie v mixe",
        "širšia stereo báza",
        "užší mix",
        "viac sub v mixe",
        "menej ostrý mix",
        "hlučný mix",
        "temný mix",
        "vzdušný mix",
        // transport disambiguation — SK
        "zastav prehrávanie",
        "spusti prehrávanie",
        "pauza na transporte",
        // fader s neobvyklými targetmi
        "stiš pady o 20 percent",
        "zvýš mosfy o 15 percent",
        "nastav sláčiky na 70 percent",
        "zvýš zbor",
        "zníž zbor o 25 percent",
        // effectIntent vs clarify — SK
        "pridaj delay na trubky",
        "daj reverb na sláčiky",
        "menej kompresie na base",
        "viac saturácie na bicích",
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

/**
 * Combinatorial augmentation — mechanical phrase families the parsers are
 * KNOWN to resolve (each generated instruction is verified against the
 * teacher before it enters the dataset; a template row that routes to
 * pattern is silently dropped, so only live vocabulary ships).
 */
function augmentation(): Array<{ lang: "en" | "sk"; instructions: string[] }> {
  const en: string[] = [];
  const sk: string[] = [];

  // ── FADER: direction × target × amount ──────────────────────────────────
  for (const verb of ["turn down", "lower", "quiet down"]) {
    for (const target of ["drums", "bass", "lead", "chords"]) {
      for (const tail of ["", " a bit", " a lot", " completely"]) {
        if (verb === "quiet down" && tail !== "") continue; // curated stem only
        en.push(`${verb} the ${target}${tail}`);
      }
    }
  }
  for (const verb of ["raise", "turn up", "push up"]) {
    for (const target of ["drums", "bass", "lead", "chords"]) {
      en.push(`${verb} the ${target}`);
      en.push(`${verb} the ${target} a bit`);
      en.push(`${verb} the ${target} a lot`);
    }
  }
  for (const target of ["drums", "bass", "lead", "chords", "master"]) {
    en.push(`quieter ${target}`);
    en.push(`louder ${target}`);
  }
  // fader on PAD families ("turn down the kick")
  for (const pad of ["kick", "snare", "hat"]) {
    en.push(`turn down the ${pad}`);
    en.push(`raise the ${pad}`);
    en.push(`quieter ${pad}`);
    en.push(`louder ${pad}`);
  }
  // fader: relative percent (down AND up)
  for (const target of ["bass", "drums", "lead", "chords"]) {
    for (const pct of [5, 10, 15, 25, 40]) {
      en.push(`turn down the ${target} by ${pct} percent`);
      en.push(`raise the ${target} by ${pct} percent`);
    }
  }
  // fader: absolute set × target × percent
  for (const target of ["bass", "drums", "lead", "chords", "master"]) {
    for (const pct of [0, 10, 20, 25, 35, 50, 60, 75, 90, 100]) {
      en.push(`set the ${target} to ${pct}%`);
    }
  }
  for (const pad of ["kick", "snare", "hat"]) {
    for (const pct of [0, 25, 50, 75, 100]) {
      en.push(`set the ${pad} to ${pct}%`);
    }
  }
  // SK fader
  for (const target of ["basu", "bicie", "lead", "chords", "master"]) {
    for (const tail of ["", " trochu", " o dosť", " úplne"]) {
      sk.push(`zníž ${target}${tail}`);
    }
    sk.push(`zvýš ${target}`);
    sk.push(`zvýš ${target} trochu`);
  }
  sk.push("kick hlasnejší");
  sk.push("kick tichší");
  sk.push("snare hlasnejší");
  sk.push("haty hlasnejšie");
  sk.push("haty tichšie");
  for (const target of ["basu", "master", "kick", "lead", "bicie"]) {
    for (const pct of [0, 25, 50, 80, 100]) {
      sk.push(`nastav ${target} na ${pct} %`);
    }
  }
  for (const target of ["basu", "bicie", "lead"]) {
    for (const pct of [5, 10, 20, 25]) {
      sk.push(`zníž ${target} o ${pct} %`);
      sk.push(`zvýš ${target} o ${pct} %`);
    }
  }

  // ── MUTE / SOLO / PAN ────────────────────────────────────────────────────
  for (const verb of ["mute", "unmute", "solo", "unsolo"]) {
    for (const target of ["drums", "bass", "lead", "chords"]) {
      en.push(`${verb} the ${target}`);
    }
  }
  en.push("mute all");
  for (const pad of ["kick", "snare", "claps", "hats"]) {
    en.push(`mute the ${pad}`);
    en.push(`unmute the ${pad}`);
    en.push(`center the ${pad}`);
  }
  en.push("solo the hats");
  for (const verb of ["vypni", "zapni"]) {
    for (const target of ["basu", "bicie", "lead", "chords"]) {
      sk.push(`${verb} ${target}`);
    }
  }
  sk.push("solo bicie");
  sk.push("solo basu");
  for (const target of ["bass", "lead", "hats", "drums", "chords", "snare"]) {
    for (const dir of ["left", "right"]) {
      for (const mag of [10, 30, 60, 90]) {
        en.push(`pan the ${target} ${dir} ${mag}`);
        en.push(`pan the ${target} ${mag}% ${dir}`);
      }
    }
    en.push(`center the ${target}`);
  }
  sk.push("pan basu 30 pravo");
  sk.push("pan lead 20 lavo");

  // ── TEMPO / KEY / TRANSPOSE / LENGTH ─────────────────────────────────────
  for (const bpm of [90, 100, 110, 120, 128, 132, 140, 150, 160, 174]) {
    en.push(`set tempo to ${bpm}`);
    en.push(`set tempo to ${bpm} bpm`);
    en.push(`tempo ${bpm}`);
    en.push(`${bpm} bpm`);
  }
  en.push("make it faster");
  en.push("make it slower");
  en.push("speed up");
  en.push("slow down");
  en.push("slow it down");
  for (const bpm of [90, 120, 128, 140, 150, 174]) {
    sk.push(`tempo na ${bpm}`);
  }
  sk.push("tempo dole");
  sk.push("tempo hore");
  sk.push("spomal to");
  for (const key of ["A minor", "E minor", "C major", "G major", "F major", "D minor"]) {
    en.push(`change the key to ${key}`);
    en.push(`set key to ${key}`);
  }
  for (const target of ["lead", "bass", "chords"]) {
    for (const dir of ["up", "down"]) {
      for (const count of ["one", "two", "three"]) {
        en.push(`transpose the ${target} ${dir} ${count} octave${count === "one" ? "" : "s"}`);
      }
      for (const st of ["one", "two", "three"]) {
        en.push(`transpose the ${target} ${dir} ${st} semitone${st === "one" ? "" : "s"}`);
      }
    }
  }
  for (const steps of [16, 32, 64, 128]) {
    en.push(`pattern length to ${steps}`);
    en.push(`length to ${steps}`);
  }

  // ── GAIN dB ──────────────────────────────────────────────────────────────
  for (const target of ["drums", "bass", "lead", "chords", "mix"]) {
    for (const db of [0.5, 1, 1.5, 2, 3]) {
      en.push(`boost the ${target} by ${db} dB`);
      en.push(`lower the ${target} by ${db} dB`);
    }
  }

  // ── TRACK CRUD ───────────────────────────────────────────────────────────
  for (const instrument of ["808", "bass", "keys", "pluck", "flute", "acid", "strings", "bells"]) {
    en.push(`add an ${instrument} track`);
  }
  en.push("add a drum track");
  en.push("add a track");
  for (const target of ["drums", "bass", "lead", "chords"]) {
    en.push(`delete the ${target} track`);
    en.push(`duplicate the ${target} track`);
  }
  en.push('rename the bass to "sub bass"');
  en.push('rename the lead to "top line"');

  // ── TRANSPORT / APP ──────────────────────────────────────────────────────
  for (const word of ["play", "stop", "pause", "save", "export", "record"]) {
    en.push(`please ${word}`);
  }
  en.push("stop recording");
  en.push("start recording");
  en.push("save the project");
  en.push("save it");
  en.push("export the project as mp3");
  en.push("export the project as wav");
  sk.push("stoj");
  sk.push("metronome vypni");
  sk.push("zruš nahrávanie");

  // ── SELECT ───────────────────────────────────────────────────────────────
  en.push("select the chords");
  sk.push("vyber bicie");
  sk.push("vyber lead");

  // ── PRESETS ──────────────────────────────────────────────────────────────
  for (const name of ["Warm Sub", "House Chords", "Reese"]) {
    for (const target of ["bass", "chords", "lead"]) {
      en.push(`load the ${name} preset on the ${target}`);
    }
  }
  en.push("load the warm preset on the lead");
  sk.push("načítaj preset reese na leade");

  // ── EFFECT INTENTS ───────────────────────────────────────────────────────
  for (const effect of [
    "reverb",
    "delay",
    "chorus",
    "distortion",
    "saturation",
    "compressor",
    "eq",
    "flanger",
    "phaser",
    "tremolo",
    "bitcrusher",
    "pump",
  ]) {
    for (const target of ["lead", "bass", "chords", "drums"]) {
      en.push(`more ${effect} on the ${target}`);
      en.push(`less ${effect} on the ${target}`);
      en.push(`remove ${effect} from the ${target}`);
    }
  }
  for (const target of ["lead", "bass", "chords", "drums"]) {
    for (const pct of [10, 25, 50, 75, 90]) {
      en.push(`set the ${target} reverb mix to ${pct}%`);
      en.push(`set the ${target} delay mix to ${pct}%`);
    }
  }
  for (const effect of ["reverb", "delay", "chorus"]) {
    for (const target of ["leade", "basi"]) {
      sk.push(`viac ${effect === "reverb" ? "reverbu" : effect} na ${target}`);
      sk.push(`menej ${effect === "reverb" ? "reverbu" : effect} na ${target}`);
    }
    for (const pct of [10, 25, 50, 75]) {
      sk.push(`nastav ${effect} na leade na ${pct} %`);
      sk.push(`nastav ${effect} na basi na ${pct} %`);
    }
  }

  // ── SENDS ────────────────────────────────────────────────────────────────
  for (const effect of ["reverb", "delay", "chorus"]) {
    for (const target of ["lead", "bass", "drums", "chords"]) {
      en.push(`more ${effect} send on the ${target}`);
      en.push(`less ${effect} send on the ${target}`);
      en.push(`no ${effect} send on the ${target}`);
    }
    for (const pct of [20, 30, 40, 50]) {
      en.push(`set the ${effect} send to ${pct}% on the lead`);
    }
  }

  // ── BYPASS ───────────────────────────────────────────────────────────────
  for (const effect of ["reverb", "delay", "chorus", "saturation"]) {
    for (const target of ["lead", "drums", "bass", "chords"]) {
      en.push(`bypass the ${effect} on the ${target}`);
      en.push(`enable the ${effect} on the ${target}`);
    }
  }

  // ── MIX PROFILE ──────────────────────────────────────────────────────────
  for (const ask of [
    "more reverb",
    "wetter mix",
    "less reverb",
    "drier mix",
    "dry it up",
    "huge reverb",
    "more punch",
    "punchier",
    "tighter mix",
    "softer drums",
    "no pump",
    "without sidechain",
    "sidechain",
    "ducking",
    "darker",
    "brighter",
    "warmer",
    "colder",
    "darker mix",
    "brighter mix",
    "warmer mix",
    "colder mix",
  ]) {
    en.push(ask);
  }
  for (const ask of [
    "viac dozvuku",
    "menej dozvuku",
    "obri dozvuk",
    "bez pumpy",
    "tmavší mix",
    "svetlejší mix",
    "teplejší mix",
    "razantnejšie",
    "menej razantné",
  ]) {
    sk.push(ask);
  }

  // ── LOUDNESS ─────────────────────────────────────────────────────────────
  for (const ask of [
    "make it louder",
    "make it quieter",
    "louder",
    "quieter",
    "loudness to -9",
    "loudness to -14",
    "-9 lufs",
    "-14 lufs",
  ]) {
    en.push(ask);
  }
  for (const ask of ["loudness na -9", "loudness na -12", "hlasnejšie", "tichšie"]) {
    sk.push(ask);
  }

  // ── PRODUCTION ───────────────────────────────────────────────────────────
  for (const concept of ["darker", "brighter", "punchier", "warmer", "deeper", "wider", "grittier"]) {
    for (const target of ["drums", "bass", "lead", "chords"]) {
      en.push(`make the ${target} ${concept}`);
    }
  }
  for (const concept of ["telephone", "robotic", "tape", "lofi", "wobbly", "metallic", "stutter", "glue"]) {
    for (const target of ["drums", "bass", "lead"]) {
      en.push(`make the ${target} ${concept}`);
    }
  }
  for (const tail of [" a lot", " slightly", " much more"]) {
    for (const target of ["drums", "bass", "lead"]) {
      en.push(`make the ${target} darker${tail}`);
      en.push(`make the ${target} punchier${tail}`);
    }
  }
  for (const skTarget of ["basu", "bicie", "lead"]) {
    for (const skConcept of ["hlbšiu", "razantnejšie", "teplejšiu", "sirošiu"]) {
      sk.push(`sprav ${skTarget} ${skConcept}`);
    }
  }
  for (const ask of ["hlbší bas", "razantnejšie bicie", "siroší lead", "teplejší bas"]) {
    sk.push(ask);
  }

  // ── REVISE (content sliders, targeted variants included) ─────────────────
  for (const ask of [
    "more energetic",
    "less energetic",
    "more energy",
    "less energy",
    "busier",
    "denser",
    "less busy",
    "sparser",
    "calmer",
  ]) {
    for (const scope of ["", " in the bridge", " in the chorus", " in the intro", " in the outro"]) {
      en.push(`${ask}${scope}`);
    }
  }
  for (const ask of ["viac energie", "menej energie", "hustejšie", "menej husté"]) {
    for (const scope of ["", " v moste", " v refrene", " v intru"]) {
      sk.push(`${ask}${scope}`);
    }
  }

  // ── CLIPS ────────────────────────────────────────────────────────────────
  for (const bar of [9, 10, 13]) {
    en.push(`copy the intro clip to bar ${bar}`);
  }
  for (const bar of [9, 10]) {
    en.push(`move the drop clip to bar ${bar}`);
  }
  for (const bar of [1, 5]) {
    for (const bars of [2, 3]) {
      en.push(`trim the clip at bar ${bar} to ${bars} bars`);
    }
  }
  for (const bar of [5, 8]) {
    en.push(`delete the clip at bar ${bar}`);
  }
  for (const bar of [9, 10]) {
    sk.push(`kopíruj intro clip na takt ${bar}`);
  }

  // ── ARRANGE ──────────────────────────────────────────────────────────────
  for (const bars of [1, 2, 3]) {
    en.push(`shorten the intro to ${bars} bars`);
  }
  en.push("lengthen the drop to 8 bars");
  en.push("add a break before the drop");
  en.push("add an intro before the drop");
  en.push("duplicate the drop");
  en.push("duplicate the intro");
  en.push("remove the intro");
  en.push("remove the break");
  en.push("auto-arrange into a song");
  sk.push("usporiadaj do pesničky");
  for (const bars of [1, 2]) {
    sk.push(`skráť intro na ${bars} takty`);
  }
  sk.push("pridaj break pred drop");

  // ── COMPOUNDS (mixed executors, mixed languages) ─────────────────────────
  en.push("set tempo to 128 and mute the drums");
  en.push("more reverb on the lead and turn down the drums");
  en.push("set the bass to 50% and set tempo to 140");
  en.push("louder drums and more punch");
  en.push("enable the delay on the lead and quiet down the bass");
  sk.push("zníž bicie a zvýš basu");
  sk.push("viac delayu na leade a mute the bass");
  sk.push("mlčanie na leade a zvýš basu");

  // ── CLARIFY (declined asks teach the model to ask, not to guess) ─────────
  en.push("more delay");
  en.push("turn down");
  en.push("set the reverb decay to 40%");

  // ── TYPO VARIANTS (one edit away — the typo layer offers the fix) ────────
  for (const base of [
    "mute the drums",
    "solo the bass",
    "pan the lead left 30",
    "stop",
    "record",
    "select the bass",
    "export wav",
  ]) {
    const tokens = base.split(" ");
    const mutated = tokens.map((t, i) => (i === 1 ? t + "x" : t)).join(" ");
    en.push(mutated);
  }

  // ── WAVE 2: finer numeric grids + new verb families ─────────────────────
  // fader absolute: full 5%-step grid
  for (const target of ["bass", "drums", "lead", "chords", "master"]) {
    for (const pct of [15, 30, 45, 65, 85]) {
      en.push(`set the ${target} to ${pct}%`);
    }
  }
  for (const target of ["basu", "master", "kick", "lead", "bicie"]) {
    for (const pct of [15, 30, 70, 90]) {
      sk.push(`nastav ${target} na ${pct} %`);
    }
  }
  // fader relative: finer percent
  for (const target of ["bass", "drums", "lead", "chords"]) {
    for (const pct of [30, 60, 85]) {
      en.push(`turn down the ${target} by ${pct} percent`);
      en.push(`raise the ${target} by ${pct} percent`);
    }
  }
  for (const target of ["basu", "bicie", "lead"]) {
    for (const pct of [15, 30, 50]) {
      sk.push(`zníž ${target} o ${pct} %`);
      sk.push(`zvýš ${target} o ${pct} %`);
    }
  }
  // SK fader: the other proven verb stems
  for (const target of ["basu", "bicie", "mix", "lead"]) {
    sk.push(`stíš ${target}`);
    sk.push(`zosilni ${target}`);
    sk.push(`ztlm ${target}`);
    sk.push(`posilni ${target}`);
  }
  // pan: wider magnitude grid (extends the closed pan value set)
  for (const target of ["bass", "lead", "hats", "drums", "chords", "snare"]) {
    for (const dir of ["left", "right"]) {
      for (const mag of [15, 25, 50, 75]) {
        en.push(`pan the ${target} ${mag}% ${dir}`);
        en.push(`pan the ${target} ${dir} ${mag}`);
      }
    }
  }
  // mute/solo everything-family + 808 alias
  en.push("unmute all");
  en.push("solo all");
  en.push("mute the 808");
  en.push("unmute the 808");
  // tempo: extended bpm grid
  for (const bpm of [95, 115, 126, 138, 155, 170]) {
    en.push(`set tempo to ${bpm}`);
    en.push(`set tempo to ${bpm} bpm`);
    en.push(`tempo ${bpm}`);
    en.push(`${bpm} bpm`);
  }
  // transpose: word-count forms only (the parser accepts one|two|three|an)
  for (const target of ["lead", "bass", "chords"]) {
    for (const dir of ["up", "down"]) {
      en.push(`transpose the ${target} ${dir} two octaves`);
      en.push(`transpose the ${target} ${dir} three octaves`);
    }
  }
  // key: more sharp-spelled keys
  for (const key of [
    "B minor",
    "F# minor",
    "C# minor",
    "G minor",
    "C minor",
    "F minor",
    "A major",
    "E major",
    "D major",
  ]) {
    en.push(`change the key to ${key}`);
    en.push(`set key to ${key}`);
  }
  // gainDb: more verbs + master/808 + SK grid
  for (const verb of ["raise", "increase", "cut", "reduce"]) {
    for (const target of ["drums", "bass", "mix", "master", "808"]) {
      for (const db of [1, 2, 3]) {
        en.push(`${verb} the ${target} by ${db} dB`);
      }
    }
  }
  for (const verb of ["zníž", "zvýš"]) {
    for (const target of ["basu", "bicie", "mix"]) {
      for (const db of [1, 2, 3]) {
        sk.push(`${verb} ${target} o ${db} db`);
      }
    }
  }
  sk.push("hlasnejšie bicie o 2 db");
  sk.push("tichší mix o 1.5 db");
  // CRUD: more instruments + "new" article
  for (const instrument of [
    "organ",
    "brass",
    "fm",
    "reese",
    "wavetable",
    "granular",
    "sampler",
    "logdrum",
    "vocal chops",
    "drumsynth",
  ]) {
    en.push(`add an ${instrument} track`);
  }
  en.push("add a new keys track");
  en.push("add a new bass track");
  // effects: role targets ("add reverb to the drop") + add-form + no-form
  for (const effect of ["reverb", "delay", "chorus", "distortion", "saturation", "compressor", "eq"]) {
    for (const role of ["drop", "bridge"]) {
      en.push(`add ${effect} to the ${role}`);
      en.push(`more ${effect} on the ${role}`);
      en.push(`less ${effect} on the ${role}`);
    }
    for (const target of ["lead", "bass", "chords", "drums"]) {
      en.push(`add ${effect} to the ${target}`);
      en.push(`no ${effect} on the ${target}`);
    }
  }
  for (const pct of [25, 50]) {
    for (const target of ["lead", "bass"]) {
      en.push(`set the ${target} chorus mix to ${pct}%`);
      en.push(`set the ${target} saturation mix to ${pct}%`);
    }
  }
  sk.push("viac reverbu na akordoch");
  sk.push("viac delayu na bicie");
  // sends: add-form grid + set on more targets
  for (const effect of ["reverb", "delay", "chorus"]) {
    for (const target of ["lead", "bass", "drums", "chords"]) {
      en.push(`add ${effect} send to the ${target}`);
    }
    for (const pct of [20, 30, 40, 50]) {
      en.push(`set the ${effect} send to ${pct}% on the bass`);
    }
  }
  // mix profile: remaining regex-proven asks
  en.push("huge space");
  en.push("softer hit");
  en.push("more sidechain");
  en.push("pumping");
  en.push("ducking");
  en.push("wetter");
  en.push("drier");
  sk.push("viac ozveny");
  sk.push("menej ozveny");
  // loudness: more explicit targets
  en.push("loudness to -7");
  en.push("loudness to -12");
  en.push("-7 lufs");
  en.push("-12 lufs");
  sk.push("loudness na -14");
  sk.push("loudness na -16");
  // production: 808/synth/keys aliases + colder-side SK
  for (const concept of ["darker", "brighter", "punchier", "warmer", "deeper", "wider", "grittier"]) {
    en.push(`make the 808 ${concept}`);
    en.push(`make the synth ${concept}`);
    en.push(`make the keys ${concept}`);
  }
  sk.push("sprav bicie svetlejšie");
  sk.push("sprav lead tmavší");
  sk.push("hlbšie bicie");
  sk.push("plnší bas");
  // revise: bare calmer + drop scope SK
  en.push("calmer");
  sk.push("viac energie v dropu");
  sk.push("menej energie v dropu");
  // clips: wider grids
  for (const bar of [14, 17]) {
    en.push(`copy the intro clip to bar ${bar}`);
  }
  for (const bar of [12, 16]) {
    en.push(`move the drop clip to bar ${bar}`);
  }
  for (const bar of [2, 6]) {
    for (const bars of [1, 2]) {
      en.push(`trim the clip at bar ${bar} to ${bars} bars`);
    }
  }
  for (const bar of [1, 6]) {
    en.push(`delete the clip at bar ${bar}`);
  }
  sk.push("kopíruj drop clip na takt 9");
  // arrange: drop-side ops
  en.push("shorten the drop to 4 bars");
  en.push("shorten the drop to 2 bars");
  en.push("lengthen the intro to 6 bars");
  en.push("lengthen the intro to 8 bars");
  en.push("duplicate the break");
  en.push("remove the drop");
  en.push("add a fill before the drop");
  // compounds: 10 more mixed-executor combos
  en.push("mute the drums and boost the mix by 2 dB");
  en.push("set the kick to 100% and solo the drums");
  en.push("unsolo the bass and set the lead to 50%");
  en.push("pan the bass left 30 and quiet down the hats");
  en.push("load the Warm Sub preset on the bass and set tempo to 140");
  en.push("transpose the lead up one octave and quiet down the bass");
  sk.push("zníž tempo a zníž basu");
  sk.push("viac reverbu na leade a tempo na 128");
  sk.push("vypni bicie a zvýš basu");
  sk.push("nastav basu na 50 % a zvýš lead");
  // clarify: more declined asks
  en.push("more saturation");
  en.push("less distortion");
  en.push("more phaser");
  // typos: more bases
  for (const base of [
    "load the Warm Sub preset on the bass",
    "loudness to -9",
    "make it louder",
    "set the bass to 50%",
    "more reverb on the lead",
  ]) {
    const tokens = base.split(" ");
    const mutated = tokens.map((t, i) => (i === 1 ? t + "x" : t)).join(" ");
    en.push(mutated);
  }
  // transport: SK save variant
  sk.push("ulož to");

  // ── WRONGKIND WAVE — siblings of the eval-miss families (exact val strings
  // are never duplicated: dedupe keeps the first occurrence, which would move
  // a held-out row into train and shrink the val set by a hard row) ─────────
  // send-vs-section contrast: adds with "send" route mixer routing, bare
  // section adds stay arrangement — both sides of the chorus collision
  en.push("add a chorus section");
  en.push("add a verse after the intro");
  en.push("wet it up");
  en.push("make it drier");
  en.push("sidechain on");
  en.push("sidechain off");
  en.push("less sidechain");
  en.push("more pumping");
  // production: deeper/wider family on the remaining targets (the 808/synth/
  // keys grid above does not cover drums/bass/chords/lead)
  en.push("make the bass deeper");
  en.push("make the drums wider");
  en.push("make the chords brighter");
  en.push("make the lead warmer");
  // preset resolution breadth (adjective → fuzzy factory match, new targets)
  en.push("load the warm preset on the chords");
  en.push("load the bright preset on the chords");
  // compound payload completeness (fully-specified parts)
  en.push("set the chords to 75% and set tempo to 132");
  en.push("solo the lead and set the bass to 40%");
  en.push("mute the hats and set tempo to 140");
  // loudness numeric siblings
  en.push("loudness to -16");
  en.push("loudness na -8");
  en.push("target -10 lufs");
  // clarify: bare effect without target
  en.push("more delay");
  // SK mirror of the same families
  sk.push("pridaj chorus send na bicie");
  sk.push("pridaj reverb send na basu");
  sk.push("pridaj chorus sekciu");
  sk.push("pridaj verse za intro");
  sk.push("mokrejší mix");
  sk.push("taký suchší mix");
  sk.push("sidechain zapni");
  sk.push("sidechain vypni");
  sk.push("sprav basu širšiu");
  sk.push("sprav bicie hlbšie");
  sk.push("sprav lead jasnejší");
  sk.push("sprav akordy teplejšie");
  sk.push("načítaj warm preset na leade");
  sk.push("hlasitosť na -8");
  sk.push("hlasitosť na -10");
  sk.push("viac delayu");

  // ── WRONGKIND WAVE 2 — v26 eval slip families (same dedupe discipline:
  // exact val strings are never re-added, only siblings) ────────────────────
  // arrange duplicate: the model invented a non-schema "double" op when the
  // held-out row named an unseen section — the dataset-doc sibling teaches
  // duplicate-on-existing-scene ("zdvojnásobuj intro/drop" already ship)
  en.push("double the intro");
  // loudness numeric: the model dropped the number on held-out values
  en.push("loudness na -10");
  en.push("loudness na -12");
  en.push("loudness to -13");
  en.push("-9 lufs");
  en.push("-16 lufs");
  // transport loop/politeness family
  en.push("loop vypni");
  en.push("loop zapni");
  en.push("please loop on");
  sk.push("cyklus zapni");
  sk.push("vypni cyklus");
  sk.push("prosim hraj");
  // typo-clarify siblings (pann/mut/soloo class)
  en.push("pann the lead left 20");
  en.push("soloo the drums");
  en.push("mut the bass");
  // SK effect-with-explicit-target reinforcement (viac reverbu na basi slip —
  // the contrast against bare "viac reverbu" → clarify is the point)
  sk.push("viac reverbu na bicie");
  sk.push("menej reverbu na leade");
  sk.push("viac delayu na basi");
  sk.push("viac reverbu");
  sk.push("viac saturácie");
  sk.push("pridaj kompresiu na trubky");
  // production noun-adjective family (hlbší bas slip)
  sk.push("hlbší kick");
  sk.push("teplejší bas");
  sk.push("jasnejšie bicie");
  // mix huge-reverb siblings (obri dozvuk slip) + SK mix scope + tempo slip
  sk.push("obrovský dozvuk");
  sk.push("viac reverbu v mixe");
  sk.push("menej reverbu v mixe");
  sk.push("zrýchli");
  sk.push("rýchlejšie");
  sk.push("tempo hore");
  // non-family reverb asks fall to the mix profile (more reverb on the hats)
  en.push("more reverb on the perc");

  // ── WRONGKIND WAVE 3 — v27 eval residue (94.7%/wrongKind 4) ───────────────
  // SK unknown-instrument asks stay clarify ("pridaj delay na trubky" slip)
  sk.push("pridaj reverb na trubky");
  sk.push("menej delayu na trubky");
  // bare SK loudness word is a FADER clarify, not the loudness loop
  sk.push("tichšie");
  sk.push("hlasnejšie v mixe");
  // "menej ozveny" is the mix profile (the model said revise density)
  sk.push("menej ozveny prosím");
  sk.push("menej dozvuku v mixe");
  // auto-arrange SK family (usporiadaj do pesničky → autoArrange)
  sk.push("usporiadaj do songu");
  sk.push("usporiadaj pesničku");
  // pad-family reverb asks fall to the mix profile (menej reverbu na snare)
  en.push("more reverb on the snare");
  sk.push("viac reverbu na kick");
  // loudness numeric copying (the model drops the number on unseen values)
  en.push("loudness na -11");
  en.push("loudness na -13");
  en.push("loudness to -15");
  en.push("-10 lufs");
  en.push("-13 lufs");
  sk.push("hlasitosť na -12");
  sk.push("hlasitosť na -14");
  // compound payload completeness siblings (fader-set / exact+fader parts)
  en.push("mute the chords and set the lead to 30%");
  sk.push("stíš bicie a zvýš basu");
  // bypass compound parts speak the short part name the route carries
  en.push("enable the chorus on the chords and zníž basu");

  // ── WRONGKIND WAVE 4 — v28 residue (93.3%/wrongKind 4) ────────────────────
  // "quiet down" was never a fader verb — the augmentation family silently
  // dropped; now routed, give the compound grammar its rows back
  en.push("quiet down the hats");
  en.push("quiet down the master");
  // menej-direction in the v-mixe scope (only the viac twin shipped in train)
  sk.push("menej reverbu v mixi");
  sk.push("menej dozvuku v mixi");
  sk.push("viac reverbu v mixi");
  // pad-family fader in the louder direction (only quieter shipped)
  sk.push("kick hlasnejší");
  sk.push("snare hlasnejšia");
  sk.push("clapy hlasnejšie");
  // bare saturation stays clarify (the val row had no train sibling)
  sk.push("menej saturácie");
  sk.push("viac saturácie prosím");

  // ── MIXED-LANGUAGE SENTENCES (SK verb + EN target/fx — real slang) ───────
  sk.push("daj more reverb na lead");
  sk.push("nastav delay na bass to 25%");
  sk.push("bypass reverb na drums prosím");
  sk.push("mute the bass a zvýš lead");

  // ── MINING WAVE (library-gate wave, 2026-09-30) — paraphrase siblings of
  // the families the ONNX val mining measured as confused (mix/production →
  // exact, transport/export/select → abstain, one-word mix descriptors).
  // These are NEW formulations appended at the corpus end (the every-7th val
  // split keeps its existing rows; only new indices join), each routed by the
  // deterministic teacher like the rest of the corpus ────────────────────────
  // one-word and short mix descriptors (the "darker"/"colder" cluster)
  en.push("darker please");
  en.push("a bit brighter");
  en.push("warmer mix");
  en.push("cold tone");
  en.push("make it warmer");
  en.push("make it darker");
  // transport: the bare verbs plus explicit playback forms
  en.push("stop playback");
  en.push("start playback");
  en.push("play the beat");
  en.push("pause the beat");
  en.push("loop on");
  en.push("loop off");
  en.push("metronome on");
  en.push("turn the metronome off");
  // export/select/tempo: short imperative forms the mining saw abstain
  en.push("export wav");
  en.push("export the mix as mp3");
  en.push("select drums");
  en.push("select the chords track");
  en.push("speed it up to 140");
  en.push("slow it down to 90");
  en.push("change bpm to 128");
  // send/bypass: the send vocabulary on more targets
  en.push("more delay send on the vocal");
  en.push("less reverb on the snare");
  en.push("more reverb on the hats");
  en.push("bypass delay on the lead");
  en.push("enable the compressor on the bass");
  en.push("disable reverb on the master");
  // percent/set precision (the percent head measured weakest)
  en.push("set the master volume to 80 percent");
  en.push("turn the lead down by 20 percent");
  en.push("raise the drums to 90%");
  en.push("lower the bass to 30%");
  // SK siblings of the confused families
  sk.push("tmavšie");
  sk.push("svetlejší mix");
  sk.push("teplejšie");
  sk.push("zastav prehrávanie");
  sk.push("pusti beat");
  sk.push("pauza");
  sk.push("metronóm zapni");
  sk.push("exportuj wav");
  sk.push("vyber basu");
  sk.push("zrýchli na 140");
  sk.push("spomaľ na 90");
  sk.push("viac delay send na vokál");
  sk.push("menej reverbu na snare");
  sk.push("bypass delay na leade");
  sk.push("nastav master na 80 percent");
  sk.push("zníž lead o 20 percent");

  // ── MINING WAVE 2 (2026-10-01) — breadth pass after n-gram featurization:
  // the char-gram featurizer eats vocabulary diversity now, so the corpus
  // grows along the val-mined weak families — fader verb/amount variety,
  // exact track ops, effect add/remove, send/bypass targets, loudness
  // targets, rare transport/export/select/tempo kinds, and their SK twins ──
  // fader: verbs and amount adverbs on the remaining targets
  en.push("turn the drums up");
  en.push("bring the bass down");
  en.push("drop the lead volume");
  en.push("lift the vocals");
  en.push("reduce the hats");
  en.push("trim the snare");
  en.push("push the chords louder");
  en.push("pull the bass quieter");
  en.push("slightly louder drums");
  en.push("much quieter bass");
  en.push("a lot more lead");
  en.push("give the chords a bit less");
  en.push("bass up 15%");
  en.push("drums down 20 percent");
  en.push("give the lead 30 percent more");
  en.push("kick at full volume");
  en.push("master to 100 percent");
  // exact ops: track management vocabulary
  en.push("add another drum track");
  en.push("remove the vocal track");
  en.push("delete the perc track");
  en.push("duplicate the lead track");
  en.push("rename bass to sub bass");
  en.push("solo the hats");
  en.push("unmute the lead");
  en.push("transpose the chords up 2 semitones");
  en.push("transpose the bass down an octave");
  en.push("set pattern length 64");
  en.push("length to 128");
  en.push("key of A minor");
  en.push("set the key to E minor");
  en.push("pan the hats left 60");
  en.push("pan the perc 40% right");
  // effectIntent: add/remove phrasing on more targets
  en.push("put reverb on the vocal");
  en.push("give the snare some delay");
  en.push("add chorus to the keys");
  en.push("add a phaser to the lead");
  en.push("remove the distortion from the bass");
  en.push("less compressor on the drums");
  en.push("more saturation on the bass");
  en.push("add tremolo to the keys");
  en.push("bitcrush the lead");
  en.push("flanger on the hats");
  // sendIntent / bypassIntent: the routing vocabulary on more targets
  en.push("increase reverb send on the snare");
  en.push("lower the delay send of the hats");
  en.push("send more reverb to the vocal");
  en.push("turn off reverb on the vocal");
  en.push("bypass the compressor on the master");
  en.push("enable chorus on the lead");
  en.push("disable the delay on the drums");
  // loudness targets
  en.push("set loudness to -14");
  en.push("make the mix -9 lufs");
  en.push("master at -12 lufs");
  en.push("loudness target -7");
  // rare kinds: transport / export / select / tempo
  en.push("stop the loop");
  en.push("start the metronome");
  en.push("loop this");
  en.push("pause playback");
  en.push("export the track as wav");
  en.push("export mp3 320");
  en.push("pick the bass track");
  en.push("go to the drums");
  en.push("set the bpm to 174");
  en.push("tempo 95");
  // mix overrides: the reverb/tone/punch/pump vocabulary
  en.push("more reverb in the mix");
  en.push("less reverb overall");
  en.push("darker tone");
  en.push("brighter tone in the mix");
  en.push("warm it up in the mix");
  en.push("less punch in the mix");
  en.push("pump on");
  // SK siblings of the weak families
  sk.push("ztichni bicie");
  sk.push("pridaj hlasitost leadu");
  sk.push("daj spev viac dopredu");
  sk.push("zníž hi-haty");
  sk.push("basu o 15 percent hlasiejšie");
  sk.push("master na 100 percent");
  sk.push("pridaj drum track");
  sk.push("zmaž vocal track");
  sk.push("duplicituj lead");
  sk.push("solo na hi-haty");
  sk.push("odmutuj spev");
  sk.push("transponuj akordy o 2 poltóny hore");
  sk.push("dĺžka patternu 64");
  sk.push("tonina E mol");
  sk.push("pan hi-haty doľava 60");
  sk.push("daj reverb na spev");
  sk.push("pridaj delay na snare");
  sk.push("menej saturácie na base");
  sk.push("vypni kompresor na mastri");
  sk.push("zapni chorus na leade");
  sk.push("hlasitosť na -14");
  sk.push("master na -9 lufs");
  sk.push("zastav sláčku");
  sk.push("metronóm vypni");
  sk.push("exportuj ako wav");
  sk.push("vyber drum track");
  sk.push("bpm na 174");
  sk.push("viac reverbu v mixe");
  sk.push("teplejší tón");
  sk.push("menej puncu v mixe");

  // ── MINING WAVE 3 (2026-10-01) — the val-mined slot-bias families: the
  // targets head's majority pull answers "bass" for lead/vocal/chords asks
  // (select, send, percent faders), the export head pulls wav, EN tempo
  // phrasings over bpm values the SK rows already teach, and the short
  // one/two-word mix descriptors abstain. Deterministic-layer routing keeps
  // every row honest; the every-7th split appends only new indices. ──
  // select: non-bass targets
  en.push("select the lead");
  en.push("select the vocal");
  en.push("select the chords");
  en.push("select the drums");
  // sendIntent: non-bass send targets
  en.push("more reverb send on the vocal");
  en.push("more delay send on the chords");
  en.push("add reverb send to the vocal");
  en.push("less reverb send on the lead");
  // fader + percent: non-bass targets (percent head + target pull)
  en.push("raise the lead by 15 percent");
  en.push("raise the vocal by 20 percent");
  en.push("raise the chords by 15 percent");
  en.push("pull the vocal down 25 percent");
  en.push("drums up 30 percent");
  // export: format minority
  en.push("export as mp3");
  en.push("export the project as mp3");
  // tempo: EN phrasings over taught bpm values
  en.push("set tempo to 90 bpm");
  en.push("set the tempo to 96 bpm");
  en.push("set tempo to 110 bpm");
  en.push("set the tempo to 150 bpm");
  // mix: short descriptors
  en.push("colder mix");
  en.push("a bit colder");
  en.push("warmer mix");
  en.push("brighter mix");
  en.push("darker mix");
  en.push("more glue in the mix");
  // SK siblings
  sk.push("vyber lead");
  sk.push("vyber spev");
  sk.push("vyber akordy");
  sk.push("viac reverb send na speve");
  sk.push("viac delay send na akordoch");
  sk.push("menej delay send na speve");
  sk.push("bicie o 25 percent hlasiejšie");
  sk.push("lead o 20 percent hore");
  sk.push("master na 80 percent");
  sk.push("master na 60 percent");
  sk.push("exportuj mp3");
  sk.push("tempo na 96");
  sk.push("tempo na 110");
  sk.push("chladnejší tón");

  // ── MINING WAVE 3b (2026-10-01) — margin-1.5 re-mine of the NEW artifact:
  // the wave-3 rows got the KIND right but the slot heads still pull to the
  // majority class (select-the-lead → bass, exportuj mp3 → wav, C# minor →
  // C minor, short fader descriptors abstain). Density on exactly those
  // families, nothing else. ──
  en.push("select lead");
  en.push("pick the lead track");
  en.push("select the vocal track");
  en.push("select vocal");
  en.push("export it as mp3");
  en.push("export to mp3");
  en.push("export the mix as mp3");
  en.push("set key to C# minor");
  en.push("set the key to F# minor");
  en.push("key of C# minor");
  en.push("louder lead");
  en.push("louder vocals");
  en.push("quieter lead");
  sk.push("exportuj projekt ako mp3");
  sk.push("export do mp3");
  sk.push("tonina C# mol");
  sk.push("hlasej lead");
  sk.push("ztichni spev");

  // ── MINING WAVE 3c (2026-10-01) — the new kind-only classes (arrange,
  // clips, compound, clarify, preset) are margin-shy: the heads know the
  // class but the kind gap sits under the 1.0 pin on paraphrase rows
  // (val-mined). Density on the SAME families via NEW formulations —
  // golden stays untouched (hold-out discipline). ──
  en.push("duplicate the bridge");
  en.push("duplicate the verse");
  en.push("copy the chorus");
  en.push("double the intro");
  en.push("double the build");
  en.push("shorten the verse to 4 bars");
  en.push("shorten the chorus to 2 bars");
  en.push("copy the chorus clip to bar 12");
  en.push("move the intro clip to bar 16");
  en.push("trim the clip at bar 3 to 4 bars");
  en.push("mute the drums and set tempo to 128");
  en.push("set tempo to 140 and mute the drums");
  en.push("add more compression");
  en.push("louder drums");
  en.push("quieter bass");
  en.push("mute the clap");
  en.push("mute the tom");
  en.push("add a pluck track");
  en.push("add a wavetable track");
  sk.push("duplicituj intro");
  sk.push("zdvojnásob drop");
  sk.push("skráti chorus na 2 takty");
  sk.push("stíš bicie a zvýš lead");
  sk.push("tempo na 128 a stíš bicie");
  sk.push("pridaj reverb na trubky");

  // ── MINING WAVE 4 (2026-10-01) — sequence-student phase 1: the arrange
  // family got slot heads (arrangeOp/arrangeRole/arrangeBars), so this wave
  // is arrange-paraphrase density over every op/role/bar combination the
  // closed heads must nail (duplicate/double/addRole/resize × roles × bar
  // counts). compound/clips stay at their current density — their payloads
  // are nested/engine-resolved and remain out of the classifier's scope. ──
  en.push("duplicate the outro");
  en.push("duplicate the fill");
  en.push("duplicate the verse");
  en.push("double the chorus");
  en.push("double the bridge");
  en.push("double the break");
  en.push("shorten the verse to 1 bar");
  en.push("shorten the bridge to 8 bars");
  en.push("extend the intro to 8 bars");
  sk.push("duplicituj chorus");
  sk.push("duplicituj bridge");
  sk.push("zdvojnásob intro");
  sk.push("zdvojnásob bridge");
  sk.push("skráti verse na 4 takty");
  sk.push("predĺž drop na 8 taktov");
  sk.push("skráť bridge na 1 takt");
  sk.push("pridaj outro");
  sk.push("pridaj intro sekciu");
  sk.push("pridaj fill za drop");
  sk.push("usporiadaj pesničku");

  return [
    { lang: "en", instructions: en },
    { lang: "sk", instructions: sk },
  ];
}

// ── Generation ──────────────────────────────────────────────────────────────

function main(): void {
  const doc = datasetDoc();
  const all: Array<Pair & { index: number }> = [];
  let index = 0;
  for (const { lang, instructions } of [...corpus(), ...augmentation()]) {
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
    "set the drums to 75%",
    "turn down the lead by 40 percent",
    "nastav kick na 80 %",
    "more chorus on the chords",
    "no delay send on the drums",
    "bypass reverb on the drums",
    "please stop",
    "mute the bass a zvýš lead",
    "make it quieter",
    "loudness na -9",
    "tempo dole",
    "vyber bicie",
    "set the snare to 100%",
    "mute the hats",
    "make the chords warmer",
    "export the project as mp3",
    "start recording",
    "stíš celý mix",
    "more energetic in the bridge",
    "wetter mix",
    "pan basu 30 pravo",
    "stíš bicie",
    "pan the lead 50% right",
    "set tempo to 126",
    "transpose the bass down three semitones",
    "set key to B minor",
    "add reverb to the bridge",
    "make the 808 deeper",
    "calmer",
    "trim the clip at bar 6 to 1 bars",
    "shorten the drop to 4 bars",
    "mute the drums and boost the mix by 2 dB",
    "more energetic in the chorus",
  ];
  const byInstruction = new Map(unique.map((p) => [p.instruction, p]));
  for (const pick of goldenPicks) {
    if (!byInstruction.has(pick)) {
      console.warn(`golden pick missing from the corpus (typo? parser dropped it?): "${pick}"`);
    }
  }
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
