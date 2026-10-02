import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileBriefContract } from "../src/intent/brief-contract";
import {
  createCreativeTaskRequestV1,
  validateCreativeTaskOutput,
  type CreativeTaskOutputV1,
} from "../src/intent/creative-task-contract";
import { creativeTaskOllamaSystemPrompt } from "../src/intent/creative-task-ollama";
import { parseIntentText } from "../src/intent/text-parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "scripts", "data", "creative-task-sft");
const GOLDEN_PATH = path.join(ROOT, "scripts", "data", "creative-task-v1-golden.jsonl");
const MAX_GOLDEN_BYTES = 4 * 1024 * 1024;
const SOURCE_PATHS = [
  "scripts/generate-creative-task-sft.mts",
  "scripts/run-creative-task-sft.mjs",
  "scripts/train-creative-task-sft.py",
  "src/ai/types.ts",
  "src/intent/creative-task-contract.ts",
  "src/intent/creative-task-ollama.ts",
  "src/intent/brief-contract.ts",
  "src/intent/text-parser.ts",
  "src/project-model/types.ts",
];

interface Scenario {
  id: string;
  family: string;
  split: "train" | "validation";
  operation: "generate" | "revise";
  prompts: { en: string[]; sk: string[] };
  output: CreativeTaskOutputV1;
}

interface SftRow {
  version: 1;
  id: string;
  family: string;
  split: "train" | "validation";
  language: "en" | "sk";
  source: "synthetic-author-authored-v1";
  operation: Scenario["operation"];
  prompt: string;
  instruction: string;
  response: CreativeTaskOutputV1;
}

const proposal = (suggestions: CreativeTaskOutputV1["suggestions"]): CreativeTaskOutputV1 => ({
  version: 1,
  status: "proposal",
  suggestions,
  unknownFields: [],
});

const scenarios: readonly Scenario[] = [
  {
    id: "percussive-trap",
    family: "percussive-trap-pocket",
    split: "train",
    operation: "generate",
    prompts: {
      en: [
        "Build a dark percussive trap loop at 142 BPM in C minor, eight bars, with a gritty low end.",
        "I want eight bars of gritty, dark trap: 142 BPM, C minor, percussion-forward.",
      ],
      sk: [
        "Sprav temný, perkusívny trap na 142 BPM v C mol, osem taktov, s drsným spodkom.",
        "Chcem osem taktov drsného temného trapu: 142 BPM, C mol, dôraz na perkusie.",
      ],
    },
    output: proposal({
      genre: "trap",
      style: "percussive trap",
      mood: "dark",
      bpmRange: [142, 142],
      key: "C Natural Minor",
      lengthSteps: 128,
      energy: 0.78,
      density: 0.58,
      complexity: 0.54,
      variation: 0.32,
    }),
  },
  {
    id: "two-step-garage",
    family: "two-step-garage-chord-preservation",
    split: "train",
    operation: "generate",
    prompts: {
      en: [
        "Make a warm two-step UK garage groove at 132 BPM for four bars; keep my chords untouched.",
        "Four bars of warm 2-step garage, 132 BPM. Leave the chord part exactly as it is.",
      ],
      sk: [
        "Urob teplý two-step UK garage groove na 132 BPM na štyri takty; akordy nechaj nedotknuté.",
        "Štyri takty teplého 2-step garage na 132 BPM. Akordov sa vôbec nedotýkaj.",
      ],
    },
    output: proposal({
      genre: "ukg",
      style: "two-step garage",
      mood: "warm",
      bpmRange: [132, 132],
      lengthSteps: 64,
      density: 0.38,
      preserveRoles: ["chords"],
    }),
  },
  {
    id: "cinematic-drill",
    family: "cinematic-drill-energy",
    split: "train",
    operation: "generate",
    prompts: {
      en: [
        "Create tense cinematic drill at 144 BPM in D minor, eight bars, and do not add a lead.",
        "Eight bars of D-minor drill, 144 BPM: tense and cinematic, with no lead part.",
      ],
      sk: [
        "Vytvor napätý filmový drill na 144 BPM v D mol, osem taktov, bez leadu.",
        "Osem taktov drillu v D mole, 144 BPM: napätý filmový zvuk a žiadny lead.",
      ],
    },
    output: proposal({
      genre: "drill",
      style: "cinematic drill",
      mood: "tense",
      bpmRange: [144, 144],
      key: "D Natural Minor",
      lengthSteps: 128,
      energy: 0.76,
      density: 0.52,
      prohibitedRoles: ["lead"],
    }),
  },
  {
    id: "amapiano-sunrise",
    family: "amapiano-sunrise-vocal-bed",
    split: "train",
    operation: "generate",
    prompts: {
      en: [
        "Give me an uplifting log-drum amapiano instrumental at 112 BPM, eight bars, with a spacious mix.",
        "Eight bars of spacious, sunrise-feeling amapiano around log drums, 112 BPM.",
      ],
      sk: [
        "Sprav nádejný amapiano inštrumentál s log drumom na 112 BPM, osem taktov a vzdušný mix.",
        "Osem taktov vzdušného amapiana s pocitom východu slnka a log drumom, 112 BPM.",
      ],
    },
    output: proposal({
      genre: "amapiano",
      style: "log-drum amapiano",
      mood: "uplifting",
      bpmRange: [112, 112],
      lengthSteps: 128,
      energy: 0.65,
      density: 0.42,
      complexity: 0.4,
      variation: 0.3,
    }),
  },
  {
    id: "liquid-dnb",
    family: "liquid-dnb-wide-texture",
    split: "train",
    operation: "generate",
    prompts: {
      en: [
        "Make a weightless liquid DnB passage at 174 BPM, sixteen bars, with a wide, flowing texture.",
        "Sixteen bars of flowing liquid drum and bass at 174 BPM; keep the mood weightless.",
      ],
      sk: [
        "Urob plynulý liquid DnB na 174 BPM, šestnásť taktov, so širokou a ľahkou atmosférou.",
        "Šestnásť taktov liquid drum and bass na 174 BPM; nech to pôsobí vzdušne a plynulo.",
      ],
    },
    output: proposal({
      genre: "dnb",
      style: "liquid drum and bass",
      mood: "weightless",
      bpmRange: [174, 174],
      lengthSteps: 256,
      energy: 0.7,
      density: 0.6,
      complexity: 0.56,
      variation: 0.28,
    }),
  },
  {
    id: "bounded-revision",
    family: "revision-mood-preserves-arrangement",
    split: "train",
    operation: "revise",
    prompts: {
      en: [
        "Keep the same arrangement, drums, and chords, but make the mood more wistful.",
        "Revise the existing idea to feel wistful; do not touch its drums or chord part.",
      ],
      sk: [
        "Nechaj rovnakú aranžáciu, bicie aj akordy, ale zmeň náladu na zasnenú a clivú.",
        "Uprav existujúci nápad, aby pôsobil clivo; bicie ani akordy nemeň.",
      ],
    },
    output: {
      version: 1,
      status: "proposal",
      suggestions: { mood: "wistful", preserveRoles: ["drums", "chords"] },
      unknownFields: [],
    },
  },
  {
    id: "conflicting-lead-request",
    family: "conflicting-lead-revision",
    split: "train",
    operation: "revise",
    prompts: {
      en: [
        "Keep the current lead melody unchanged, but replace it with a completely new lead melody.",
        "Do not change the lead at all; rewrite the lead from scratch.",
      ],
      sk: [
        "Súčasnú lead melódiu nechaj bez zmeny, ale nahraď ju úplne novou lead melódiou.",
        "Leadu sa vôbec nedotýkaj; prepíš ho celý od začiatku.",
      ],
    },
    output: {
      version: 1,
      status: "clarify",
      suggestions: {},
      unknownFields: ["roles"],
      question: "Should I preserve the current lead or replace it with a new one?",
    },
  },
  {
    id: "lyrics-only-request",
    family: "lyrics-writing-out-of-scope",
    split: "train",
    operation: "generate",
    prompts: {
      en: [
        "Write a full verse of lyrics for my singer; do not make any instrumental changes.",
        "Can you write the words for a sixteen-bar rap verse instead of making a beat?",
      ],
      sk: [
        "Napíš spevákovi celý text slohy; inštrumentál vôbec neupravuj.",
        "Namiesto tvorby beatu mi napíš text na šestnásť taktov rapovej slohy.",
      ],
    },
    output: { version: 1, status: "abstain", suggestions: {}, unknownFields: [] },
  },
  {
    id: "eurodance-lift",
    family: "eurodance-chorus-lift",
    split: "validation",
    operation: "generate",
    prompts: {
      en: [
        "Build an euphoric hands-up eurodance chorus at 136 BPM, eight bars, with a bright, high-energy lift.",
        "Eight bars of bright eurodance at 136 BPM; make it euphoric and big enough for a chorus.",
      ],
      sk: [
        "Vytvor euforický hands-up eurodance refrén na 136 BPM, osem taktov, jasný a energický.",
        "Osem taktov jasného eurodance na 136 BPM; nech je euforický a veľkolepý ako refrén.",
      ],
    },
    output: proposal({
      genre: "eurodance",
      style: "hands-up eurodance",
      mood: "euphoric",
      bpmRange: [136, 136],
      lengthSteps: 128,
      energy: 0.92,
      density: 0.72,
      variation: 0.66,
    }),
  },
  {
    id: "industrial-techno",
    family: "industrial-techno-pressure",
    split: "validation",
    operation: "generate",
    prompts: {
      en: [
        "Make a mechanical industrial techno section at 132 BPM, sixteen bars, relentless but not chaotic.",
        "Sixteen bars of controlled industrial techno, 132 BPM, with a cold mechanical mood.",
      ],
      sk: [
        "Urob mechanickú industriálnu techno pasáž na 132 BPM, šestnásť taktov, neúnavnú, ale nie chaotickú.",
        "Šestnásť taktov kontrolovaného industriálneho techna na 132 BPM so studenou mechanickou náladou.",
      ],
    },
    output: proposal({
      genre: "techno",
      style: "industrial techno",
      mood: "mechanical",
      bpmRange: [132, 132],
      lengthSteps: 256,
      energy: 0.84,
      density: 0.78,
      complexity: 0.62,
      variation: 0.42,
    }),
  },
  {
    id: "arcade-chiptune",
    family: "arcade-chiptune-keyed-loop",
    split: "validation",
    operation: "generate",
    prompts: {
      en: [
        "Create a playful arcade chiptune loop at 124 BPM in G major, four bars, with a simple hook.",
        "Four bars of a playful 8-bit game groove: G major, 124 BPM, catchy and uncomplicated.",
      ],
      sk: [
        "Vytvor hravý arkádový chiptune loop na 124 BPM v G dur, štyri takty, s jednoduchým motívom.",
        "Štyri takty hravého 8-bitového herného grooveu: G dur, 124 BPM, chytľavý a jednoduchý.",
      ],
    },
    output: proposal({
      genre: "chiptune",
      style: "arcade chiptune",
      mood: "playful",
      bpmRange: [124, 124],
      key: "G Major",
      lengthSteps: 64,
      energy: 0.64,
      density: 0.46,
      complexity: 0.28,
    }),
  },
  {
    id: "cinematic-drone",
    family: "cinematic-drone-suspense",
    split: "validation",
    operation: "generate",
    prompts: {
      en: [
        "Design an ominous cinematic drone bed at 72 BPM for sixteen bars, sparse and slowly evolving.",
        "Sixteen bars of a sparse film-score drone, 72 BPM, ominous with slow movement.",
      ],
      sk: [
        "Navrhni zlovestný filmový drone podklad na 72 BPM, šestnásť taktov, riedky a pomaly sa meniaci.",
        "Šestnásť taktov riedkeho filmového droneu na 72 BPM, zlovestný a s pomalým vývojom.",
      ],
    },
    output: proposal({
      genre: "drone",
      style: "cinematic drone",
      mood: "ominous",
      bpmRange: [72, 72],
      lengthSteps: 256,
      energy: 0.28,
      density: 0.18,
      variation: 0.24,
    }),
  },
  {
    id: "latin-pocket",
    family: "latin-reggaeton-pocket",
    split: "validation",
    operation: "generate",
    prompts: {
      en: [
        "Make a confident Latin reggaeton groove at 96 BPM, eight bars, with no lead melody.",
        "Eight bars of a confident reggaeton pocket at 96 BPM; do not generate a lead part.",
      ],
      sk: [
        "Urob sebavedomý latinský reggaeton groove na 96 BPM, osem taktov, bez lead melódie.",
        "Osem taktov sebavedomého reggaeton grooveu na 96 BPM; lead negeneruj.",
      ],
    },
    output: proposal({
      genre: "latin",
      style: "reggaeton",
      mood: "confident",
      bpmRange: [96, 96],
      lengthSteps: 128,
      energy: 0.72,
      density: 0.48,
      prohibitedRoles: ["lead"],
    }),
  },
  {
    id: "postrock-pulse",
    family: "postrock-build-preserving-drums",
    split: "validation",
    operation: "revise",
    prompts: {
      en: [
        "Turn the current idea into a patient post-rock build, but keep every drum part untouched.",
        "Revise the mood toward cinematic post-rock; preserve the existing drums exactly.",
      ],
      sk: [
        "Zmeň súčasný nápad na trpezlivý post-rockový build, ale všetky bicie nechaj nedotknuté.",
        "Posuň náladu k filmovému post-rocku; existujúce bicie presne zachovaj.",
      ],
    },
    output: {
      version: 1,
      status: "proposal",
      suggestions: { genre: "postrock", style: "cinematic post-rock", mood: "patient", preserveRoles: ["drums"] },
      unknownFields: [],
    },
  },
  {
    id: "underspecified-modernity",
    family: "underspecified-contemporary-style",
    split: "validation",
    operation: "revise",
    prompts: {
      en: [
        "Make the existing beat sound current, but I cannot name what should change.",
        "The beat needs to feel more contemporary. I am not sure whether I mean the drums, harmony, or sound palette.",
      ],
      sk: [
        "Chcem, aby súčasný beat znel aktuálnejšie, ale neviem pomenovať, čo treba zmeniť.",
        "Beat má pôsobiť modernejšie. Neviem, či myslím bicie, harmóniu alebo výber zvukov.",
      ],
    },
    output: {
      version: 1,
      status: "clarify",
      suggestions: {},
      unknownFields: ["style"],
      question: "Which part should feel more contemporary: drums, harmony, or sound palette?",
    },
  },
  {
    id: "press-release-request",
    family: "press-release-out-of-scope",
    split: "validation",
    operation: "generate",
    prompts: {
      en: [
        "Write a press release announcing my new single; do not create or edit any music.",
        "I need a marketing blurb for a release, not a beat or instrumental.",
      ],
      sk: [
        "Napíš tlačovú správu k môjmu novému singlu; hudbu netvor ani neupravuj.",
        "Potrebujem reklamný text k vydaniu, nie beat ani inštrumentál.",
      ],
    },
    output: { version: 1, status: "abstain", suggestions: {}, unknownFields: [] },
  },
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPrompt(prompt: string): string {
  return prompt.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function buildRequest(operation: Scenario["operation"], prompt: string) {
  const parsed = parseIntentText(prompt);
  const result = createCreativeTaskRequestV1({
    operation,
    prompt,
    intent: parsed.input,
    contract: compileBriefContract(parsed),
  });
  if (!result.ok) throw new Error(`Could not build creative request: ${result.reason} (${prompt})`);
  return result.request;
}

function validateTeacherAgreement(scenario: Scenario, request: ReturnType<typeof buildRequest>): void {
  const checked = validateCreativeTaskOutput(scenario.output);
  if (!checked.ok) throw new Error(`Invalid target for ${scenario.id}: ${checked.error}`);
  if (checked.output.status !== "proposal") return;
  const suggestions = checked.output.suggestions;
  const required = request.requirements;
  const exactPairs: Array<[string, unknown, unknown]> = [
    ["bpmRange", required.bpmRange, suggestions.bpmRange],
    ["key", required.key, suggestions.key],
    ["lengthSteps", required.lengthSteps, suggestions.lengthSteps],
    ["preserveRoles", request.preserveRoles.length > 0 ? request.preserveRoles : null, suggestions.preserveRoles],
    [
      "prohibitedRoles",
      request.prohibitedRoles.length > 0 ? request.prohibitedRoles : null,
      suggestions.prohibitedRoles,
    ],
  ];
  // Genre/style/mood are semantic labels: the model may correct a parser
  // misclassification, while tempo/key/length and protected-role facts may
  // never be dropped or changed.
  for (const [field, explicit, target] of exactPairs) {
    if (explicit !== null && stableJson(explicit) !== stableJson(target)) {
      throw new Error(
        `Target for ${scenario.id} drops or changes explicit ${field}: ${stableJson(explicit)} != ${stableJson(target)}.`,
      );
    }
  }
  if (request.preserveRoles.some((role) => suggestions.targetRoles?.includes(role))) {
    throw new Error(`Target for ${scenario.id} generates into a preserved role.`);
  }
  if (request.prohibitedRoles.some((role) => suggestions.targetRoles?.includes(role))) {
    throw new Error(`Target for ${scenario.id} generates into a prohibited role.`);
  }
}

function responseFor(scenario: Scenario, request: ReturnType<typeof buildRequest>): CreativeTaskOutputV1 {
  const checked = validateCreativeTaskOutput(scenario.output);
  if (!checked.ok) throw new Error(`Invalid target for ${scenario.id}: ${checked.error}`);
  if (checked.output.status !== "proposal") return checked.output;

  const suggestions = { ...checked.output.suggestions };
  const copyIfMissing = <K extends keyof typeof suggestions>(field: K, value: (typeof suggestions)[K] | undefined) => {
    if (value !== undefined && suggestions[field] === undefined) suggestions[field] = value;
  };
  copyIfMissing("genre", request.preferences.genre ?? undefined);
  copyIfMissing("style", request.preferences.style ?? undefined);
  copyIfMissing("mood", request.preferences.mood ?? undefined);
  copyIfMissing("bpmRange", request.requirements.bpmRange ?? undefined);
  copyIfMissing("key", request.requirements.key ?? undefined);
  copyIfMissing("lengthSteps", request.requirements.lengthSteps ?? undefined);
  const roleOrder = ["drums", "bass", "chords", "lead"] as const;
  const preserveRoles = new Set([...request.preserveRoles, ...(suggestions.preserveRoles ?? [])]);
  const prohibitedRoles = new Set([...request.prohibitedRoles, ...(suggestions.prohibitedRoles ?? [])]);
  const protectedRoles = new Set([...preserveRoles, ...prohibitedRoles]);
  if (preserveRoles.size > 0) suggestions.preserveRoles = roleOrder.filter((role) => preserveRoles.has(role));
  if (prohibitedRoles.size > 0) suggestions.prohibitedRoles = roleOrder.filter((role) => prohibitedRoles.has(role));
  const proposedTargets = suggestions.targetRoles ?? request.requirements.targetRoles;
  if (proposedTargets.length > 0) {
    const safeTargets = proposedTargets.filter((role) => !protectedRoles.has(role));
    if (safeTargets.length > 0) suggestions.targetRoles = roleOrder.filter((role) => safeTargets.includes(role));
    else delete suggestions.targetRoles;
  }
  const result = validateCreativeTaskOutput({ ...checked.output, suggestions });
  if (!result.ok) {
    throw new Error(
      `Merged target for ${scenario.id} is invalid: ${result.error}; suggestions=${JSON.stringify(suggestions)}; requestRoles=${JSON.stringify({ targets: request.requirements.targetRoles, preserve: request.preserveRoles, prohibited: request.prohibitedRoles })}`,
    );
  }
  return result.output;
}

function readGolden(): { bytes: Buffer; rows: Array<{ id: string; family: string; prompt: string }> } {
  const bytes = readFileSync(GOLDEN_PATH);
  if (bytes.byteLength > MAX_GOLDEN_BYTES) throw new Error("Creative held-out golden exceeds the 4 MiB safety limit.");
  const rows = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const value = JSON.parse(line) as unknown;
        if (
          typeof value !== "object" ||
          value === null ||
          !("id" in value) ||
          typeof value.id !== "string" ||
          !("family" in value) ||
          typeof value.family !== "string" ||
          !("prompt" in value) ||
          typeof value.prompt !== "string"
        ) {
          throw new Error("invalid fields");
        }
        return { id: value.id, family: value.family, prompt: value.prompt };
      } catch {
        throw new Error(`Invalid held-out creative golden row ${index + 1}.`);
      }
    });
  return { bytes, rows };
}

function buildCorpus() {
  const golden = readGolden();
  const promptBytes = Buffer.from(creativeTaskOllamaSystemPrompt(), "utf8");
  const rows: SftRow[] = [];
  for (const scenario of scenarios) {
    if (!scenario.id || !scenario.family || scenario.prompts.en.length !== 2 || scenario.prompts.sk.length !== 2) {
      throw new Error(`Scenario ${scenario.id} must have two English and two Slovak prompt variants.`);
    }
    for (const language of ["en", "sk"] as const) {
      for (const [variant, prompt] of scenario.prompts[language].entries()) {
        const request = buildRequest(scenario.operation, prompt);
        const response = responseFor(scenario, request);
        validateTeacherAgreement({ ...scenario, output: response }, request);
        rows.push({
          version: 1,
          id: `${scenario.id}-${language}-${variant + 1}`,
          family: scenario.family,
          split: scenario.split,
          language,
          source: "synthetic-author-authored-v1",
          operation: scenario.operation,
          prompt,
          instruction: JSON.stringify(request),
          response,
        });
      }
    }
  }

  const ids = new Set<string>();
  const prompts = new Set<string>();
  const familyBySplit: Record<SftRow["split"], Set<string>> = { train: new Set(), validation: new Set() };
  const goldenIds = new Set(golden.rows.map((row) => row.id));
  const goldenFamilies = new Set(golden.rows.map((row) => row.family));
  const goldenPrompts = new Set(golden.rows.map((row) => normalizedPrompt(row.prompt)));
  for (const row of rows) {
    const normalized = normalizedPrompt(row.prompt);
    if (ids.has(row.id)) throw new Error(`Duplicate creative SFT id: ${row.id}`);
    if (prompts.has(normalized)) throw new Error(`Duplicate normalized creative SFT prompt: ${row.id}`);
    if (goldenIds.has(row.id) || goldenPrompts.has(normalized)) {
      throw new Error(`Creative SFT row overlaps the held-out golden: ${row.id}`);
    }
    if (goldenFamilies.has(row.family))
      throw new Error(`Creative SFT family leaks into held-out golden: ${row.family}`);
    ids.add(row.id);
    prompts.add(normalized);
    familyBySplit[row.split].add(row.family);
  }
  const familyOverlap = [...familyBySplit.train].filter((family) => familyBySplit.validation.has(family));
  if (familyOverlap.length > 0) throw new Error(`Train/validation family leakage: ${familyOverlap.join(", ")}`);

  const train = rows.filter((row) => row.split === "train");
  const validation = rows.filter((row) => row.split === "validation");
  const jsonl = (entries: readonly SftRow[]) =>
    Buffer.from(`${entries.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const trainBytes = jsonl(train);
  const validationBytes = jsonl(validation);
  const sourceHashes = Object.fromEntries(
    SOURCE_PATHS.map((relativePath) => [relativePath, sha256(readFileSync(path.join(ROOT, relativePath)))]),
  );
  const manifest = {
    formatVersion: 1,
    task: "creative-task-v1",
    purpose: "synthetic output-contract and extraction bootstrap; not a production-quality corpus",
    synthetic: true,
    humanReviewed: false,
    eligibleForModelPromotion: false,
    prompt: { path: "prompt.txt", sha256: sha256(promptBytes) },
    splits: {
      train: {
        path: "train.jsonl",
        rows: train.length,
        families: [...familyBySplit.train].sort(),
        sha256: sha256(trainBytes),
      },
      validation: {
        path: "validation.jsonl",
        rows: validation.length,
        families: [...familyBySplit.validation].sort(),
        sha256: sha256(validationBytes),
      },
    },
    heldOutGolden: {
      path: "../creative-task-v1-golden.jsonl",
      rows: golden.rows.length,
      sha256: sha256(golden.bytes),
      familyOverlap: [],
      exactPromptOverlap: false,
    },
    sourceHashes,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { promptBytes, trainBytes, validationBytes, manifestBytes, rows };
}

const generated = buildCorpus();
const files = [
  ["prompt.txt", generated.promptBytes],
  ["train.jsonl", generated.trainBytes],
  ["validation.jsonl", generated.validationBytes],
  ["manifest.json", generated.manifestBytes],
] as const;
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: vite-node scripts/generate-creative-task-sft.mts [--check]");
}

if (checkOnly) {
  const stale = files.filter(([name, expected]) => {
    const filePath = path.join(DATA_DIR, name);
    return !existsSync(filePath) || !readFileSync(filePath).equals(expected);
  });
  if (stale.length > 0) throw new Error(`Creative SFT artifacts are stale: ${stale.map(([name]) => name).join(", ")}`);
  process.stdout.write(
    `Creative SFT corpus verified: ${generated.rows.length} rows; ${generated.rows.filter((row) => row.split === "train").length} train, ${generated.rows.filter((row) => row.split === "validation").length} validation; zero family/prompt overlap.\n`,
  );
} else {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(path.join(DATA_DIR, name), bytes);
  process.stdout.write(
    `Generated creative SFT bootstrap: ${generated.rows.length} rows (${generated.rows.filter((row) => row.split === "train").length} train, ${generated.rows.filter((row) => row.split === "validation").length} validation). Human review and model-promotion gates remain open.\n`,
  );
}
