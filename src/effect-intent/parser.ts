import {
  EFFECT_INTENT_PARSER_VERSION,
  EFFECT_INTENT_SCHEMA_VERSION,
  type EffectIntentDirection,
  type EffectIntentGoal,
  type EffectIntentParseResult,
  type EffectIntentProtectedArea,
  type EffectIntentSpec,
} from "./types";

type GoalPhrase = { phrase: string; goal: EffectIntentGoal; direction: EffectIntentDirection };

const GOAL_PHRASES: readonly GoalPhrase[] = [
  { phrase: "teplejsie", goal: "warmth", direction: "increase" },
  { phrase: "teplejsi", goal: "warmth", direction: "increase" },
  { phrase: "zohrej", goal: "warmth", direction: "increase" },
  { phrase: "warmth", goal: "warmth", direction: "increase" },
  { phrase: "warmer", goal: "warmth", direction: "increase" },
  { phrase: "warm", goal: "warmth", direction: "increase" },
  { phrase: "chladnejsie", goal: "warmth", direction: "decrease" },
  { phrase: "chladnejsi", goal: "warmth", direction: "decrease" },
  { phrase: "cooler", goal: "warmth", direction: "decrease" },
  { phrase: "cool", goal: "warmth", direction: "decrease" },
  { phrase: "jasnejsie", goal: "brightness", direction: "increase" },
  { phrase: "jasnejsi", goal: "brightness", direction: "increase" },
  { phrase: "rozjasni", goal: "brightness", direction: "increase" },
  { phrase: "brighter", goal: "brightness", direction: "increase" },
  { phrase: "brighten", goal: "brightness", direction: "increase" },
  { phrase: "tmavsie", goal: "brightness", direction: "decrease" },
  { phrase: "tmavsi", goal: "brightness", direction: "decrease" },
  { phrase: "ztmav", goal: "brightness", direction: "decrease" },
  { phrase: "darker", goal: "brightness", direction: "decrease" },
  { phrase: "darken", goal: "brightness", direction: "decrease" },
  { phrase: "viac priestoru", goal: "space", direction: "increase" },
  { phrase: "vacsi priestor", goal: "space", direction: "increase" },
  { phrase: "viac reverbu", goal: "space", direction: "increase" },
  { phrase: "more space", goal: "space", direction: "increase" },
  { phrase: "more spacious", goal: "space", direction: "increase" },
  { phrase: "more reverb", goal: "space", direction: "increase" },
  { phrase: "suchsie", goal: "space", direction: "decrease" },
  { phrase: "suchsi", goal: "space", direction: "decrease" },
  { phrase: "menej priestoru", goal: "space", direction: "decrease" },
  { phrase: "menej reverbu", goal: "space", direction: "decrease" },
  { phrase: "less space", goal: "space", direction: "decrease" },
  { phrase: "less reverb", goal: "space", direction: "decrease" },
  { phrase: "drier", goal: "space", direction: "decrease" },
  { phrase: "dryer", goal: "space", direction: "decrease" },
  { phrase: "dry", goal: "space", direction: "decrease" },
];

const PRESERVE_PHRASES: readonly { phrase: string; area: EffectIntentProtectedArea }[] = [
  { phrase: "bez zmeny nizkych frekvencii", area: "lowEnd" },
  { phrase: "bez zmeny nizkych", area: "lowEnd" },
  { phrase: "bez zmeny basov", area: "lowEnd" },
  { phrase: "nechaj basy tak", area: "lowEnd" },
  { phrase: "nechaj bas tak", area: "lowEnd" },
  { phrase: "keep the low end", area: "lowEnd" },
  { phrase: "keep low end", area: "lowEnd" },
  { phrase: "preserve the bass", area: "lowEnd" },
  { phrase: "preserve bass", area: "lowEnd" },
  { phrase: "dont change the bass", area: "lowEnd" },
  { phrase: "dont change bass", area: "lowEnd" },
  { phrase: "bez zmeny vysok", area: "highs" },
  { phrase: "bez zmeny vysek", area: "highs" },
  { phrase: "nechaj vysky tak", area: "highs" },
  { phrase: "nechaj vysky", area: "highs" },
  { phrase: "vysky tak", area: "highs" },
  { phrase: "highs unchanged", area: "highs" },
  { phrase: "highs as is", area: "highs" },
  { phrase: "highs alone", area: "highs" },
  { phrase: "keep the highs", area: "highs" },
  { phrase: "keep highs", area: "highs" },
  { phrase: "preserve the highs", area: "highs" },
  { phrase: "preserve highs", area: "highs" },
  { phrase: "dont change the highs", area: "highs" },
  { phrase: "dont change highs", area: "highs" },
  { phrase: "bez zmeny sterea", area: "stereo" },
  { phrase: "nechaj stereo tak", area: "stereo" },
  { phrase: "stereo tak", area: "stereo" },
  { phrase: "stereo unchanged", area: "stereo" },
  { phrase: "stereo as is", area: "stereo" },
  { phrase: "keep the stereo", area: "stereo" },
  { phrase: "keep stereo", area: "stereo" },
  { phrase: "preserve stereo", area: "stereo" },
  { phrase: "dont change the stereo", area: "stereo" },
  { phrase: "dont change stereo", area: "stereo" },
  { phrase: "bez pridania drive", area: "drive" },
  { phrase: "bez drive", area: "drive" },
  { phrase: "without adding drive", area: "drive" },
  { phrase: "without drive", area: "drive" },
  { phrase: "dont add drive", area: "drive" },
  { phrase: "dont change drive", area: "drive" },
];

const FILLER_WORDS = new Set([
  "a", "ale", "ako", "and", "but", "bit", "can", "could", "do", "for", "i", "it", "keep", "leave", "make", "me", "mi", "na",
  "please", "prosim", "prosimta", "set", "sound", "sprav", "to", "urob", "you", "chcem", "chcela", "chcel",
  "nech", "tak", "the", "trochu", "jemne", "mierne", "slightly", "subtly", "subtle", "little", "much",
  "really", "more", "less", "a", "very", "viac", "menej", "unchanged", "alone", "as", "is", "same", "zvuk", "zvukovo", "ho", "ju", "toho", "ten",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function phrasePattern(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`, "g");
}

function consume(text: string, phrase: string): { text: string; found: boolean } {
  const pattern = phrasePattern(phrase);
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return { text: text.replace(pattern, " ").replace(/\s+/g, " ").trim(), found };
}

function intensityOf(text: string): { amount: number; residual: string; conflict: boolean } {
  const levels: Array<{ phrase: string; amount: number }> = [
    { phrase: "very", amount: 0.9 },
    { phrase: "a lot", amount: 0.9 },
    { phrase: "much", amount: 0.9 },
    { phrase: "vyrazne", amount: 0.9 },
    { phrase: "poriadne", amount: 0.9 },
    { phrase: "really", amount: 0.9 },
    { phrase: "slightly", amount: 0.3 },
    { phrase: "subtly", amount: 0.3 },
    { phrase: "a little", amount: 0.3 },
    { phrase: "little", amount: 0.3 },
    { phrase: "trochu", amount: 0.3 },
    { phrase: "jemne", amount: 0.3 },
    { phrase: "mierne", amount: 0.3 },
  ];
  let residual = text;
  const found = new Set<number>();
  for (const level of levels) {
    const consumed = consume(residual, level.phrase);
    if (!consumed.found) continue;
    found.add(level.amount);
    residual = consumed.text;
  }
  return { amount: found.size > 0 ? Math.max(...found) : 0.6, residual, conflict: found.size > 1 };
}

export function parseEffectIntent(sourceText: string): EffectIntentParseResult {
  if (sourceText.length > 500) {
    return { status: "unsupported", diagnostics: ["Požiadavka je príliš dlhá. Skráť ju na jeden krátky zvukový zámer."] };
  }
  const normalized = normalizeText(sourceText);
  if (!normalized) return { status: "needsClarification", diagnostics: ["Opíš, akú zvukovú zmenu chceš."] };

  let residual = normalized;
  const preserve = new Set<EffectIntentProtectedArea>();
  // Longer phrases first so "keep the low end" is consumed as one constraint.
  for (const item of [...PRESERVE_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length)) {
    const consumed = consume(residual, item.phrase);
    if (!consumed.found) continue;
    preserve.add(item.area);
    residual = consumed.text;
  }

  const requested = new Map<EffectIntentGoal, Set<EffectIntentDirection>>();
  for (const item of [...GOAL_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length)) {
    const consumed = consume(residual, item.phrase);
    if (!consumed.found) continue;
    const directions = requested.get(item.goal) ?? new Set<EffectIntentDirection>();
    directions.add(item.direction);
    requested.set(item.goal, directions);
    residual = consumed.text;
  }

  const intensity = intensityOf(residual);
  residual = intensity.residual;
  const unknown = residual
    .split(" ")
    .filter((word) => word && !FILLER_WORDS.has(word));
  if (unknown.length > 0) {
    return {
      status: "unsupported",
      diagnostics: [`Zatiaľ nepoznám výraz „${unknown.join(" ")}“. Skús konkrétnejšie: teplejšie, jasnejšie alebo viac/menej priestoru.`],
    };
  }
  if (intensity.conflict) {
    return {
      status: "needsClarification",
      diagnostics: ["Použi jednu intenzitu zmeny (napríklad „jemne“ alebo „výrazne“)."],
    };
  }
  if (requested.size === 0) {
    return {
      status: "needsClarification",
      diagnostics: ["Rozpoznal som iba obmedzenie, nie cieľ zmeny. Skús teplejšie, jasnejšie alebo viac/menej priestoru."],
    };
  }

  const goals: EffectIntentSpec["goals"] = [];
  for (const [goal, directions] of requested) {
    if (directions.size > 1) {
      return {
        status: "needsClarification",
        diagnostics: [`Požiadavka súčasne žiada zmenu „${goal}“ oboma smermi.`],
      };
    }
    goals.push({ goal, direction: [...directions][0], amount: intensity.amount });
  }

  const order: EffectIntentGoal[] = ["warmth", "brightness", "space"];
  goals.sort((a, b) => order.indexOf(a.goal) - order.indexOf(b.goal));
  return {
    status: "ready",
    intent: {
      schemaVersion: EFFECT_INTENT_SCHEMA_VERSION,
      parserVersion: EFFECT_INTENT_PARSER_VERSION,
      sourceText: sourceText.trim(),
      goals,
      preserve: [...preserve].sort(),
    },
  };
}
