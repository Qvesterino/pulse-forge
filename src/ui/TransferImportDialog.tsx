import { useMemo, useRef, useState } from "react";
import type { CoreServices } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { UserSampleRepository } from "../persistence/UserSampleRepository";
import { importAudioFile } from "./sample-import";
import { uid } from "../shared/ids";
import {
  buildTransferProject,
  inspectTransferFiles,
  midiImportWarnings,
  type TransferInspection,
  type TransferSourceDaw,
} from "../export/transfer-import";

interface TransferImportDialogProps {
  core: CoreServices;
  onCancel: () => void;
  onImported: (doc: ProjectDocument) => void;
}

const DAW_GUIDANCE: Record<TransferSourceDaw, string> = {
  "fl-studio":
    "Export a full-song MIDI file and aligned full-length mixer-track WAVs. MIDI automation, channel effects and plug-in state are not transferred.",
  cubase:
    "Export one combined MIDI file and full-range audio track renders. Keep every render aligned to the same project start.",
  "pro-tools":
    "Consolidate or export full-range track-outs from session start, then export MIDI if the session contains editable instrument parts.",
  other:
    "Choose audio track-outs and one combined Standard MIDI file. All audio renders must begin at the same song origin.",
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function referenceCandidate(fileName: string): boolean {
  const base = fileName.replace(/\.[^.]+$/, "");
  return /(^|[\s_.-])(reference|ref|rough.?mix|full.?mix|master)([\s_.-]|$)/i.test(base);
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function TransferImportDialog({ core, onCancel, onImported }: TransferImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inspectionSequence = useRef(0);
  const sampleRepo = useMemo(() => new UserSampleRepository(), []);
  const [files, setFiles] = useState<File[]>([]);
  const [inspection, setInspection] = useState<TransferInspection | null>(null);
  const [sourceDaw, setSourceDaw] = useState<TransferSourceDaw>("other");
  const [projectName, setProjectName] = useState("Transferred Song");
  const [bpm, setBpm] = useState(120);
  const [bpmTouched, setBpmTouched] = useState(false);
  const [numerator, setNumerator] = useState(4);
  const [denominator, setDenominator] = useState(4);
  const [meterTouched, setMeterTouched] = useState(false);
  const [referenceFiles, setReferenceFiles] = useState<Set<string>>(() => new Set());
  const [aligned, setAligned] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFiles = async (selection: FileList | null) => {
    if (!selection) return;
    const selected = Array.from(selection);
    setFiles(selected);
    setInspection(null);
    setError(null);
    setAligned(false);
    setAcknowledged(false);
    setReferenceFiles(new Set(selected.filter((file) => referenceCandidate(file.name)).map(fileKey)));
    const firstBase = selected[0]?.name.replace(/\.[^.]+$/, "").trim();
    if (firstBase) setProjectName(firstBase.slice(0, 64));

    const sequence = ++inspectionSequence.current;
    const result = await inspectTransferFiles(selected);
    if (sequence !== inspectionSequence.current) return;
    setInspection(result);
    if (result.parsedMidi) {
      if (
        !bpmTouched &&
        result.parsedMidi.bpm !== null &&
        result.parsedMidi.bpm >= 20 &&
        result.parsedMidi.bpm <= 300
      ) {
        setBpm(result.parsedMidi.bpm);
      }
      if (!meterTouched && result.parsedMidi.timeSignature) {
        setNumerator(Math.min(32, Math.max(1, result.parsedMidi.timeSignature.num)));
        setDenominator(
          [1, 2, 4, 8, 16, 32].includes(result.parsedMidi.timeSignature.den) ? result.parsedMidi.timeSignature.den : 4,
        );
      }
    }
  };

  const warnings = [
    ...new Set([...(inspection?.warnings ?? []), ...midiImportWarnings(inspection?.parsedMidi ?? null)]),
  ];
  const alignmentRequired = (inspection?.audioFiles.length ?? 0) > 0;
  const settingsError =
    !Number.isFinite(bpm) || bpm < 20 || bpm > 300
      ? "Project tempo must be 20–300 BPM."
      : !Number.isInteger(numerator) || numerator < 1 || numerator > 32
        ? "Beats per bar must be a whole number from 1 to 32."
        : ![1, 2, 4, 8, 16, 32].includes(denominator)
          ? "Choose a supported beat unit: 1, 2, 4, 8, 16 or 32."
          : null;
  const canImport =
    !busy &&
    files.length > 0 &&
    inspection !== null &&
    inspection.errors.length === 0 &&
    settingsError === null &&
    (!alignmentRequired || aligned) &&
    (warnings.length === 0 || acknowledged) &&
    projectName.trim().length > 0;

  const importTransfer = async () => {
    if (!inspection || !canImport) return;
    setBusy(true);
    setError(null);
    const importedAssets: Array<{ id: string }> = [];
    let projectSaved = false;
    try {
      const audioAssets = [];
      for (const file of inspection.audioFiles) {
        const id = uid("transfer-audio");
        // Register the intended ID before decoding/persisting so a partial
        // failure inside importAudioFile is included in the batch rollback.
        importedAssets.push({ id });
        const asset = await importAudioFile({ engine: core.engine, bank: core.bank, userSamples: sampleRepo }, file, {
          id,
          detectBpm: false,
        });
        audioAssets.push({
          fileName: file.name,
          assetId: asset.id,
          durationSec: asset.duration,
          referenceMix: referenceFiles.has(fileKey(file)),
        });
      }

      const midiBytes = inspection.midiFile ? new Uint8Array(await inspection.midiFile.arrayBuffer()) : undefined;
      const parsed = inspection.parsedMidi;
      const result = buildTransferProject({
        projectName,
        bpm,
        timeSignature: { numerator, denominator },
        audioAssets,
        ...(midiBytes ? { midiBytes, parsedMidi: parsed, midiFileName: inspection.midiFile?.name } : {}),
      });

      await core.repo.save(result.doc);
      projectSaved = true;
      onImported(result.doc);
    } catch (importError) {
      if (!projectSaved) {
        for (const { id } of importedAssets) {
          core.bank.remove(id);
          await sampleRepo.remove(id);
        }
      }
      setError(importError instanceof Error ? importError.message : "Transfer import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kyx-transfer-backdrop" role="presentation">
      <section className="kyx-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="kyx-transfer-title">
        <header className="kyx-transfer-header">
          <div>
            <p className="kyx-transfer-eyebrow">DAW MIGRATION</p>
            <h2 id="kyx-transfer-title">BRING A SONG</h2>
            <p>Continue a song from standard audio and MIDI exports. Your original DAW project stays untouched.</p>
          </div>
          <button
            type="button"
            className="btn btn-small"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close transfer import"
          >
            CLOSE
          </button>
        </header>

        <div className="kyx-transfer-body">
          <div className="kyx-transfer-top-fields">
            <label>
              SOURCE DAW
              <select
                value={sourceDaw}
                onChange={(event) => setSourceDaw(event.target.value as TransferSourceDaw)}
                disabled={busy}
              >
                <option value="fl-studio">FL Studio</option>
                <option value="cubase">Cubase</option>
                <option value="pro-tools">Pro Tools</option>
                <option value="other">Other / already exported</option>
              </select>
            </label>
            <label>
              PROJECT NAME
              <input
                value={projectName}
                maxLength={64}
                onChange={(event) => setProjectName(event.target.value)}
                disabled={busy}
              />
            </label>
          </div>

          <p className="kyx-transfer-guidance">{DAW_GUIDANCE[sourceDaw]}</p>

          <input
            ref={inputRef}
            className="kyx-transfer-file-input"
            type="file"
            multiple
            accept=".wav,.wave,.mp3,.ogg,.oga,.opus,.flac,.aiff,.aif,.aifc,.m4a,.aac,.webm,.mid,.midi,audio/*"
            onChange={(event) => {
              void chooseFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            CHOOSE AUDIO + MIDI FILES
          </button>

          {files.length > 0 && (
            <div className="kyx-transfer-file-list" aria-label="Selected transfer files">
              <div className="kyx-transfer-list-head">
                <span>FILE</span>
                <span>TYPE / SIZE</span>
                <span>ROLE</span>
              </div>
              {files.map((file, index) => {
                const isMidi = /\.(mid|midi)$/i.test(file.name);
                const isReference = referenceFiles.has(fileKey(file));
                return (
                  <div className="kyx-transfer-file-row" key={`${fileKey(file)}:${index}`}>
                    <span className="kyx-transfer-file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span>
                      {isMidi ? "MIDI" : "AUDIO"} · {sizeLabel(file.size)}
                    </span>
                    <label className="kyx-transfer-reference-toggle">
                      <input
                        type="checkbox"
                        checked={isReference}
                        disabled={busy || isMidi}
                        onChange={(event) => {
                          const next = new Set(referenceFiles);
                          if (event.target.checked) next.add(fileKey(file));
                          else next.delete(fileKey(file));
                          setReferenceFiles(next);
                        }}
                      />
                      <span>{isReference ? "Reference (muted)" : "Track"}</span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}

          {inspection?.parsedMidi && (
            <div className="kyx-transfer-midi-summary" aria-label="MIDI preflight summary">
              <strong>{inspection.parsedMidi.tracks.length} MIDI track/channel(s)</strong>
              <span>
                {inspection.parsedMidi.tracks
                  .map((track) => track.name)
                  .filter((name, index, all) => all.indexOf(name) === index)
                  .join(" · ")}
              </span>
              <span>
                MIDI suggests {inspection.parsedMidi.bpm ?? bpm} BPM ·{" "}
                {inspection.parsedMidi.timeSignature?.num ?? numerator}/
                {inspection.parsedMidi.timeSignature?.den ?? denominator}
              </span>
            </div>
          )}

          <div className="kyx-transfer-music-fields">
            <label>
              SONG TEMPO (BPM)
              <input
                type="number"
                min={20}
                max={300}
                step={0.1}
                value={bpm}
                onChange={(event) => {
                  setBpmTouched(true);
                  setBpm(Number(event.target.value));
                }}
                disabled={busy}
              />
            </label>
            <label>
              BEATS PER BAR
              <input
                type="number"
                min={1}
                max={32}
                step={1}
                value={numerator}
                onChange={(event) => {
                  setMeterTouched(true);
                  setNumerator(Number(event.target.value));
                }}
                disabled={busy}
              />
            </label>
            <label>
              BEAT UNIT
              <select
                value={denominator}
                onChange={(event) => {
                  setMeterTouched(true);
                  setDenominator(Number(event.target.value));
                }}
                disabled={busy}
              >
                {[1, 2, 4, 8, 16, 32].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {alignmentRequired && (
            <label className="kyx-transfer-confirm-row">
              <input
                type="checkbox"
                checked={aligned}
                onChange={(event) => setAligned(event.target.checked)}
                disabled={busy}
              />
              <span>All audio exports start at the same song origin and cover the intended range.</span>
            </label>
          )}

          <div className="kyx-transfer-boundary">
            <strong>Import limits</strong>
            <p>
              Up to 32 audio files at 25 MB each and one MIDI file up to 10 MB. MIDI supports up to 8 melodic lanes; GM
              drums use a 32-bar 16th-note grid.
            </p>
            <strong>What transfers</strong>
            <p>
              Audio clips, file/track names, MIDI notes, GM drum hits, project tempo and one time signature. Reference
              mixes are imported muted when marked above.
            </p>
            <strong>What stays behind</strong>
            <p>
              Native project layout, plug-in state, instrument patches, mixer routing, automation and MIDI
              CC/pitch-bend/program data. These are disclosed here rather than silently substituted.
            </p>
          </div>

          {inspection?.warnings.map((warning) => (
            <p className="kyx-transfer-warning" key={warning}>
              {warning}
            </p>
          ))}
          {inspection?.errors.map((message) => (
            <p className="kyx-transfer-error" role="alert" key={message}>
              {message}
            </p>
          ))}
          {settingsError && (
            <p className="kyx-transfer-error" role="alert">
              {settingsError}
            </p>
          )}
          {error && (
            <p className="kyx-transfer-error" role="alert">
              {error}
            </p>
          )}

          {warnings.length > 0 && inspection?.errors.length === 0 && (
            <label className="kyx-transfer-confirm-row">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                disabled={busy}
              />
              <span>I have reviewed the transfer limits above and want to continue.</span>
            </label>
          )}
        </div>

        <footer className="kyx-transfer-footer">
          <button type="button" className="btn btn-small" onClick={onCancel} disabled={busy}>
            CANCEL
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => void importTransfer()}
            disabled={!canImport}
          >
            {busy ? "IMPORTING…" : "IMPORT AS NEW KYX PROJECT"}
          </button>
        </footer>
      </section>
    </div>
  );
}
