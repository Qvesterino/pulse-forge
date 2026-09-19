/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Explanation Localizer (v1)
//
// Maps reason codes to human-readable, localizable explanations.
// ═══════════════════════════════════════════════════════════

import type { ReasonCode } from "./assistant.js";

export const AVAILABLE_LOCALES = ["en", "sk"] as const;
export type ExplanationLocale = (typeof AVAILABLE_LOCALES)[number];

const EXPLANATIONS_EN: Record<ReasonCode, string> = {
  LOW_FREQUENCY_RUMBLE: "Low-frequency energy below the instrument range was detected.",
  SUB_BASS_BUILDUP: "Excessive sub-bass energy may cause mud and headroom issues.",
  EXCESSIVE_DYNAMIC_RANGE: "The signal has a wide dynamic range that may benefit from compression.",
  INSUFFICIENT_LEVEL: "The signal level is low and may benefit from gain.",
  UNEVEN_LEVEL: "The level varies significantly, suggesting inconsistent dynamics.",
  CLIPPING_DETECTED: "Clipping was detected in the input signal.",
  NOISE_FLOOR_DETECTED: "Background noise was detected during silent regions.",
  BREATH_NOISE: "Breath or transient noise was detected between phrases.",
  MUD_FREQUENCY_BUILDUP: "Muddy frequency buildup was detected in the low-mid range.",
  BOXINESS: "Boxy frequency buildup was detected around 300–500 Hz.",
  NASAL_RESONANCE: "Nasal resonance frequencies were detected around 1 kHz.",
  HARSH_FREQUENCY: "Harsh frequency energy was detected in the 3–5 kHz range.",
  HIGH_SIBILANCE: "High sibilance energy was detected.",
  LACK_OF_PRESENCE: "The signal lacks presence in the 2–5 kHz range.",
  LACK_OF_AIR: "The signal lacks air and brightness above 8 kHz.",
  DULL_SPECTRUM: "The spectral balance is dull — high-frequency content is lacking.",
  BRIGHT_SPECTRUM: "The spectral balance is overly bright.",
  NARROW_STEREO: "The stereo image is narrow.",
  WIDE_STEREO_INSTABILITY: "The stereo image is very wide and may be unstable.",
  PHASE_ISSUES: "Potential phase issues were detected.",
  LACK_OF_PUNCH: "The signal lacks transient punch.",
  EXCESSIVE_TRANSIENT: "Transients are too sharp and may benefit from smoothing.",
  NEEDS_WARMTH: "The signal may benefit from harmonic warmth.",
  NEEDS_BRIGHTNESS: "The signal may benefit from high-frequency excitement.",
  NEEDS_DENSITY: "The signal may benefit from density and upward compression.",
  INSTRUMENT_PROFILE_MISMATCH: "The spectral profile does not match the expected instrument.",
  SUGGESTED_STARTING_POINT: "A suggested starting point based on the detected instrument.",
};

const EXPLANATIONS_SK: Record<ReasonCode, string> = {
  LOW_FREQUENCY_RUMBLE: "Bola zistená energia v nízkych frekvenciách pod rozsahom nástroja.",
  SUB_BASS_BUILDUP: "Nadmerná sub-basová energia môže spôsobiť blato a problémy s headroomom.",
  EXCESSIVE_DYNAMIC_RANGE: "Signál má široký dynamický rozsah, ktorý môže profitovať z kompresie.",
  INSUFFICIENT_LEVEL: "Úroveň signálu je nízka a môže profitovať zo zosilnenia.",
  UNEVEN_LEVEL: "Úroveň sa významne mení, čo naznačuje nekonzistentnú dynamiku.",
  CLIPPING_DETECTED: "Vo vstupnom signáli bolo zistené orezanie.",
  NOISE_FLOOR_DETECTED: "Počas tichých častí bol zistený šum pozadia.",
  BREATH_NOISE: "Medzi frázami bol zistený dychový alebo tranzientný šum.",
  MUD_FREQUENCY_BUILDUP: "Bolo zistené kalné budovanie frekvencií v oblasti stredných basov.",
  BOXINESS: "Bolo zistené duté budovanie frekvencií okolo 300–500 Hz.",
  NASAL_RESONANCE: "Boli zistené frekvencie nazálnej rezonancie okolo 1 kHz.",
  HARSH_FREQUENCY: "Bola zistená drsná energia frekvencií v rozsahu 3–5 kHz.",
  HIGH_SIBILANCE: "Bola zistená vysoká energia sykaviek.",
  LACK_OF_PRESENCE: "Signálu chýba prítomnosť v rozsahu 2–5 kHz.",
  LACK_OF_AIR: "Signálu chýba vzdušnosť a jasnosť nad 8 kHz.",
  DULL_SPECTRUM: "Spektrálna vyváženosť je matná — chýba vysokofrekvenčný obsah.",
  BRIGHT_SPECTRUM: "Spektrálna vyváženosť je príliš svetlá.",
  NARROW_STEREO: "Stereo obraz je úzky.",
  WIDE_STEREO_INSTABILITY: "Stereo obraz je veľmi široký a môže byť nestabilný.",
  PHASE_ISSUES: "Boli zistené možné problémy s fázou.",
  LACK_OF_PUNCH: "Signálu chýba tranzientná údernosť.",
  EXCESSIVE_TRANSIENT: "Tranzienty sú príliš ostré a môžu profitovať zo zmernenia.",
  NEEDS_WARMTH: "Signál môže profitovať z harmonickej teploty.",
  NEEDS_BRIGHTNESS: "Signál môže profitovať z vysokofrekvenčného budenia.",
  NEEDS_DENSITY: "Signál môže profitovať z hustoty a vzostupnej kompresie.",
  INSTRUMENT_PROFILE_MISMATCH: "Spektrálny profil nezodpovedá očakávanému nástroju.",
  SUGGESTED_STARTING_POINT: "Navrhovaný štartovací bod na základe detekovaného nástroja.",
};

const LOCALE_MAPS: Record<string, Record<ReasonCode, string>> = {
  en: EXPLANATIONS_EN,
  sk: EXPLANATIONS_SK,
};

export function getExplanation(reasonCode: ReasonCode): string {
  return EXPLANATIONS_EN[reasonCode] ?? `Unknown reason: ${reasonCode}`;
}

export function getExplanationForLocale(reasonCode: ReasonCode, locale: string): string {
  const map = LOCALE_MAPS[locale];
  if (map && map[reasonCode]) {
    return map[reasonCode];
  }
  return EXPLANATIONS_EN[reasonCode] ?? `Unknown reason: ${reasonCode}`;
}

export function getLocaleMap(locale: string): Record<ReasonCode, string> {
  const map = LOCALE_MAPS[locale];
  if (map) return { ...map };
  return { ...EXPLANATIONS_EN };
}
