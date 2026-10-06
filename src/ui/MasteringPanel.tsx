import { memo, useMemo } from "react";
import { MASTER_EFFECT_OWNER_ID, type GroupTrack } from "../project-model/types";
import { MasterMeter } from "./MasterMeter";
import { ExportPanel } from "./ExportPanel";
import { useDoc, useMaster } from "./context";
import { EffectRack } from "./EffectRack";
import { projectRevisionIdFor } from "../mastering/report";

const StableMasterMeter = memo(MasterMeter);
const StableEffectRack = memo(EffectRack);

/** Dedicated final-output workspace: delivery checks above the final-sum inserts. */
export function MasteringPanel() {
  const doc = useDoc();
  const revisionId = projectRevisionIdFor(doc);
  const master = useMaster();
  const masterTrack = useMemo<GroupTrack>(
    () => ({
      id: MASTER_EFFECT_OWNER_ID,
      kind: "group",
      name: "MASTER",
      gain: master.masterGain ?? 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: master.effects ?? [],
      sends: {},
    }),
    [master.effects, master.masterGain],
  );

  return (
    <section className="mastering-panel" aria-label="Mastering workspace">
      <header className="mastering-panel-intro">
        <div>
          <span className="mastering-panel-kicker">FINAL OUTPUT</span>
          <h2>Mastering — {doc.name}</h2>
          <p>Check the complete mix against a delivery target, then shape it with final-sum inserts.</p>
        </div>
        <div className="mastering-signal-flow" aria-label="Master signal order">
          <span>INPUT + TONE</span>
          <b>→</b>
          <span>GLUE</span>
          <b>→</b>
          <strong>INSERTS</strong>
          <b>→</b>
          <span>CLIP + LIMIT</span>
        </div>
        <p className="mastering-profile-note">Delivery profiles set meter targets. They do not change the sound.</p>
      </header>
      <StableMasterMeter />
      <StableEffectRack track={masterTrack} mode="devices" isMaster />
      <section className="mastering-render-section" aria-label="Master render analysis and delivery">
        <header>
          <span className="mastering-panel-kicker">OFFLINE CHECK</span>
          <h3>Analyze and deliver</h3>
          <p>
            Render through the same engine used by playback. Analyze checks the source PCM; Export Master also checks
            the encoded WAV/MP3 header and, within the browser decode memory limit, measures the decoded deliverable.
          </p>
        </header>
        <ExportPanel masteringMode revisionId={revisionId} />
      </section>
    </section>
  );
}
