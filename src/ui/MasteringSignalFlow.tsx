import { useEffect, useState } from "react";
import { EFFECT_META } from "../effects/definitions";
import { MASTER_SIGNAL_FLOW, type MasterSignalFlowStageId } from "../mastering/signalFlow";
import { MASTER_EFFECT_OWNER_ID, type MasterConfig } from "../project-model/types";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { useServices } from "./context";

type FlowState = "active" | "transparent" | "bypassed" | "degraded" | "empty";
const FLOW_STATE_LABEL: Record<FlowState, string> = {
  active: "Enabled",
  transparent: "Unity / flat",
  bypassed: "Bypassed",
  degraded: "Degraded",
  empty: "Empty",
};

interface FlowStage {
  id: string;
  controlId?: MasterSignalFlowStageId;
  effectId?: string;
  label: string;
  detail: string;
  state: FlowState;
}

function controlSelector(stageId: MasterSignalFlowStageId, master: MasterConfig): string | null {
  const controls = ".mastering-core-controls";
  switch (stageId) {
    case "inputTrim":
      return `${controls} [role="slider"][aria-label="IN"]`;
    case "tape":
      return master.tapeEnabled
        ? `${controls} [role="slider"][aria-label="TAPE DRIVE"]`
        : `${controls} button[aria-label="Master tape"]`;
    case "midSide":
      return master.msEnabled
        ? `${controls} [role="slider"][aria-label="MID"]`
        : `${controls} button[aria-label="Master mid side"]`;
    case "bassMono":
      return master.bassMonoEnabled
        ? `${controls} [role="slider"][aria-label="B-MONO"]`
        : `${controls} button[aria-label="Master bass mono"]`;
    case "tilt":
      return `${controls} [role="slider"][aria-label="TILT"]`;
    case "glue":
      return `${controls} button[aria-label="Master glue"]`;
    case "masterInserts":
      return "#master-insert-controls";
    case "clipper":
      return `${controls} button[aria-label="Master soft clipper"]`;
    case "limiter":
      return `${controls} button[aria-label="Master limiter"]`;
    default:
      return null;
  }
}

function focusMasterControl(selector: string, showAdvanced: () => void): void {
  const focus = () => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  };
  if (!document.querySelector(selector)) {
    showAdvanced();
    requestAnimationFrame(focus);
    return;
  }
  focus();
}

function focusMasterInsert(effectId: string, showAdvanced: () => void): void {
  const focus = () => {
    const target = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".mastering-insert-controls [data-effect-id]"),
    ).find((button) => button.dataset.effectId === effectId);
    if (!target) {
      focusMasterControl("#master-insert-controls", () => {});
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    target.click();
  };
  if (!document.getElementById("master-insert-controls")) {
    showAdvanced();
    requestAnimationFrame(focus);
    return;
  }
  focus();
}

function dbLabel(value: number): string {
  if (value <= 0.000001) return "−∞ dB";
  const db = 20 * Math.log10(value);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

function gainDb(value: number | undefined): string {
  return `${value === undefined ? "0.0" : value > 0 ? "+" : ""}${(value ?? 0).toFixed(1)} dB`;
}

function stageDetails(
  master: MasterConfig,
  inserts: FlowStage[],
  degradedStages: Record<string, string>,
): Record<MasterSignalFlowStageId, { detail: string; state: FlowState }> {
  const effectiveTrim = Math.max(0, master.masterGain) * Math.pow(10, (master.loudnessTrimDb ?? 0) / 20);
  const msActive = Boolean(master.msEnabled);
  const bassMonoActive = Boolean(master.bassMonoEnabled);
  const matchValues = Object.values(master.matchEq ?? {});
  const matchActive = matchValues.some((value) => Number.isFinite(value) && Math.abs(value) >= 0.05);
  const tilt = master.tiltDb ?? 0;
  const glueEnabled = master.glueEnabled ?? true;
  const activeInsertCount = inserts.filter((stage) => stage.state === "active").length;
  const hasDegradedInserts = inserts.some((stage) => stage.state === "degraded");
  return {
    inputTrim: {
      detail: `${dbLabel(effectiveTrim)} · before tone and dynamics`,
      state: Math.abs(effectiveTrim - 1) < 0.005 ? "transparent" : "active",
    },
    tape: {
      detail: degradedStages.tape
        ? `Fallback: ${degradedStages.tape}`
        : master.tapeEnabled
          ? `On · drive ${((master.tapeDrive ?? 0.35) * 100).toFixed(0)}%`
          : "Off · transparent",
      state: degradedStages.tape ? "degraded" : master.tapeEnabled ? "active" : "bypassed",
    },
    midSide: {
      detail: msActive ? `Mid ${gainDb(master.msMidGain)} · side ${gainDb(master.msSideGain)}` : "Off · unity matrix",
      state: msActive ? "active" : "transparent",
    },
    bassMono: {
      detail: bassMonoActive ? `Below ${Math.round(master.bassMonoFreq ?? 120)} Hz` : "Off · stereo unchanged",
      state: bassMonoActive ? "active" : "transparent",
    },
    dcFilter: { detail: "Always on · 12 Hz", state: "active" },
    matchEq: {
      detail: matchActive ? "Corrective bands active" : "Flat · transparent",
      state: matchActive ? "active" : "transparent",
    },
    tilt: {
      detail: Math.abs(tilt) < 0.05 ? "Flat · transparent" : `${gainDb(tilt)} tilt`,
      state: Math.abs(tilt) < 0.05 ? "transparent" : "active",
    },
    glue: {
      detail: degradedStages.glue
        ? `Fallback: ${degradedStages.glue}`
        : glueEnabled
          ? "On · shared master compressor"
          : "Off",
      state: degradedStages.glue ? "degraded" : glueEnabled ? "active" : "bypassed",
    },
    masterInserts: {
      detail: inserts.length
        ? `${inserts.length} device${inserts.length === 1 ? "" : "s"} · final stereo sum`
        : "No user inserts",
      state: hasDegradedInserts ? "degraded" : activeInsertCount ? "active" : inserts.length ? "bypassed" : "empty",
    },
    clipper: {
      detail: master.clipperEnabled ? `On · ceiling ${master.ceilingDb.toFixed(1)} dBFS` : "Off",
      state: master.clipperEnabled ? "active" : "bypassed",
    },
    monitorBypass: degradedStages.monitorBypass
      ? { detail: `Fallback: ${degradedStages.monitorBypass}`, state: "degraded" }
      : { detail: "Dry audition path latency-aligned; rejoins before safety limiting", state: "transparent" },
    limiter: {
      detail: degradedStages.limiter
        ? `Fallback: ${degradedStages.limiter}`
        : master.limiterEnabled
          ? `On · ceiling ${master.ceilingDb.toFixed(1)} dBFS`
          : "Off",
      state: degradedStages.limiter ? "degraded" : master.limiterEnabled ? "active" : "bypassed",
    },
    outputMeter: { detail: "Reads after the final limiter", state: "active" },
  };
}

export function MasteringSignalFlow({ master, onShowAdvanced }: { master: MasterConfig; onShowAdvanced: () => void }) {
  const services = useServices();
  const [degradedById, setDegradedById] = useState<Record<string, string>>({});
  const [degradedStagesById, setDegradedStagesById] = useState<Record<string, string>>({});
  useEffect(() => {
    let lastPoll = 0;
    let previousSignature = "";
    const rafId = "mastering-signal-flow-status";
    registerRaf(rafId, (time) => {
      if (time - lastPoll < 150) return;
      lastPoll = time;
      const degraded = services.engine
        .getDegradedFx()
        .filter((item) => item.trackId === MASTER_EFFECT_OWNER_ID)
        .map((item) => [item.fxId, item.reason] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      const degradedStages = services.engine
        .getDegradedMasterStages()
        .map((item) => [item.stageId, item.reason] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      const signature = [
        ...degraded.map(([id, reason]) => `fx:${id}:${reason}`),
        ...degradedStages.map(([id, reason]) => `stage:${id}:${reason}`),
      ].join("|");
      if (signature === previousSignature) return;
      previousSignature = signature;
      setDegradedById(Object.fromEntries(degraded));
      setDegradedStagesById(Object.fromEntries(degradedStages));
    });
    return () => unregisterRaf(rafId);
  }, [services.engine]);

  const inserts: FlowStage[] = (master.effects ?? []).map((effect) => ({
    id: effect.id,
    effectId: effect.id,
    label: EFFECT_META[effect.type].name,
    detail: effect.bypassed
      ? "Master insert · bypassed"
      : degradedById[effect.id]
        ? `Fallback: ${degradedById[effect.id]}`
        : "Master insert · enabled",
    state: effect.bypassed ? "bypassed" : degradedById[effect.id] ? "degraded" : "active",
  }));
  const details = stageDetails(master, inserts, degradedStagesById);
  const stages: FlowStage[] = MASTER_SIGNAL_FLOW.flatMap(({ id, label }) => {
    const stage = { id, controlId: id, label, ...details[id] };
    return id === "masterInserts" ? [stage, ...inserts] : [stage];
  });

  return (
    <section className="mastering-flow-card" aria-labelledby="mastering-flow-title">
      <div className="mastering-flow-heading">
        <div>
          <span className="mastering-panel-kicker">REAL MASTER CHAIN</span>
          <h3 id="mastering-flow-title">Signal path</h3>
        </div>
        <button
          type="button"
          className="mastering-flow-jump"
          onClick={() => {
            onShowAdvanced();
            requestAnimationFrame(() => {
              const rack = document.getElementById("master-insert-controls");
              rack?.scrollIntoView({ behavior: "smooth", block: "center" });
              rack?.focus({ preventScroll: true });
            });
          }}
        >
          Go to master inserts
        </button>
      </div>
      <p className="mastering-flow-source">
        <strong>TRACKS + GROUPS + RETURNS</strong>
        <span>Sum to stereo before the global master. Group effects, including ZENIT, process their bus upstream.</span>
      </p>
      <ol className="mastering-flow-stages" aria-label="Master processing stages in signal order">
        {stages.map((stage, index) => (
          <li className="mastering-flow-stage" data-state={stage.state} key={`${stage.id}-${index}`}>
            <span className="mastering-flow-stage-index">{String(index + 1).padStart(2, "0")}</span>
            {stage.effectId || (stage.controlId && controlSelector(stage.controlId, master)) ? (
              <button
                type="button"
                className="mastering-flow-stage-action"
                aria-label={`Focus ${stage.label} controls`}
                onClick={() => {
                  if (stage.effectId) {
                    focusMasterInsert(stage.effectId, onShowAdvanced);
                    return;
                  }
                  const selector = stage.controlId ? controlSelector(stage.controlId, master) : null;
                  if (selector) focusMasterControl(selector, onShowAdvanced);
                }}
              >
                {stage.label}
              </button>
            ) : (
              <strong>{stage.label}</strong>
            )}
            <span className="mastering-flow-state">{FLOW_STATE_LABEL[stage.state]}</span>
            <small>{stage.detail}</small>
          </li>
        ))}
      </ol>
      <p className="mastering-flow-note">
        Delivery profile targets check the measured output; they do not change this chain. The meter reads after the
        limiter, while encoded-file checks run after export. Enabled/flat/bypassed labels reflect saved processing
        settings; runtime fallbacks are shown when the engine reports them. Master bypass in A/B is monitor-only and
        rejoins before the shared safety limiter.
      </p>
    </section>
  );
}
