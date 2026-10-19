import { useState } from "react";
import { addEffect, setEffectParam, toggleEffectBypass } from "../commands/commands";
import { MASTER_EFFECT_OWNER_ID } from "../project-model/types";
import type { EffectInstance } from "../project-model/types";
import { EqCurveCanvas } from "./EqCurveCanvas";
import { SpectrumAnalyzer } from "./SpectrumAnalyzer";
import { useMaster, useServices } from "./context";

/** Live master spectrum with an editable curve for the existing master EQ insert. */
export function MasterSpectrumEq({ analyser, id }: { analyser: AnalyserNode | null; id: string }) {
  const services = useServices();
  const master = useMaster();
  const [selectedEqId, setSelectedEqId] = useState<string | null>(null);
  const eqs = (master.effects ?? []).filter((effect) => effect.type === "eq");
  const selectedEq = eqs.find((effect) => effect.id === selectedEqId) ?? eqs[0] ?? null;

  const addMasterEq = () => {
    const command = addEffect(services.store.getDoc(), MASTER_EFFECT_OWNER_ID, "eq", 0);
    services.store.execute(command);
    setSelectedEqId(command.effectId);
  };

  const commitGain = (paramId: string, gainDb: number) => {
    if (!selectedEq) return;
    services.store.execute(
      setEffectParam(services.store.getDoc(), MASTER_EFFECT_OWNER_ID, selectedEq.id, paramId, gainDb),
    );
  };

  const toggleBypass = () => {
    if (!selectedEq) return;
    services.store.execute(toggleEffectBypass(services.store.getDoc(), MASTER_EFFECT_OWNER_ID, selectedEq.id));
  };

  return (
    <div
      className="master-spectrum-eq"
      role="group"
      aria-label="Master spectrum and EQ"
      data-bypassed={selectedEq?.bypassed ?? false}
    >
      <SpectrumAnalyzer analyser={analyser} height={72} accent="#f59e0b" id={id} fillHeight />
      {selectedEq && (
        <EqCurveCanvas
          params={selectedEq.params}
          onCommit={commitGain}
          width={600}
          height={120}
          fillHeight
          className="master-spectrum-eq-curve"
        />
      )}
      <div className="master-spectrum-eq-controls">
        <span className="master-spectrum-eq-label">MASTER EQ</span>
        {eqs.length > 1 && selectedEq && (
          <label className="master-spectrum-eq-select-label">
            <span className="sr-only">Master EQ insert</span>
            <select
              aria-label="Master EQ insert"
              value={selectedEq.id}
              onChange={(event) => setSelectedEqId(event.target.value)}
            >
              {eqs.map((effect: EffectInstance, index) => (
                <option value={effect.id} key={effect.id}>
                  EQ {index + 1}
                </option>
              ))}
            </select>
          </label>
        )}
        {selectedEq ? (
          <button
            type="button"
            className="btn btn-small master-spectrum-eq-toggle"
            aria-label={selectedEq.bypassed ? "Enable master EQ" : "Bypass master EQ"}
            aria-pressed={!selectedEq.bypassed}
            title={selectedEq.bypassed ? "Enable this master EQ insert" : "Bypass this master EQ insert"}
            onClick={toggleBypass}
          >
            {selectedEq.bypassed ? "ENABLE" : "BYPASS"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small btn-primary master-spectrum-eq-add"
            aria-label="Add master EQ"
            title="Add an undoable EQ insert to the start of the master chain"
            onClick={addMasterEq}
          >
            ADD EQ
          </button>
        )}
      </div>
      <span className="sr-only">
        {selectedEq
          ? "Drag the four EQ points to change band gain. Adjust frequencies and Q in the master insert editor."
          : "The spectrum is read-only until you add a master EQ insert."}
      </span>
    </div>
  );
}
