import type { VocalProfile } from "./types";

/**
 * PRODUCER NOTES (V3 "Dialóg") — what the engine tells the singer.
 *
 * Deterministic NL templates over MEASURED fields only (SK + EN) — no LLM,
 * no embellishment: every line traces to a number in the profile, and
 * unmeasured fields get an honest "I can't hear it" line instead of a
 * guess. `summarizeVocalProfile` is the shared card vocabulary for any UI
 * surface (V1.4 handoff); `producerNotes` adds the applied-actions echo.
 */

export type NotesLang = "sk" | "en";

function pct(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

/** Compact card lines: key · tempo · energy · phrases · honesty flags. */
export function summarizeVocalProfile(profile: VocalProfile, lang: NotesLang = "sk"): string[] {
  if (!profile.measured) {
    return lang === "sk"
      ? ["🎤 Neslyším spev — tichý alebo príliš krátky take.", "Daj mi dlhšiu, čistejšiu frázu a skús znova."]
      : ["🎤 No singing heard — quiet or too short a take.", "Give me a longer, clearer phrase and try again."];
  }
  const lines: string[] = [];
  if (profile.keyMeasured && profile.key) {
    lines.push(
      lang === "sk"
        ? `🎹 Key ${profile.key} (${pct(profile.keyConfidence)})`
        : `🎹 Key ${profile.key} (${pct(profile.keyConfidence)})`,
    );
  } else {
    lines.push(
      lang === "sk" ? "🎹 Key nepočujem — harmonicky riedky take." : "🎹 Can't hear the key — harmonically thin take.",
    );
  }
  if (profile.tempoMeasured && profile.tempoBpm) {
    lines.push(
      lang === "sk"
        ? `🥁 Flow ${profile.tempoBpm} BPM (${pct(profile.tempoConfidence)})`
        : `🥁 Flow ${profile.tempoBpm} BPM (${pct(profile.tempoConfidence)})`,
    );
  } else {
    lines.push(
      lang === "sk"
        ? "🥁 Tempo nepočujem — spievaj na pevnejší pulz."
        : "🥁 Can't hear the tempo — sing over a steadier pulse.",
    );
  }
  const peaks = profile.phrases
    .map((p) => p.startBar + 1)
    .slice(0, 4)
    .join(", ");
  lines.push(
    lang === "sk"
      ? `⚡ ${profile.phrases.length} ${profile.phrases.length === 1 ? "fráza" : profile.phrases.length < 5 ? "frázy" : "fráz"}${
          peaks ? ` (takt ${peaks})` : ""
        } · ticho ${Math.round(profile.silenceRatio * 100)}%`
      : `⚡ ${profile.phrases.length} phrase${profile.phrases.length === 1 ? "" : "s"}${
          peaks ? ` (bar ${peaks})` : ""
        } · silence ${Math.round(profile.silenceRatio * 100)}%`,
  );
  return lines;
}

/**
 * Full producer readout: card + what was applied + next-step hint.
 * `applied` are human labels of the commands already executed.
 */
export function producerNotes(profile: VocalProfile, applied: readonly string[], lang: NotesLang = "sk"): string[] {
  const lines = summarizeVocalProfile(profile, lang);
  if (!profile.measured) return lines;
  for (const action of applied.slice(0, 4)) lines.push(lang === "sk" ? `✓ ${action}` : `✓ ${action}`);
  const peak = profile.phrases.reduce((best, p) => (p.peakEnergy > best.peakEnergy ? p : best), {
    startBar: 0,
    endBar: 0,
    peakEnergy: -1,
  });
  if (peak.peakEnergy >= 0) {
    lines.push(
      lang === "sk"
        ? `Tlačíš v takte ${peak.startBar + 1}–${peak.endBar + 1} — tam ti postavím refrén.`
        : `You push hardest at bars ${peak.startBar + 1}–${peak.endBar + 1} — that's where your chorus goes.`,
    );
  } else if (profile.phrases.length === 0) {
    lines.push(
      lang === "sk"
        ? "Žiadna súvislá fráza — skús spievať dlhšie úseky bez prestávky."
        : "No sustained phrase — try singing longer unbroken lines.",
    );
  }
  return lines;
}
