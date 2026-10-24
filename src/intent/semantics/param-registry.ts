/**
 * PARAM REGISTRY — the ONE source of what a spoken parameter role means.
 *
 * Before this module the same knowledge lived in four places: the role words
 * and per-effect knob map in `param-intent.ts`, the primary-knob map in
 * `mix.ts`, the ParamDef bounds/taper in `effects/definitions.ts`, and the
 * measurement choice in `param-readback.ts`. Adding a family meant editing
 * several tables and hoping they agreed.
 *
 * The registry is deliberately small and declarative:
 *
 *   role words ─┐
 *               ├─ capability: effect × knob × domain × evidence × examples
 *   implied ────┘
 *
 * `PARAM_ROLES` (the parser's view) and `buildCapabilityMatrix()` (the
 * inspectable surface for tests/docs) are DERIVED from `PARAM_ROLE_SPECS`.
 * The ParamDef itself remains the owner of min/max/default/taper/unit — the
 * matrix reads it, it does not duplicate it.
 *
 * `primary` marks the knob the effect layer already addresses ("more reverb"
 * = reverb.mix). Those capabilities are listed for completeness and marked
 * `exposedBy: "effect"`; the param parser deliberately skips them, so the
 * matrix is an honest inventory rather than a promise that every row is a
 * named-knob ask.
 */
import type { EffectType } from "../../project-model/types";
import { EFFECT_META, EFFECT_PRIMARY_KNOB } from "../../effects/definitions";
import type { ParamDef } from "../../effects/types";

export type ParamRole =
  "mix" | "time" | "tone" | "drive" | "width" | "threshold" | "attack" | "release" | "cutoff" | "q";

export type MetricId = "rms" | "centroid" | "crest" | "width" | null;
export type ListeningStatus = "pending" | "done" | "not-applicable";

export interface ParamCapabilitySpec {
  effectType: EffectType;
  paramId: string;
  /** The audibility proxy the readback uses; null = honestly unmeasured. */
  metric: MetricId;
  /** Human-ear evidence status. `pending` is a first-class state, not a pass. */
  listening: ListeningStatus;
  /** `${degree}` is substituted with a spoken modifier by the corpus. */
  examples: { more: string; less: string };
}

export interface ParamRoleDef {
  /** SK+EN stems (deaccented, prefix matches like every other table). */
  words: RegExp;
  /** role → paramId per effect type. Derived from the capabilities. */
  params: Partial<Record<EffectType, string>>;
  /** When the role word itself IS the effect ask ("wider stereo" names no
   * effect noun), this effect is implied. */
  impliedEffect?: EffectType;
}

interface ParamRoleSpec {
  role: ParamRole;
  words: RegExp;
  impliedEffect?: EffectType;
  capabilities: readonly ParamCapabilitySpec[];
}

/**
 * The declarative source. Add a family by adding ONE capability here; the
 * parser's role table, the capability matrix, the corpus and the readback
 * metric all follow.
 */
const PARAM_ROLE_SPECS: readonly ParamRoleSpec[] = [
  {
    role: "mix",
    words: /\bmix\b|\bwet\b|\bdry\b|\bsuch|\bmokr|\bpercent(?:a|u|e)? dozvuk|\bpodiel/,
    capabilities: [
      {
        effectType: "reverb",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: { more: "${degree} more reverb on the 808", less: "${degree} less reverb on the 808" },
      },
      {
        effectType: "delay",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: { more: "${degree} more delay on the 808", less: "${degree} less delay on the 808" },
      },
      {
        effectType: "chorus",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: { more: "${degree} more chorus on the 808", less: "${degree} less chorus on the 808" },
      },
      {
        effectType: "flanger",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: { more: "${degree} more flanger on the 808", less: "${degree} less flanger on the 808" },
      },
      {
        effectType: "phaser",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: { more: "${degree} more phaser on the 808", less: "${degree} less phaser on the 808" },
      },
      {
        effectType: "tremolo",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: { more: "${degree} more tremolo on the 808", less: "${degree} less tremolo on the 808" },
      },
      {
        effectType: "saturation",
        paramId: "mix",
        metric: "rms",
        listening: "pending",
        examples: {
          more: "${degree} more saturation mix on the 808",
          less: "${degree} less saturation mix on the 808",
        },
      },
    ],
  },
  {
    role: "time",
    words: /\btime\b|\bcas|\bdecay\b|\bchvost|\btail\b|\bdlh|\bkratk|\blong(?:er)?\b|\bshort(?:er)?\b/,
    capabilities: [
      {
        effectType: "reverb",
        paramId: "decay",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} longer reverb decay on the 808",
          less: "${degree} shorter reverb decay on the 808",
        },
      },
      {
        effectType: "delay",
        paramId: "time",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} longer delay time on the 808",
          less: "${degree} shorter delay time on the 808",
        },
      },
    ],
  },
  {
    role: "tone",
    words: /\btone\b|\bton\b|\btmavs|\bjasnejs|\bsvetlejs|\bdarker\b|\bbrighter\b|\bdark\b|\bbright\b/,
    capabilities: [
      {
        effectType: "reverb",
        paramId: "tone",
        metric: null, // wet-path centroid is source-dependent (2026-10-15 verifier)
        listening: "pending",
        examples: {
          more: "${degree} brighter reverb tone on the 808",
          less: "${degree} darker reverb tone on the 808",
        },
      },
      {
        effectType: "delay",
        paramId: "tone",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} brighter delay tone on the 808",
          less: "${degree} darker delay tone on the 808",
        },
      },
      {
        effectType: "saturation",
        paramId: "tone",
        metric: "centroid",
        listening: "pending",
        examples: {
          more: "${degree} brighter saturation tone on the 808",
          less: "${degree} darker saturation tone on the 808",
        },
      },
    ],
  },
  {
    role: "drive",
    words:
      /\bdrive\b|\bdriv\b|\btekut|\bspinav|\bsaturac|\bzahriat|\bgrit\b|\bdirty\b|\bliquid\b|\bwarm(?:er)?\b|\btepl(?:ej|n|s)/,
    capabilities: [
      {
        effectType: "saturation",
        paramId: "drive",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} more saturation drive on the 808",
          less: "${degree} less saturation drive on the 808",
        },
      },
      {
        effectType: "distortion",
        paramId: "drive",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} more distortion drive on the 808",
          less: "${degree} less distortion drive on the 808",
        },
      },
      {
        effectType: "bassHarmonic",
        paramId: "drive",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} more bass harmonic drive on the 808",
          less: "${degree} less bass harmonic drive on the 808",
        },
      },
    ],
  },
  {
    role: "width",
    words: /\bwidth\b|\bsirka|\bsirs|\bsirok|\bmono\b|\bstereo\b|\bwider\b|\buzs/,
    capabilities: [
      {
        effectType: "haasWidener",
        paramId: "width",
        metric: "width",
        listening: "pending",
        examples: {
          more: "${degree} wider widener width on the chords",
          less: "${degree} narrower widener width on the chords",
        },
      },
    ],
  },
  {
    role: "threshold",
    words: /\bthreshold\b|\bthresh\b|\bprah|\bcitliv/,
    capabilities: [
      {
        effectType: "compressor",
        paramId: "threshold",
        metric: "crest",
        listening: "pending",
        examples: {
          more: "${degree} raise the compressor threshold on the drums",
          less: "${degree} lower the compressor threshold on the drums",
        },
      },
      {
        effectType: "limiter",
        paramId: "threshold",
        metric: "crest",
        listening: "pending",
        examples: {
          more: "${degree} raise the limiter threshold on the drums",
          less: "${degree} lower the limiter threshold on the drums",
        },
      },
      {
        effectType: "gate",
        paramId: "threshold",
        metric: "crest",
        listening: "pending",
        examples: {
          more: "${degree} raise the gate threshold on the drums",
          less: "${degree} lower the gate threshold on the drums",
        },
      },
    ],
  },
  {
    role: "attack",
    words: /\battack\b|\bnabeh|\butok\b/,
    capabilities: [
      {
        effectType: "compressor",
        paramId: "attack",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} slower compressor attack on the drums",
          less: "${degree} faster compressor attack on the drums",
        },
      },
      {
        effectType: "gate",
        paramId: "attack",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} slower gate attack on the drums",
          less: "${degree} faster gate attack on the drums",
        },
      },
    ],
  },
  {
    role: "release",
    words: /\brelease\b|\buvolnen|\bdohas/,
    capabilities: [
      {
        effectType: "compressor",
        paramId: "release",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} longer compressor release on the drums",
          less: "${degree} shorter compressor release on the drums",
        },
      },
      {
        effectType: "limiter",
        paramId: "release",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} longer limiter release on the drums",
          less: "${degree} shorter limiter release on the drums",
        },
      },
      {
        effectType: "gate",
        paramId: "release",
        metric: null,
        listening: "pending",
        examples: {
          more: "${degree} longer gate release on the drums",
          less: "${degree} shorter gate release on the drums",
        },
      },
    ],
  },
  {
    role: "cutoff",
    words: /\bcutoff\b|\bcut.?off\b|\b(?:filter|filtr|svf)\s+(?:freq|frekvenc)|\bfrekvenc\w*\s+(?:filter|filtr)/,
    impliedEffect: "svFilter",
    capabilities: [
      {
        effectType: "svFilter",
        paramId: "cutoff",
        metric: "centroid",
        listening: "pending",
        examples: {
          more: "${degree} higher filter cutoff on the 808",
          less: "${degree} lower filter cutoff on the 808",
        },
      },
    ],
  },
  {
    role: "q",
    words: /\bq\b|\bresonance\b|\brezonanc|\bsharpness\b/,
    impliedEffect: "svFilter",
    capabilities: [
      {
        effectType: "svFilter",
        paramId: "resonance",
        metric: null, // a resonant peak needs a sweep fixture; pending an ear
        listening: "pending",
        examples: {
          more: "${degree} higher filter Q on the 808",
          less: "${degree} lower filter Q on the 808",
        },
      },
    ],
  },
];

/** The parser's view, derived from the specs (never hand-maintained). */
export const PARAM_ROLES: Record<ParamRole, ParamRoleDef> = Object.fromEntries(
  PARAM_ROLE_SPECS.map((spec) => [
    spec.role,
    {
      words: spec.words,
      params: Object.fromEntries(spec.capabilities.map((capability) => [capability.effectType, capability.paramId])),
      impliedEffect: spec.impliedEffect,
    },
  ]),
) as Record<ParamRole, ParamRoleDef>;

/**
 * ROLE-ONLY DIRECTION. The capability's effect does not change the meaning of
 * "faster" or "darker"; the role does. Kept here beside the words so a new
 * role cannot be added without deciding how it reads direction.
 */
export function directionForRole(role: ParamRole, lower: string): "more" | "less" {
  const lessWord =
    /\bless\b|\bmenej|\bzniz|\bdown\b|\bdole\b|\bsniz|\blower\b|\breduce\b|\bcut\b|\bclean(?:er)?\b|\bjemne\b|\bas little\b|\bas small as possible\b/.test(
      lower,
    );
  const faster = /\bfaster\b|\bfast\b|\brychlej|\bkrats|\bshorter\b|\bshort\b|\bsnappier\b|\btighter\b/.test(lower);
  const slower = /\bslower\b|\bslow\b|\bpomals|\blonger\b|\blong\b|\bdlh/.test(lower);
  const darker = /\bdarker\b|\bdark\b|\btmav|\blower\b|\bdown\b|\bzniz/.test(lower);
  const brighter = /\bbrighter\b|\bbright\b|\bjasnejs|\bhigher\b|\bup\b|\bzvys/.test(lower);
  const sharper = /\bsharper\b|\bsharp\b|\bhigher\b|\bup\b|\bzvys|\buzs|\bnarrower\b|\btighter\b/.test(lower);
  const broader = /\bwider\b|\bwide\b|\bsirs|\blower\b|\bdown\b|\bzniz|\bsmoother\b|\bmono\b/.test(lower);
  const drier = /\bsuch|\bdrier\b|\bdry\b|\bas dry as (?:possible|you can)\b/.test(lower);
  const wetter = /\bmokr|\bwetter\b|\bas wet as (?:possible|you can)\b/.test(lower);
  switch (role) {
    case "mix":
      return drier && !wetter ? "less" : lessWord ? "less" : "more";
    case "time":
      return /\bkrats|\bshort|shorter\b/.test(lower) ? "less" : "more";
    case "threshold":
      return lessWord ? "less" : "more";
    case "attack":
    case "release":
      return faster && !slower ? "less" : slower ? "more" : lessWord ? "less" : "more";
    case "cutoff":
      return darker && !brighter ? "less" : brighter ? "more" : lessWord ? "less" : "more";
    case "q":
      return sharper && !broader ? "more" : broader ? "less" : lessWord ? "less" : "more";
    case "width":
      return broader && !sharper ? "more" : sharper ? "less" : lessWord ? "less" : "more";
    case "tone":
      return darker && !brighter ? "less" : brighter ? "more" : lessWord ? "less" : "more";
    case "drive":
      return lessWord ? "less" : "more";
  }
}

export interface CapabilityRow {
  role: ParamRole;
  effectType: EffectType;
  paramId: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  default: number;
  domain: "log" | "linear";
  primary: boolean;
  exposedBy: "effect" | "param";
  metric: MetricId;
  listening: ListeningStatus;
  examples: { more: string; less: string };
}

function paramDefOf(effectType: EffectType, paramId: string): ParamDef | null {
  return EFFECT_META[effectType]?.params.find((param) => param.id === paramId) ?? null;
}

/** Problems that would make the registry lie; empty in a healthy tree. */
export function capabilityIssues(): string[] {
  const issues: string[] = [];
  for (const spec of PARAM_ROLE_SPECS) {
    for (const capability of spec.capabilities) {
      const def = paramDefOf(capability.effectType, capability.paramId);
      if (!def) {
        issues.push(`${spec.role}: ${capability.effectType}.${capability.paramId} is not a ParamDef`);
        continue;
      }
      if (capability.metric === "width" && capability.effectType !== "haasWidener") {
        issues.push(`${spec.role}: width metric on ${capability.effectType}`);
      }
      if (!capability.examples.more.includes("${degree}") || !capability.examples.less.includes("${degree}")) {
        issues.push(`${spec.role}: examples must contain \${degree}`);
      }
    }
  }
  return issues;
}

/**
 * The inspectable inventory: one row per role×effect×knob, with the REAL
 * ParamDef bounds/taper, whether the effect layer or the param layer owns it,
 * the audibility metric and the human-listening status.
 *
 * Built once: `capabilityFor` is called on every param readback, and the
 * registry is static data.
 */
let cachedMatrix: CapabilityRow[] | null = null;
let cachedByRoleEffect: Map<string, CapabilityRow> | null = null;

export function buildCapabilityMatrix(): CapabilityRow[] {
  if (cachedMatrix) return cachedMatrix;
  const rows: CapabilityRow[] = [];
  for (const spec of PARAM_ROLE_SPECS) {
    for (const capability of spec.capabilities) {
      const def = paramDefOf(capability.effectType, capability.paramId);
      if (!def) continue;
      const primary = EFFECT_PRIMARY_KNOB[capability.effectType] === capability.paramId;
      rows.push({
        role: spec.role,
        effectType: capability.effectType,
        paramId: capability.paramId,
        label: def.label,
        unit: def.unit,
        min: def.min,
        max: def.max,
        default: def.default,
        domain: def.taper === "log" ? "log" : "linear",
        primary,
        exposedBy: primary ? "effect" : "param",
        metric: capability.metric,
        listening: capability.listening,
        examples: capability.examples,
      });
    }
  }
  cachedMatrix = rows;
  cachedByRoleEffect = new Map(rows.map((row) => [`${row.role}:${row.effectType}`, row]));
  return rows;
}

export function capabilityFor(role: ParamRole, effectType: EffectType): CapabilityRow | null {
  buildCapabilityMatrix();
  return cachedByRoleEffect?.get(`${role}:${effectType}`) ?? null;
}
