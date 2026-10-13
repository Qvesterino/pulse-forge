import type { SongSectionMeter } from "./song-audio-review";
import { TARGET_WORDS } from "./mix";

/**
 * COMPLAINTS — the LISTENING LOOP (Phase C, docs/INTENT-MCP-EXPANSION-PLAN.md).
 *
 * The producer says what a section FEELS like — "drop pôsobí prázdno",
 * "the lead is harsh", "no punch" — and the loop answers with a MEASURED
 * diagnosis and an EXECUTABLE bounded proposal (never a silent bake):
 *
 *   empty / thin (section) → section density/energy revision proposal
 *   no punch (drums)       → punchier-drums production proposal
 *   muddy / harsh (mix)    → mix-tilt proposal via the existing mix profile
 *
 * When section meters are supplied (from the song audition buffer via
 * analyzeSongSections), the diagnosis gains EVIDENCE: the section's RMS vs
 * the song median. Without meters the diagnosis is honest "podľa slov" and
 * still proposes the bounded fix — the proposal is always the user's choice.
 */

export type ComplaintKind = "empty" | "thin" | "muddy" | "harsh" | "noPunch";

export interface ComplaintIntent {
  kind: ComplaintKind;
  /** Named section (drop/chorus/…) when the complaint targets one. */
  role: string | null;
  /** Named track family (bass/lead/drums/…) when the complaint targets one. */
  family: string | null;
}

const COMPLAINT_WORDS: ReadonlyArray<readonly [RegExp, ComplaintKind]> = [
  // SK synonym wave (2026-10-12): deaccented stems, each mapping to an
  // EXISTING kind — no new diagnosis plumbing, only more ways to say it.
  [/\b(?:empty|void|prazdn\w*)\b|\bnic\s+sa\s+nedeje/i, "empty"],
  [/\b(?:thin|weak|tenk\w*|chud\w*|slab\w*)\b/i, "thin"],
  [/\bmuddy\b|\bblat[oi]?\b|\bblat[ai]st\w*|\bbahnist\w*|\bkaln\w*|\bzamuten\w*|\bdut\w*|\bhukot/i, "muddy"],
  [/\bharsh\b|\bpiercing\b|\bostr\w*|\bdraz\w*|\bpicha\b|\bkrici\b|\bskrece\b|\bbodav/i, "harsh"],
  [
    /\bno\s+punch\b|\bbez\s+razanc\w*|\bno\s+knock\b|\bmakk\w*\s+drums\b|\bmrtv\w*|\bbez\s+uder\w*|\bchyba\s+uder\w*/i,
    "noPunch",
  ],
];

const ROLE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bintro\b|\buvod/i, "intro"],
  [/\bbuild(?:-?up|up)?\b|\bstavb/i, "build"],
  [/\bchorus\b|\bhook\b|\brefren/i, "chorus"],
  [/\bverse\b|\bzloh/i, "verse"],
  [/\bbridge\b|\bmost/i, "bridge"],
  [/\bdrop\w*/i, "drop"],
  [/\bbreak\b|\bbrejk/i, "break"],
  [/\boutro\b|\bzaver\b|\bkoncovk/i, "outro"],
  [/\bfill\b|\bveto\b/i, "fill"],
];

/** PAD families count as complaint targets — "kick je mŕtvy" points at the
 * drum track more precisely than any TRACK family could. */
const PAD_FAMILY_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bkick\w*|\bkop[aá]k\w*/i, "kick"],
  [/\bsnare\w*|\bvirbl?\w*/i, "snare"],
  [/\bclap\w*|\bplesk\w*/i, "clap"],
  [/\bhat\w*|\bhi.?hat\w*|\b\u010dinel\w*/i, "hats"],
  [/\btom\w*|\btam\w*/i, "tom"],
  [/\bperc\w*|\bperkus\w*/i, "perc"],
];

export function parseComplaintIntent(text: string): ComplaintIntent | null {
  // Deaccented once: keyboards differ ("mŕtvy" vs "mrtvy") and the new stems
  // are ASCII; the legacy [áa]-style alternations keep matching the
  // deaccented input.
  const plain = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  let complaint: ComplaintKind | null = null;
  for (const [re, kind] of COMPLAINT_WORDS) {
    if (re.test(plain)) {
      complaint = kind;
      break;
    }
  }
  if (complaint == null) return null;
  const role = ROLE_WORDS.find(([re]) => re.test(plain))?.[1] ?? null;
  const family =
    TARGET_WORDS.find(([re]) => re.test(plain))?.[1] ?? PAD_FAMILY_WORDS.find(([re]) => re.test(plain))?.[1] ?? null;
  // a complaint must point at SOMETHING — bare "muddy" alone is too vague
  if (role == null && family == null) return null;
  return { kind: complaint, role, family };
}

// ── Diagnosis ───────────────────────────────────────────────────────────────

export interface ComplaintProposal {
  /** What the fix is, in one line. */
  label: string;
  /** An EXECUTABLE instruction the existing routes accept verbatim. */
  instruction: string;
}

export interface ComplaintDiagnosis {
  kind: ComplaintKind;
  role: string | null;
  family: string | null;
  /** Measurement evidence line ("" when no meters were supplied). */
  measurement: string;
  diagnosis: string;
  proposals: ComplaintProposal[];
}

interface SectionEvidence {
  rmsDbfs: number;
  gapToMedian: number;
}

/** RMS of the named role's sections vs the song median (null without meters). */
function roleEvidence(meters: ReadonlyArray<SongSectionMeter>, role: string): SectionEvidence | null {
  const own = meters.filter((meter) => meter.role === role && meter.rmsDbfs > -60);
  if (own.length === 0) return null;
  const rmsValues = meters.filter((meter) => meter.rmsDbfs > -60).map((meter) => meter.rmsDbfs);
  const medianRms = rmsValues.length > 0 ? medianOf(rmsValues) : null;
  const ownRms = medianOf(own.map((meter) => meter.rmsDbfs));
  if (medianRms == null) return { rmsDbfs: ownRms, gapToMedian: 0 };
  return { rmsDbfs: ownRms, gapToMedian: Math.round((ownRms - medianRms) * 10) / 10 };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const QUIET_GAP_DB = 6;

function evidenceLine(kind: ComplaintKind, role: string | null, evidence: SectionEvidence | null): string {
  if (evidence == null) return "";
  const level = `${role ?? "section"} RMS ${evidence.rmsDbfs.toFixed(1)} dBFS`;
  if (kind === "empty" || kind === "thin") {
    const quiet = evidence.gapToMedian <= -QUIET_GAP_DB;
    return `${level}, ${Math.abs(evidence.gapToMedian).toFixed(1)} dB ${quiet ? "pod" : "nad"} mediánom pesničky`;
  }
  return level;
}

/**
 * Complaint → measured diagnosis + bounded executable proposals. The
 * suggestions are plain instructions the existing routes accept verbatim
 * ("more energy in the drop", "punchier drums", "brighter mix") — the panel
 * offers them as chips and nothing executes until the user picks one.
 */
export function diagnoseComplaint(
  intent: ComplaintIntent,
  meters?: ReadonlyArray<SongSectionMeter>,
): ComplaintDiagnosis | null {
  const role = intent.role;
  const family = intent.family;
  const proposals: ComplaintProposal[] = [];

  if ((intent.kind === "empty" || intent.kind === "thin") && role != null) {
    proposals.push(
      { label: `more energy in the ${role}`, instruction: `more energy in the ${role}` },
      { label: `more density in the ${role}`, instruction: `more density in the ${role}` },
    );
  }
  if (intent.kind === "noPunch") {
    proposals.push({ label: "punchier drums", instruction: "make the drums punchier" });
  }
  if (intent.kind === "muddy" && family != null) {
    proposals.push({
      label: `brighter ${family}`,
      instruction: `make the ${family} brighter`,
    });
  }
  if (intent.kind === "harsh" && family != null) {
    proposals.push({ label: `softer ${family}`, instruction: `make the ${family} softer` });
  }

  let measurement = "";
  let diagnosisExtra = "";
  if (role != null && meters != null && meters.length > 0) {
    const evidence = roleEvidence(meters, role);
    measurement = evidenceLine(intent.kind, role, evidence);
    if ((intent.kind === "empty" || intent.kind === "thin") && evidence != null) {
      diagnosisExtra =
        evidence.gapToMedian <= -QUIET_GAP_DB
          ? " — meranie potvrdzuje tichú sekciu"
          : " — meranie neukazuje výraznú odchýlku (návrh zostáva chuťovou voľbou)";
    }
  }

  const diagnosisText =
    intent.kind === "empty" || intent.kind === "thin"
      ? `sekcia znie riedko${diagnosisExtra}`
      : intent.kind === "noPunch"
        ? "bicie chýbajú úder"
        : `${intent.kind} — navrhujem ohraničenú úpravu`;

  return {
    kind: intent.kind,
    role,
    family,
    measurement,
    diagnosis: diagnosisText,
    proposals,
  };
}
