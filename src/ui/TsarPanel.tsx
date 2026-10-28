import { useMemo, useRef, useState } from "react";
import { useServices, useTracks, useAutomation } from "./context";
import { Slider } from "./controls";
import { tsarParams } from "../tsar/params";
import {
  applyInstrumentPatch,
  applyInstrumentPreset,
  setInstrumentParam,
  applyForgeCandidateCommand,
} from "../commands/commands";
import {
  applyOrbitPreset,
  clearOrbitRecording,
  recordOrbitPath,
  restoreDefaultOrbitMapping,
  setOrbitMapping,
  setOrbitPosition,
  type OrbitSample,
} from "../commands/tsarOrbit";
import {
  ORBIT_PRESETS,
  ORBIT_TARGETS,
  ORBIT_TARGET_BY_ID,
  defaultOrbitMapping,
  isOrbitAxisLive,
  normalizeOrbitMapping,
  orbitAxisPosition,
  orbitAxesCollide,
} from "../tsar/orbit";
import { TsarOrbit } from "./TsarOrbit";
import { forgeCandidates as forgeCandidateSet, candidateSummary, type ForgeCandidate } from "../tsar/forge-candidates";
import {
  buildSourceRecord,
  describeSourcePitch,
  describeSourceState,
  markSourceMissing,
  sourceContentHash,
  type SourceRecord,
} from "../sample-library/source-record";
import {
  mutateTsarPatch,
  mutationReveal,
  MUTATION_GROUPS,
  MUTATION_RANGES,
  describeMutationRun,
  type MutationGroup,
  type TsarMutation,
} from "../tsar/mutations";
import { TSAR_FACTORY_PRESETS } from "../presets/tsar-factory";
import { importAudioFile } from "./sample-import";
import type { InstrumentPreset } from "../presets/types";
import type { InstrumentTrack } from "../project-model/types";

/**
 * TSAR PANEL (docs/TSAR-ROADMAP.md T4) — the flagship engine editor.
 *
 * The panel is a RENDERER of intent (AGENTS #1/#2): every control commits a
 * command through `services.store.execute`, nothing writes params directly.
 * Three surfaces:
 *   - SOURCES: per-slot engine/root/envelope/filter, morph + sub/noise.
 *   - MOD + LFO: the four matrix slots with a source/destination picker.
 *   - FORGE + PRESETS: drop a sample to forge a patch, browse the factory bank.
 *
 * Forge runs on the selected track's chosen slot; the plan and the drop are
 * refused honestly (no silent patch) when the source is empty.
 */

const SOURCE_A = tsarParams.filter((param) => param.id.startsWith("srcA"));
const SOURCE_B = tsarParams.filter((param) => param.id.startsWith("srcB"));
const SHARED = tsarParams.filter(
  (param) => param.id === "morph" || param.id.startsWith("sub") || param.id.startsWith("noise"),
);
const VOICE = tsarParams.filter((param) => ["glide", "velocity", "drift"].includes(param.id));
const LFO = tsarParams.filter((param) => param.id.startsWith("lfo"));
const ARP = tsarParams.filter((param) => param.id.startsWith("arp"));
const TONE = tsarParams.filter((param) => ["tone", "drive", "width", "level"].includes(param.id));

const MOD_SOURCES = ["OFF", "ENV", "LFO", "VEL", "PRESS"] as const;
const MOD_DESTS = ["OFF", "A MORPH", "A CUTOFF", "B MORPH", "B CUTOFF", "MORPH", "AMP", "PAN"] as const;

function ParamRow({
  id,
  track,
  onParam,
}: {
  id: string;
  track: InstrumentTrack;
  onParam: (paramId: string, value: number) => void;
}) {
  const def = tsarParams.find((param) => param.id === id)!;
  const discreteOptions =
    def.kind === "discrete" && def.step && !def.options
      ? Array.from({ length: Math.floor((def.max - def.min) / def.step) + 1 }, (_, index) => {
          const value = def.min + index * def.step!;
          return { value, label: def.format ? def.format(value) : `${value}` };
        })
      : undefined;
  const options = def.options ?? discreteOptions;
  const currentValue = track.params[id] ?? def.default;

  if (options && options.length > 0) {
    const selectedValue = options.some((option) => option.value === currentValue) ? currentValue : options[0]!.value;
    return (
      <label className="tsar-param-select">
        <span className="slider-label">{def.label}</span>
        <select
          aria-label={def.label}
          value={selectedValue}
          onChange={(event) => onParam(id, Number(event.target.value))}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (def.kind === "toggle") {
    const enabled = currentValue >= 0.5;
    return (
      <div className="tsar-param-toggle">
        <span className="slider-label">{def.label}</span>
        <button
          type="button"
          role="switch"
          aria-label={def.label}
          aria-checked={enabled}
          className={`tsar-toggle-button${enabled ? " active" : ""}`}
          onClick={() => onParam(id, enabled ? 0 : 1)}
        >
          {enabled ? "ON" : "OFF"}
        </button>
      </div>
    );
  }

  const lfoRateLocked = id === "lfoRate" && Math.round(track.params.lfoSync ?? 0) > 0;
  return (
    <Slider
      compact
      label={lfoRateLocked ? "LFO FREE RATE" : def.label}
      hint={
        lfoRateLocked
          ? "Used while LFO SYNC is OFF"
          : `${def.label} - ${def.min}…${def.max}${def.unit ? ` ${def.unit}` : ""}`
      }
      value={currentValue}
      min={def.min}
      max={def.max}
      defaultValue={def.default}
      format={def.format}
      taper={def.taper}
      disabled={lfoRateLocked}
      onCommit={(value) => onParam(id, value)}
    />
  );
}

export function TsarPanel() {
  const services = useServices();
  const tracks = useTracks();
  const tsarTracks = useMemo(
    () => tracks.filter((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "tsar"),
    [tracks],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const track = tsarTracks.find((candidate) => candidate.id === selectedId) ?? tsarTracks[0];

  const [forgeSlot, setForgeSlot] = useState<0 | 1>(0);
  const [forgeStatus, setForgeStatus] = useState<string | null>(null);
  const [presetFilter, setPresetFilter] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Patch Mutations ladder (Session Theatre for sound design): blind A/B
  // picks over deterministic param-space variants; nothing touches the
  // project until KEEP WINNER dispatches one undoable command.
  const [mutLadder, setMutLadder] = useState<{
    pool: TsarMutation[];
    champion: TsarMutation;
    round: number;
    total: number;
  } | null>(null);
  const [mutSeed, setMutSeed] = useState(() => 1_234_567);
  /**
   * WAVE 4 — controlled mutations.
   *
   * `mutRange` is how far a variant may move (1 = the pre-wave-4 reach).
   * `mutLocks` freezes whole parameter groups: a locked group's parameters
   * stay bit-identical in every variant.
   * `mutRuns` keeps this session's runs so a producer can re-invoke the exact
   * same variations later, even after the patch has moved on.
   */
  const [mutRange, setMutRange] = useState(1);
  const [mutLocks, setMutLocks] = useState<MutationGroup[]>([]);
  const [mutSeedText, setMutSeedText] = useState("");
  const [mutRuns, setMutRuns] = useState<{ key: string; seed: number; variants: TsarMutation[] }[]>([]);
  const [mutNote, setMutNote] = useState<string | null>(null);

  // ── ORBIT — the 2-D performance surface (ADR 0074) ─────────────────────
  /**
   * The MAPPING lives in the project (the track's patch); the POSITION lives
   * in the two parameters' values. The panel derives what it draws and
   * dispatches what the producer did — it never holds the truth (R6: the UI
   * is not the source of truth for the audio callback).
   */
  const [orbitRecording, setOrbitRecording] = useState(false);
  const [orbitNote, setOrbitNote] = useState<string | null>(null);
  /** The samples of the gesture in progress (one per tick). */
  const orbitSamplesRef = useRef<OrbitSample[]>([]);
  const automationLanes = useAutomation();

  const orbitMapping = useMemo(() => normalizeOrbitMapping(track?.orbit), [track?.orbit]);
  const orbitPosition = useMemo(() => {
    const params = track?.params ?? {};
    const valueOf = (paramId: string): number => {
      const raw = params[paramId];
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      return ORBIT_TARGET_BY_ID[paramId]?.default ?? 0;
    };
    return {
      x: orbitAxisPosition(orbitMapping.x, valueOf(orbitMapping.x.paramId)),
      y: orbitAxisPosition(orbitMapping.y, valueOf(orbitMapping.y.paramId)),
    };
  }, [orbitMapping, track?.params]);
  const orbitSilent = useMemo(() => {
    const params = track?.params ?? {};
    const reason = (paramId: string): string | null =>
      isOrbitAxisLive(paramId, params)
        ? null
        : (ORBIT_TARGET_BY_ID[paramId]?.silentBecause ?? "not audible with this patch");
    return { x: reason(orbitMapping.x.paramId), y: reason(orbitMapping.y.paramId) };
  }, [orbitMapping, track?.params]);
  const orbitActivePresetId = useMemo(() => {
    const found = ORBIT_PRESETS.find(
      (preset) =>
        preset.x.paramId === orbitMapping.x.paramId &&
        preset.y.paramId === orbitMapping.y.paramId &&
        preset.x.min === orbitMapping.x.min &&
        preset.x.max === orbitMapping.x.max &&
        preset.y.min === orbitMapping.y.min &&
        preset.y.max === orbitMapping.y.max,
    );
    return found?.id ?? null;
  }, [orbitMapping]);
  const orbitCanRestore = useMemo(() => {
    const fallback = defaultOrbitMapping();
    return (
      orbitMapping.x.paramId !== fallback.x.paramId ||
      orbitMapping.y.paramId !== fallback.y.paramId ||
      orbitMapping.x.min !== fallback.x.min ||
      orbitMapping.x.max !== fallback.x.max ||
      orbitMapping.y.min !== fallback.y.min ||
      orbitMapping.y.max !== fallback.y.max
    );
  }, [orbitMapping]);
  /**
   * Was the STORED mapping repaired on the way in? The project model checks
   * the mapping's shape; whether a parameter may be assigned to an axis is
   * the ORBIT catalogue's business, so a mapping that names a target the
   * catalogue no longer offers falls back to the default axis. The producer
   * is told, because a silent fallback would look like the surface ignoring
   * them.
   */
  const orbitRepaired = useMemo(() => {
    const stored = track?.orbit;
    if (!stored) return false;
    return (
      stored.x?.paramId !== orbitMapping.x.paramId ||
      stored.y?.paramId !== orbitMapping.y.paramId ||
      stored.x?.min !== orbitMapping.x.min ||
      stored.x?.max !== orbitMapping.x.max ||
      stored.y?.min !== orbitMapping.y.min ||
      stored.y?.max !== orbitMapping.y.max
    );
  }, [track?.orbit, orbitMapping]);
  const orbitHasRecording = useMemo(() => {
    const trackId = track?.id;
    if (!trackId) return false;
    const owned = new Set([orbitMapping.x.paramId, orbitMapping.y.paramId]);
    return automationLanes.some(
      (lane) =>
        lane.target.kind === "instParam" &&
        lane.target.trackId === trackId &&
        !lane.target.fxId &&
        Boolean(lane.target.paramId) &&
        owned.has(lane.target.paramId!) &&
        lane.points.length > 0,
    );
  }, [automationLanes, orbitMapping, track?.id]);

  if (!track) {
    return (
      <div className="tsar-panel" role="region" aria-label="TSAR engine">
        <div className="fx-empty">
          No TSAR track in this project — add an instrument track and pick TSAR to open the engine.
        </div>
      </div>
    );
  }

  const onParam = (paramId: string, value: number) => {
    services.store.execute(setInstrumentParam(services.store.doc, track.id, paramId, value));
  };

  // ── ORBIT handlers ─────────────────────────────────────────────────────
  /** The surface moved: write the two parameters, and sample it if recording. */
  const orbitMove = (x: number, y: number) => {
    if (!track) return;
    services.store.execute(setOrbitPosition(services.store.doc, track.id, x, y));
    if (!orbitRecording) return;
    const tick = Math.max(0, Math.round(services.transport.position));
    const samples = orbitSamplesRef.current;
    const last = samples[samples.length - 1];
    // One sample per tick: the surface moves faster than the transport, and
    // the curve wants the value the producer LEFT at that tick.
    if (last && last.tick === tick) {
      last.x = x;
      last.y = y;
    } else {
      samples.push({ tick, x, y });
    }
  };
  /** The gesture began: open the undo frame, so a whole drag is ONE entry. */
  const orbitGestureStart = () => {
    services.store.beginUndoFrame("ORBIT move");
    orbitSamplesRef.current = [];
  };
  /**
   * The gesture ended: flush the recording INSIDE the frame, so one Ctrl+Z
   * takes back the movement AND the curve it produced.
   */
  const orbitGestureEnd = () => {
    const samples = orbitSamplesRef.current;
    orbitSamplesRef.current = [];
    if (orbitRecording && track && samples.length > 0) {
      if (!services.transport.playing) {
        setOrbitNote("The transport must be running to record a performance.");
      } else {
        services.store.execute(recordOrbitPath(services.store.doc, track.id, samples));
        setOrbitNote(`Recorded ${samples.length} point${samples.length === 1 ? "" : "s"} into the project automation.`);
      }
    }
    services.store.endUndoFrame();
  };
  const orbitChangeTarget = (axis: "x" | "y", paramId: string) => {
    if (!track) return;
    const target = ORBIT_TARGET_BY_ID[paramId];
    if (!target) return;
    const next = {
      x: axis === "x" ? { paramId, min: target.min, max: target.max } : { ...orbitMapping.x },
      y: axis === "y" ? { paramId, min: target.min, max: target.max } : { ...orbitMapping.y },
    };
    if (orbitAxesCollide(next)) {
      setOrbitNote("Both axes drive the same parameter — the surface would have nothing to say.");
      return;
    }
    setOrbitNote(null);
    services.store.execute(setOrbitMapping(services.store.doc, track.id, next));
  };
  const orbitApplyPreset = (presetId: string) => {
    if (!track) return;
    setOrbitNote(null);
    services.store.execute(applyOrbitPreset(services.store.doc, track.id, presetId));
  };
  const orbitRestore = () => {
    if (!track) return;
    services.store.execute(restoreDefaultOrbitMapping(services.store.doc, track.id));
    setOrbitNote("The original mapping is back.");
  };
  const orbitToggleRecord = () => {
    setOrbitNote(null);
    setOrbitRecording((value) => !value);
  };
  const orbitClearRecording = () => {
    if (!track) return;
    services.store.execute(clearOrbitRecording(services.store.doc, track.id));
    setOrbitNote("The recorded curve is gone.");
  };

  const presets = TSAR_FACTORY_PRESETS.filter((preset) => {
    if (presetFilter.trim() === "") return true;
    const needle = presetFilter.trim().toLowerCase();
    return (
      preset.name.toLowerCase().includes(needle) ||
      preset.tags.some((tag) => tag.includes(needle)) ||
      (preset.genre ?? "").includes(needle)
    );
  });

  const applyPreset = (preset: InstrumentPreset) => {
    services.store.execute(applyInstrumentPreset(services.store.doc, track.id, preset));
  };

  // ── Patch Mutations (blind A/B tournament over param-space variants) ──
  const pseudoPreset = (id: string, name: string, params: Record<string, number>): InstrumentPreset => ({
    id,
    name,
    instrument: "tsar",
    genre: null,
    mood: [],
    tags: [],
    params,
  });
  const previewMutation = (mutation: TsarMutation) => {
    services.engine.previewInstrumentPreset(
      track.id,
      pseudoPreset(`tsar-mutation-${mutation.id}`, mutation.label, mutation.params),
    );
  };
  const previewOriginal = () => {
    services.engine.previewInstrumentPreset(track.id, pseudoPreset("tsar-original", "ORIGINAL", {}));
  };
  const startMutations = () => {
    const options = { range: mutRange, locks: mutLocks };
    const variants = mutateTsarPatch(track.params, mutSeed, 6, options);
    if (variants.length < 2) {
      // Say WHY, instead of a button that silently does nothing.
      setMutNote(
        mutLocks.length
          ? "Nothing to vary — every live group is locked."
          : "Nothing to vary — this patch has no audible axis left to move.",
      );
      return;
    }
    setMutNote(null);
    setMutLadder({ pool: variants.slice(1), champion: variants[0]!, round: 0, total: variants.length - 1 });
    // Keep the run so the same variations can be invoked again later.
    const key = describeMutationRun(mutSeed, options);
    setMutRuns((runs) => [{ key, seed: mutSeed, variants }, ...runs.filter((run) => run.key !== key)].slice(0, 6));
  };
  /** Put a previous run's variations back on the table, unchanged. */
  const replayRun = (run: { key: string; variants: TsarMutation[] }) => {
    setMutLadder({ pool: run.variants.slice(1), champion: run.variants[0]!, round: 0, total: run.variants.length - 1 });
    setMutNote(null);
  };
  /** Type a seed back in to invoke the same variations again. */
  const applySeedText = () => {
    const parsed = Number.parseInt(mutSeedText.trim(), 10);
    if (!Number.isFinite(parsed)) {
      setMutNote("That seed is not a number.");
      return;
    }
    setMutSeed(parsed >>> 0);
    setMutSeedText("");
    setMutNote(null);
  };
  const toggleLock = (group: MutationGroup) => {
    setMutLocks((locks) => (locks.includes(group) ? locks.filter((entry) => entry !== group) : [...locks, group]));
  };
  const pickMutation = (challengerWon: boolean) => {
    setMutLadder((ladder) => {
      if (!ladder || ladder.pool.length === 0) return ladder;
      const challenger = ladder.pool[0]!;
      return {
        pool: ladder.pool.slice(1),
        champion: challengerWon ? challenger : ladder.champion,
        round: ladder.round + 1,
        total: ladder.total,
      };
    });
  };
  const keepMutationWinner = () => {
    if (!mutLadder) return;
    services.store.execute(
      applyInstrumentPatch(
        services.store.doc,
        track.id,
        mutLadder.champion.params,
        `mutation winner · ${describeMutationRun(mutSeed, { range: mutRange, locks: mutLocks })}`,
      ),
    );
    setMutLadder(null);
  };

  /**
   * FORGE CANDIDATES (roadmap wave 3).
   *
   * The flow is import -> candidates -> hear -> apply, and NOTHING before
   * the apply touches the project. That order is the point: a producer picks
   * a reading by ear, and a candidate that could only be judged after it
   * was applied would be a candidate judged on a sound the producer did not
   * choose yet.
   *
   * The audition uses the candidate's OWN source (`previewInstrumentWithSources`),
   * so a Source B candidate is heard with the sound it will be applied with.
   */
  const [forgeCandidates, setForgeCandidates] = useState<ForgeCandidate[]>([]);
  const [forgeSampleId, setForgeSampleId] = useState<string | null>(null);
  const [forgeSelected, setForgeSelected] = useState<string | null>(null);
  /**
   * The record of the SOURCE the readings came from (roadmap R2).
   *
   * The source lives BESIDE the patch: the patch keeps only an id, and this
   * record says what that id MEANS — its name, its measured root, its
   * content hash, and whether its bytes are actually here. It is built from
   * the import, so it describes the sound rather than the patch.
   */
  const [forgeSource, setForgeSource] = useState<SourceRecord | null>(null);

  /**
   * The record of the source the PATCH points at, in the targeted slot.
   *
   * This is where the dangling id shows up: a project can reference a sample
   * the library no longer holds, and the producer must be able to SEE that
   * (and act on it) instead of hearing silence with no explanation.
   */
  const patchSource = ((): SourceRecord | null => {
    const id = forgeSlot === 0 ? track.sampleId : (track.sampleIdB ?? null);
    if (!id) return null;
    const buffer = services.bank.get(id);
    const record = buildSourceRecord({
      id,
      contentHash: "",
      name: id,
      fileName: id,
      origin: id.startsWith("factory.") ? "factory" : "imported",
      durationSec: buffer?.duration ?? 0,
      sampleRate: buffer?.sampleRate ?? 0,
      channels: buffer?.numberOfChannels ?? 0,
    });
    return buffer ? record : markSourceMissing(record, "the audio is not in your library");
  })();

  const forgeFromFile = async (file: File) => {
    setForgeStatus(`Reading ${file.name}…`);
    setForgeCandidates([]);
    setForgeSelected(null);
    setForgeSampleId(null);
    setForgeSource(null);
    try {
      const asset = await importAudioFile(services, file);
      const buffer = services.bank.get(asset.id);
      if (!buffer) {
        setForgeStatus("Import failed — the sample could not be decoded");
        return;
      }
      const set = forgeCandidateSet(buffer.getChannelData(0), buffer.sampleRate, { slot: forgeSlot });
      if (set.candidates.length === 0) {
        setForgeStatus(`Nothing to forge: ${set.warnings.join("; ")}`);
        return;
      }
      // The candidates are READY, not applied. The producer hears them first.
      setForgeCandidates(set.candidates);
      setForgeSampleId(asset.id);
      const first = set.candidates[0]!;
      setForgeSelected(first.id);
      // The source gets a record of its own, so the sound is described
      // independently of the patch that will play it.
      setForgeSource(
        buildSourceRecord(
          {
            id: asset.id,
            contentHash: sourceContentHash(buffer.getChannelData(0), buffer.sampleRate),
            name: asset.name,
            fileName: asset.fileName,
            origin: "imported",
            durationSec: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            ...(asset.bpm !== undefined ? { bpm: asset.bpm } : {}),
          },
          {
            pitch: {
              rootMidi: set.plan.rootMidi,
              rootConfidence: set.plan.rootConfidence,
              rootHz: set.plan.rootHz,
            },
            envelope: { attackSec: set.plan.envelope.attackSec, releaseSec: set.plan.envelope.releaseSec },
          },
        ),
      );
      setForgeStatus(
        `${set.candidates.length} candidate${set.candidates.length === 1 ? "" : "s"} from ${file.name} — hear them, then apply.`,
      );
    } catch (error) {
      setForgeStatus(error instanceof Error ? `Forge failed: ${error.message}` : "Forge failed");
    }
  };

  /** Audition a candidate WITHOUT touching the project. */
  const previewCandidate = (candidate: ForgeCandidate) => {
    if (!forgeSampleId) return;
    // A Source B candidate is auditioned with the NEW B source and the
    // track's own A source — that is the patch the candidate would land in.
    const sources = candidate.slot === 0 ? { sampleId: forgeSampleId } : { sampleIdB: forgeSampleId };
    services.engine.previewInstrumentWithSources(track.id, 60, candidate.params, sources);
  };

  /** Apply the chosen candidate: ONE undoable command. */
  const applyCandidate = (candidate: ForgeCandidate) => {
    if (!forgeSampleId) return;
    services.store.execute(applyForgeCandidateCommand(services.store.doc, track.id, forgeSampleId, candidate));
    setForgeStatus(
      `Applied ${candidate.label} to source ${candidate.slot === 0 ? "A" : "B"}.${candidate.warnings.length > 0 ? ` — ${candidate.warnings.join("; ")}` : ""}`,
    );
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void forgeFromFile(file);
  };

  return (
    <div className="tsar-panel" role="region" aria-label="TSAR engine">
      <div className="tsar-header">
        <strong className="tsar-title">TSAR</strong>
        {tsarTracks.length > 1 && (
          <select
            className="tsar-track-select"
            aria-label="TSAR track"
            value={track.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {tsarTracks.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <span className="tsar-header-hint">Hybrid engine — two sources · morph · mod matrix · Sample Forge</span>
      </div>

      <div className="tsar-columns">
        <section className="tsar-section" aria-label="Source A">
          <h3 className="tsar-section-title">SOURCE A</h3>
          <div className="tsar-params">
            {SOURCE_A.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Source B">
          <h3 className="tsar-section-title">SOURCE B</h3>
          <div className="tsar-params">
            {SOURCE_B.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Shared">
          <h3 className="tsar-section-title">MORPH · SUB · NOISE</h3>
          <div className="tsar-params">
            {SHARED.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">VOICE</h3>
          <div className="tsar-params">
            {VOICE.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>

        <section className="tsar-section" aria-label="Modulation">
          <h3 className="tsar-section-title">LFO</h3>
          <div className="tsar-params">
            {LFO.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">MOD MATRIX</h3>
          <div className="tsar-mod-grid">
            {[1, 2, 3, 4].map((slot) => {
              const srcValue = Math.round(track.params[`mod${slot}Src`] ?? -1) + 1;
              const dstValue = Math.round(track.params[`mod${slot}Dst`] ?? -1) + 1;
              return (
                <div className="tsar-mod-row" key={slot} role="group" aria-label={`Mod slot ${slot}`}>
                  <span className="tsar-mod-index">#{slot}</span>
                  <select
                    className="tsar-mod-select"
                    aria-label={`Mod ${slot} source`}
                    value={srcValue}
                    onChange={(event) => onParam(`mod${slot}Src`, Number(event.target.value) - 1)}
                  >
                    {MOD_SOURCES.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="tsar-mod-select"
                    aria-label={`Mod ${slot} destination`}
                    value={dstValue}
                    onChange={(event) => onParam(`mod${slot}Dst`, Number(event.target.value) - 1)}
                  >
                    {MOD_DESTS.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Slider
                    compact
                    label="AMT"
                    value={track.params[`mod${slot}Amt`] ?? 0}
                    min={-1}
                    max={1}
                    defaultValue={0}
                    onCommit={(value) => onParam(`mod${slot}Amt`, value)}
                  />
                </div>
              );
            })}
          </div>
          <h3 className="tsar-section-title">TONE</h3>
          <div className="tsar-params">
            {TONE.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
          <h3 className="tsar-section-title">ARPEGGIATOR</h3>
          <div className="tsar-params">
            {ARP.map((param) => (
              <ParamRow key={param.id} id={param.id} track={track} onParam={onParam} />
            ))}
          </div>
        </section>
      </div>

      <section className="tsar-orbit-section" aria-label="ORBIT performance surface">
        <h3 className="tsar-section-title">ORBIT · 2D SURFACE</h3>
        <TsarOrbit
          mapping={orbitMapping}
          position={orbitPosition}
          silent={orbitSilent}
          targets={ORBIT_TARGETS}
          presets={ORBIT_PRESETS}
          activePresetId={orbitActivePresetId}
          recording={orbitRecording}
          hasRecording={orbitHasRecording}
          canRestore={orbitCanRestore}
          onMove={orbitMove}
          onGestureStart={orbitGestureStart}
          onGestureEnd={orbitGestureEnd}
          onTargetChange={orbitChangeTarget}
          onPreset={orbitApplyPreset}
          onRestore={orbitRestore}
          onRecordToggle={orbitToggleRecord}
          onClearRecording={orbitClearRecording}
        />
        {orbitRepaired && (
          <div className="tsar-orbit-status">
            The stored mapping named a target the ORBIT catalogue no longer offers — the axis fell back to the default.
          </div>
        )}
        {orbitNote && <div className="tsar-orbit-status">{orbitNote}</div>}
      </section>

      <div className="tsar-bottom">
        <section
          className="tsar-forge"
          aria-label="Sample Forge"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <h3 className="tsar-section-title">SAMPLE FORGE</h3>
          <div className="tsar-forge-controls">
            <label className="tsar-forge-slot">
              TARGET
              <select
                aria-label="Forge target source"
                value={forgeSlot}
                onChange={(event) => setForgeSlot(Number(event.target.value) === 1 ? 1 : 0)}
              >
                <option value={0}>Source A</option>
                <option value={1}>Source B</option>
              </select>
            </label>
            <button type="button" className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
              FORGE SAMPLE…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void forgeFromFile(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="tsar-forge-hint">
            Drop a WAV here — one import, several honest readings. Hear them, then apply the one you want.
          </div>
          {patchSource && (
            <p className={`tsar-source-line${patchSource.state === "missing" ? " missing" : ""}`}>
              <span className="tsar-source-line-label">PATCH SOURCE</span>
              <span className="tsar-source-line-id">{patchSource.id}</span>
              <span>{describeSourceState(patchSource)}</span>
            </p>
          )}
          {forgeSource && (
            <p className="tsar-source-line">
              <span className="tsar-source-line-label">READING SOURCE</span>
              <span className="tsar-source-line-id">{forgeSource.name}</span>
              <span>{describeSourcePitch(forgeSource.pitch)}</span>
              <span>
                {forgeSource.durationSec.toFixed(2)} s · {(forgeSource.sampleRate / 1000).toFixed(1)} kHz
              </span>
              <span className="tsar-source-line-hash">#{forgeSource.contentHash.slice(0, 8)}</span>
            </p>
          )}
          {forgeCandidates.length > 0 && (
            <ul className="tsar-candidates" aria-label="Forge candidates">
              {forgeCandidates.map((candidate) => {
                const selected = forgeSelected === candidate.id;
                return (
                  <li
                    key={candidate.id}
                    className={`tsar-candidate${selected ? " selected" : ""}`}
                    aria-current={selected ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className="tsar-candidate-title"
                      aria-pressed={selected}
                      onClick={() => setForgeSelected(candidate.id)}
                      title={candidate.reason}
                    >
                      {candidate.label}
                    </button>
                    <span className="tsar-candidate-evidence">{candidateSummary(candidate)}</span>
                    <span className="tsar-candidate-reason">{candidate.reason}</span>
                    {candidate.warnings.length > 0 && (
                      <span className="tsar-candidate-warning">{candidate.warnings.join("; ")}</span>
                    )}
                    <span className="tsar-candidate-actions">
                      <button type="button" className="btn btn-small" onClick={() => previewCandidate(candidate)}>
                        ▶ HEAR
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={!selected}
                        onClick={() => applyCandidate(candidate)}
                      >
                        APPLY → {candidate.slot === 0 ? "A" : "B"}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {forgeStatus && <div className="tsar-forge-status">{forgeStatus}</div>}
        </section>

        <section className="tsar-presets" aria-label="TSAR patch mutations">
          <h3 className="tsar-section-title">PATCH MUTATIONS</h3>
          {!mutLadder ? (
            <div className="tsar-forge-controls">
              <button type="button" className="btn btn-small" onClick={startMutations}>
                MUTATE PATCH
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setMutSeed((seed) => (seed * 1_664_525 + 1_013_904_223) >>> 0);
                  setMutNote(null);
                }}
              >
                RETAKE SEED
              </button>
              <label className="tsar-mut-seed">
                SEED
                <input
                  type="text"
                  inputMode="numeric"
                  className="tsar-mut-seed-input"
                  value={mutSeedText}
                  placeholder={String(mutSeed)}
                  aria-label="Mutation seed"
                  onChange={(event) => setMutSeedText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applySeedText();
                  }}
                />
                <button type="button" className="btn btn-small" onClick={applySeedText}>
                  SET
                </button>
              </label>
              <span className="tsar-forge-hint">seed {mutSeed}</span>
              <div className="tsar-mut-row" role="group" aria-label="Mutation range">
                <span className="tsar-mut-row-label">RANGE</span>
                {MUTATION_RANGES.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    className={`tsar-chip${Math.abs(mutRange - stop.value) < 1e-9 ? " on" : ""}`}
                    aria-pressed={Math.abs(mutRange - stop.value) < 1e-9}
                    onClick={() => setMutRange(stop.value)}
                  >
                    {stop.label}
                  </button>
                ))}
              </div>
              <div className="tsar-mut-row" role="group" aria-label="Locked parameter groups">
                <span className="tsar-mut-row-label">LOCK</span>
                {MUTATION_GROUPS.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={`tsar-chip${mutLocks.includes(group.id) ? " on" : ""}`}
                    aria-pressed={mutLocks.includes(group.id)}
                    onClick={() => toggleLock(group.id)}
                  >
                    {group.label}
                  </button>
                ))}
              </div>
              {mutNote && <span className="tsar-mut-note">{mutNote}</span>}
              <span className="tsar-forge-hint">6 deterministic variants — pick by ear, apply the winner.</span>
            </div>
          ) : mutLadder.pool.length > 0 ? (
            <div className="tsar-forge-controls">
              <span className="tsar-forge-hint">
                BLIND A/B — round {mutLadder.round + 1}/{mutLadder.total} ·{" "}
                {describeMutationRun(mutSeed, { range: mutRange, locks: mutLocks })}
              </span>
              <button type="button" className="btn btn-small" onClick={previewOriginal}>
                ▶ ORIGINAL
              </button>
              <button type="button" className="btn btn-small" onClick={() => previewMutation(mutLadder.champion)}>
                ▶ A
              </button>
              <button type="button" className="btn btn-small" onClick={() => previewMutation(mutLadder.pool[0]!)}>
                ▶ B
              </button>
              <button type="button" className="btn btn-small" onClick={() => pickMutation(false)}>
                A WINS
              </button>
              <button type="button" className="btn btn-small" onClick={() => pickMutation(true)}>
                B WINS
              </button>
              <button type="button" className="btn btn-small" onClick={() => setMutLadder(null)}>
                DISCARD
              </button>
            </div>
          ) : (
            <div className="tsar-forge-controls">
              <span className="tsar-forge-hint">
                WINNER: {mutLadder.champion.label || mutLadder.champion.id} —{" "}
                {mutationReveal(track.params, mutLadder.champion).join(" · ")}
              </span>
              <button type="button" className="btn btn-small" onClick={() => previewMutation(mutLadder.champion)}>
                ▶ WINNER
              </button>
              <button type="button" className="btn btn-small" onClick={previewOriginal}>
                ▶ ORIGINAL
              </button>
              <button type="button" className="btn btn-small" onClick={keepMutationWinner}>
                KEEP WINNER
              </button>
              <button type="button" className="btn btn-small" onClick={() => setMutLadder(null)}>
                DISCARD
              </button>
            </div>
          )}
          {mutRuns.length > 0 && (
            <div className="tsar-mut-row" role="group" aria-label="Recent mutation runs">
              <span className="tsar-mut-row-label">RECENT</span>
              {mutRuns.map((run) => (
                <button
                  key={run.key}
                  type="button"
                  className="tsar-chip"
                  onClick={() => replayRun(run)}
                  title={`Re-invoke ${run.key}`}
                >
                  ↻ {run.key}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="tsar-presets" aria-label="TSAR factory presets">
          <h3 className="tsar-section-title">FACTORY PRESETS ({presets.length})</h3>
          <input
            className="tsar-preset-filter"
            type="search"
            placeholder="Filter by name, tag or genre…"
            aria-label="Filter TSAR presets"
            value={presetFilter}
            onChange={(event) => setPresetFilter(event.target.value)}
          />
          <div className="tsar-preset-list">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`tsar-preset${track.presetId === preset.id ? " active" : ""}`}
                title={`${preset.name} — ${preset.tags.join(", ")}`}
                onClick={() => applyPreset(preset)}
              >
                <span className="tsar-preset-name">{preset.name.replace(/^TSAR /, "")}</span>
                <span className="tsar-preset-genre">{preset.genre}</span>
              </button>
            ))}
            {presets.length === 0 && <div className="tsar-preset-empty">No preset matches the filter.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
