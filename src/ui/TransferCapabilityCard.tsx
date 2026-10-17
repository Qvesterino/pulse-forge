interface TransferCapabilityCardProps {
  onStartTransfer: () => void;
}

/** First-run contract: make the available transfer and runtime boundaries visible before setup. */
export function TransferCapabilityCard({ onStartTransfer }: TransferCapabilityCardProps) {
  return (
    <section className="pb-capability-card" aria-labelledby="pb-capability-title">
      <header className="pb-capability-head">
        <p className="pb-capability-eyebrow">COMING FROM ANOTHER DAW?</p>
        <h1 id="pb-capability-title">Continue your song in KYX</h1>
        <p>
          Export aligned full-length WAV track-outs and one Standard MIDI file. KYX brings them into a new project you
          can edit, save and render.
        </p>
      </header>

      <dl className="pb-capability-list">
        <div>
          <dt>PROJECT FILES</dt>
          <dd>KYX projects and supported project JSON import. FLP, CPR, PTX, AAF and OMF do not.</dd>
        </div>
        <div>
          <dt>AUDIO + MIDI TRANSFER</dt>
          <dd>Up to 32 aligned WAV tracks and 8 melodic MIDI lanes; starting tempo and meter are retained.</dd>
        </div>
        <div>
          <dt>AUDIO DEVICES</dt>
          <dd>Web Audio/browser device path. A native low-latency Windows audio backend is not shipped.</dd>
        </div>
        <div>
          <dt>PLUG-INS</dt>
          <dd>CLAP scanning reads metadata only. CLAP, VST3 and AU audio hosting are not shipped.</dd>
        </div>
      </dl>

      <p className="pb-capability-boundary">
        KYX does not recreate source fader, pan or automation controls. Any levels or effects printed into the WAVs stay
        in the audio; native layout, plug-in state, routing and tempo maps stay in the source project.
      </p>
      <button type="button" className="btn btn-small btn-primary" onClick={onStartTransfer}>
        PREPARE WAV + MIDI TRANSFER
      </button>
    </section>
  );
}
