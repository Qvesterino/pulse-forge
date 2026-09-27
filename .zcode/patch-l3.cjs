const fs = require("node:fs");
const path = "src/intent/production.ts";
let src = fs.readFileSync(path, "utf8");
let applied = 0;
const must = (label, needle) => {
  if (!src.includes(needle)) {
    console.error("FAIL(" + label + "): needle not found");
    process.exit(1);
  }
  applied++;
};

/* 1. widen the concept union */
must("union", '  | "metallic";');
src = src.replace(
  '  | "metallic";',
  `  | "metallic"
  // Level 3 — device-level asks. Each maps onto an effect that already
  // exists in the registry with canonical params, so nothing here invents
  // a new DSP path: the concept only decides WHICH device and with which
  // starting values, and the amount scales the primary parameter.
  | "filter"
  | "sidechain"
  | "phaser"
  | "chorus"
  | "sharper"
  | "reverse"
  | "crunchy"
  | "vinyl"
  | "wide"
  | "sub"
  | "air";`,
);

/* 2. register the new concept ids */
must("concepts", `  "metallic",
];`);
src = src.replace(
  `  "metallic",
];`,
  `  "metallic",
  "filter",
  "sidechain",
  "phaser",
  "chorus",
  "sharper",
  "reverse",
  "crunchy",
  "vinyl",
  "wide",
  "sub",
  "air",
];`,
);

/* 3. detection patterns + default target, ENGLISH FIRST */
must("defs", `  {
    concept: "stutter",`);
src = src.replace(
  `  {
    concept: "stutter",`,
  `  // ---- Level 3: device-level asks (EN first, SK alongside) ----------
  {
    concept: "filter",
    defaultTarget: "lead",
    // "filter" alone is a DEVICE name; without a movement word it is far
    // too generic to claim a request ("add a filter to the mix" is a mix
    // ask, not a lead ask), so the pattern requires a sweep-ish verb
    // alongside it and accepts the bare device name only after one of
    // the add/apply verbs.
    patterns: [
      /\\bauto-?filter\\b/,
      /\\badd (?:an? )?filter\\b/,
      /\\b(?:sweep|sweeping|filter sweep|filter sweep)\\b/,
      /\\bautofiltr\\b/,
      /\\bautomatick[ýy] filter\\b/,
    ],
  },
  {
    concept: "sidechain",
    defaultTarget: "bass",
    patterns: [
      /\\bside-?chain\\b/,
      /\\bpumping\\b/,
      /\\bpump(?:s|ing|ed)? (?:bass|under|to)\\b/,
      /\\bduck(?:s|ing|ed)?\\b/,
      /\\bdukladn[ýy] bass\\b/,
    ],
  },
  {
    concept: "phaser",
    defaultTarget: "lead",
    patterns: [/\\bphaser\\b/, /\\bphase-?r\\b/i, /\\bfazov[ýy] filter\\b/, /\\bfázovka\\b/],
  },
  {
    concept: "chorus",
    defaultTarget: "lead",
    patterns: [/\\bchorus(?: (?:effect|on))?\\b/, /\\bchorus-?er\\b/, /\\bchorus-?ed\\b/, /\\bchór(u|us)?\\b/, /\\bchvrv/i],
  },
  {
    concept: "sharper",
    defaultTarget: "lead",
    // Sharper is the TRANSPOSE ask ("sharper", "two steps up"), distinct
    // from "brighter" which is a tone/tilt ask on the same word family.
    patterns: [
      /\\bsharper\\b/,
      /\\b(?:two|2|three|3) (?:steps?|semitones?|keys?) up\\b/,
      /\\bo dva (?:kroky|tóny|polotóny) vyššie\\b/,
      /\\btranspose (?:up|higher)\\b/,
    ],
  },
  {
    concept: "reverse",
    defaultTarget: "lead",
    patterns: [/\\breverse(?:d)?\\b/, /\\bbackwards?\\b/, /\\bspätn(?:ý|e|om)\\b/, /\\bskúten(?:ý|á|é)\\b/],
  },
  {
    concept: "crunchy",
    defaultTarget: "drums",
    patterns: [
      /\\bcrunchy\\b/,
      /\\bbit-?crush(?:ed|er)?\\b/,
      /\\bbit-?crush\\b/,
      /\\b8-?bit\\b/,
      /\\blo-?fi bit\\b/,
      /\\bkŕhav[ýy] zvuk\\b/,
    ],
  },
  {
    concept: "vinyl",
    defaultTarget: "drums",
    // "lofi" already owns the vintage/vinyl word family, so this concept
    // is the EXPLICIT device ask. Deliberately no bare /\\bvinyl\\b/ — the
    // first matching concept in CONCEPTS order wins, and "lofi" is
    // declared earlier with /\\bvinyl(?:-?ier)?\\b/, so a bare "vinyl"
    // still routes there. This catches "crackle" and "wow/flutter",
    // the two things a user names when they mean the DEVICE.
    patterns: [
      /\\bcrackle\\b/,
      /\\bpop(?:s|ping) and hissl?\\b/,
      /\\bwow(?: and| \\+)? flutter\\b/,
      /\\bvinyl (?:crackle|effect|noise)\\b/,
      /\\bsk[rv]ip(?:nutie|ov|\\\\u011b?)\\b/,
    ],
  },
  {
    concept: "wide",
    defaultTarget: "chords",
    // Distinct from "wider" (a gradient on the same haasWidener):
    // "wide" asks for a STEREO image on a track that has none, which
    // is a mix ask, so it targets chords and blends the two.
    patterns: [/\\bwide(?:r)? stereo\\b/, /\\bwide mix\\b/, /\\bstereo width\\b/, /\\bsirok[ýy] mix\\b/],
  },
  {
    concept: "sub",
    defaultTarget: "bass",
    patterns: [/\\bmore sub\\b/, /\\bsub-?heavy\\b/, /\\bfat sub\\b/, /\\bsub boost\\b/, /\\bhust[ýy] sub\\b/],
  },
  {
    concept: "air",
    defaultTarget: "lead",
    patterns: [
      /\\bmore air\\b/,
      /\\bairy\\b/,
      /\\bair(?:y)? (?:top|top end|presence)\\b/,
      /\\bopen (?:the )?(?:top|highs?)\\b/,
      /\\bvzduch\\b/,
      /\\bosvecenie\\b/,
    ],
  },
  {
    concept: "stutter",`,
);

/* 4. planner actions */
must("switch", `        case "stutter":`);
src = src.replace(
  `        case "stutter":`,
  `        // ---- Level 3 device asks. Params are CANONICAL ids verified
        // against src/effects/definitions.ts — normalizeEffects drops any
        // key that is not in the effect's own ParamDef list, so an id
        // that looks right but is not whitelisted would make the whole
        // action silent.
        case "filter":
          // svFilter mode 2 is the band-pass sweep family; cutoff lands
          // between a musical 400 Hz and a sub-audible 80 Hz so the
          // amount reads as sweep depth, not as a static filter.
          actions.push({
            trackId,
            type: "svFilter",
            params: {
              mode: 2,
              cutoff: Math.round(900 / Math.pow(10, goal.amount * 0.7)),
              resonance: Math.min(1, 0.3 + goal.amount * 0.5),
              mix: Math.min(1, 0.4 + goal.amount * 0.5),
            },
          });
          break;
        case "sidechain":
          // amount is a 0..1 BLEND, not a depth: the duck depth comes
          // from threshold + ratio, and amount only decides how much of
          // that reduction is applied. attack/release are SECONDS.
          actions.push({
            trackId,
            type: "sidechain",
            params: {
              threshold: -18,
              ratio: Math.round(2 + goal.amount * 6),
              attack: 0.001,
              release: 0.18,
              amount: Math.min(1, 0.5 + goal.amount * 0.5),
              splitFreq: 180,
            },
            sidechainFromDrums: true,
          });
          break;
        case "phaser":
          actions.push({
            trackId,
            type: "phaser",
            params: {
              rate: Math.round(0.15 + goal.amount * 0.6),
              depth: Math.min(1, 0.4 + goal.amount * 0.5),
              center: 800,
              feedback: Math.min(0.9, goal.amount * 0.45),
              stages: 4,
              mix: Math.min(1, 0.5 + goal.amount * 0.45),
            },
          });
          break;
        case "chorus":
          actions.push({
            trackId,
            type: "chorus",
            params: {
              rate: Math.round(0.2 + goal.amount * 0.5),
              depth: Math.min(1, 0.3 + goal.amount * 0.5),
              base: 12,
              spread: Math.min(1, 0.4 + goal.amount * 0.5),
              voices: 3,
              mix: Math.min(1, 0.4 + goal.amount * 0.5),
            },
          });
          break;
        case "sharper":
          // Transpose ask: semitones is the primary and the amount
          // scales it, so "sharper" nudges +2 and "much sharper" +7.
          actions.push({
            trackId,
            type: "pitchShift",
            params: {
              semitones: Math.round(1 + goal.amount * 6),
              fine: 0,
              grainMs: 55,
              width: 0.2,
              mix: 1,
            },
          });
          break;
        case "reverse":
          actions.push({
            trackId,
            type: "reverseSwell",
            params: {
              engaged: 1,
              time: Math.round(0.4 + goal.amount * 2.4),
              reach: Math.min(1, 0.5 + goal.amount * 0.5),
              curve: 2,
              tone: 4200,
              level: Math.min(1, 0.4 + goal.amount * 0.5),
              mix: 1,
            },
          });
          break;
        case "crunchy":
          // bits is DESCENDING: fewer bits = crunchier, so the amount
          // maps straight onto the bit count and the range is kept off
          // 1 (a true 1-bit crush is a square wave, not a usable loop).
          actions.push({
            trackId,
            type: "bitcrusher",
            params: {
              bits: Math.max(3, Math.round(12 - goal.amount * 7)),
              downsample: Math.max(1, Math.round(2 + goal.amount * 6)),
              drive: Math.min(1, 0.1 + goal.amount * 0.5),
              tone: 6000,
              mix: Math.min(1, 0.5 + goal.amount * 0.5),
            },
          });
          break;
        case "vinyl":
          // The DEVICE ask, distinct from the "lofi" tone concept which
          // already owns the bare word: crackle and wow/flutter are the
          // two things a user names when they mean the device.
          actions.push({
            trackId,
            type: "vinyl",
            params: {
              amount: Math.min(1, 0.3 + goal.amount * 0.6),
              crackle: Math.min(1, 0.3 + goal.amount * 0.6),
              hiss: Math.min(1, goal.amount * 0.5),
              wow: Math.min(1, goal.amount * 0.6),
              flutter: Math.min(1, goal.amount * 0.45),
              rumble: Math.min(1, goal.amount * 0.4),
              year: 0.7,
              toneLp: 9000,
              mix: Math.min(1, 0.5 + goal.amount * 0.5),
            },
          });
          break;
        case "wide":
          // haasWidener with crossfeed for a genuinely wide image
          // rather than the "wider" concept's single-stage Haas.
          actions.push({
            trackId,
            type: "haasWidener",
            params: {
              delayMs: 18,
              width: Math.min(1, 0.45 + goal.amount * 0.55),
              crossfeed: Math.min(0.5, goal.amount * 0.4),
              feedback: 0,
            },
          });
          break;
        case "sub":
          // bassBuss subEnhance is the dedicated sub driver; a plain
          // lowShelf would lift the mud along with the sub.
          actions.push({
            trackId,
            type: "bassBuss",
            params: {
              subEnhance: Math.min(1, 0.3 + goal.amount * 0.6),
              subOsc: 0,
              subFrequency: 42,
              drive: 0,
              compression: 0.2,
              monoBassFrequency: 110,
              mix: Math.min(1, 0.5 + goal.amount * 0.5),
            },
          });
          break;
        case "air":
          // highShelfGain is the air band; an EQ lowShelf is NOT a
          // substitute because it moves energy the user did not ask for.
          actions.push({
            trackId,
            type: "eq",
            params: {
              highShelfFreq: 11000,
              highShelfGain: Math.round(2 + goal.amount * 6),
              highMidFreq: 3000,
              highMidGain: Math.round(1 + goal.amount * 3),
            },
          });
          break;
        case "stutter":`,
);

fs.writeFileSync(path, src, "utf8");
console.log("OK: applied " + applied + " anchors");
