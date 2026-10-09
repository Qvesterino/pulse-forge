import { useEffect, useMemo, useRef, useState } from "react";
import { createProjectFromTemplate } from "../project-model/templates";
import {
  MASTER_EFFECT_OWNER_ID,
  type EffectInstance,
  type GroupTrack,
  type MasterConfig,
} from "../project-model/types";
import { ProjectStore } from "../store/ProjectStore";
import { EffectRack } from "./EffectRack";
import { ServicesContext, useMaster, useServices } from "./context";

interface MasteringSessionInsertRackProps {
  sessionId: string;
  masterConfig: MasterConfig;
  disabled: boolean;
  onEffectsChange: (effects: EffectInstance[]) => void;
}

/**
 * The external-file rack edits a scratch document so its commands and history
 * cannot mutate the open music project. The saved session stores only its
 * serializable master config; the renderer applies that config to the source.
 */
export function MasteringSessionInsertRack({
  sessionId,
  masterConfig,
  disabled,
  onEffectsChange,
}: MasteringSessionInsertRackProps) {
  const parentServices = useServices();
  const [sessionStore] = useState(() => {
    const base = createProjectFromTemplate("empty");
    return new ProjectStore({
      ...base,
      name: "External mastering session",
      master: masterConfig,
    });
  });
  const isolatedServices = useMemo(() => ({ ...parentServices, store: sessionStore }), [parentServices, sessionStore]);

  return (
    <ServicesContext.Provider value={isolatedServices}>
      <MasteringSessionInsertRackContents sessionId={sessionId} disabled={disabled} onEffectsChange={onEffectsChange} />
    </ServicesContext.Provider>
  );
}

function MasteringSessionInsertRackContents({
  sessionId,
  disabled,
  onEffectsChange,
}: Omit<MasteringSessionInsertRackProps, "masterConfig">) {
  const services = useServices();
  const master = useMaster();
  const lastEffects = useRef(master.effects);
  const track = useMemo<GroupTrack>(
    () => ({
      id: MASTER_EFFECT_OWNER_ID,
      kind: "group",
      name: "SESSION MASTER",
      gain: master.masterGain,
      pan: 0,
      mute: false,
      solo: false,
      effects: master.effects ?? [],
      sends: {},
    }),
    [master.effects, master.masterGain],
  );

  useEffect(() => {
    if (lastEffects.current === master.effects) return;
    lastEffects.current = master.effects;
    onEffectsChange(master.effects ?? []);
  }, [master.effects, onEffectsChange]);

  return (
    <fieldset className="mastering-session-inserts" disabled={disabled}>
      <legend>MASTER INSERT CHAIN</legend>
      <p>Ordered effects run on the imported mix before the session’s glue, clipper and safety limiter.</p>
      <EffectRack
        track={track}
        mode="devices"
        isMaster
        showLiveRuntimeStatus={false}
        statusScopeId={`session-${sessionId}-master`}
        allowUserImpulseResponses={false}
      />
      <small className="mastering-session-inserts-note">
        This offline session does not show live GR or runtime status. Render and inspect the report or A/B audition to
        evaluate its processing. User impulse-response files are not attached to the live project.
      </small>
      <span className="sr-only" aria-live="polite">
        {services.store.getDoc().master.effects?.length ?? 0} master inserts
      </span>
    </fieldset>
  );
}
