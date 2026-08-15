import type { DrumPad, InstrumentTrack, ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { EFFECT_DEFS } from "../effects/registry";
import type { EffectRuntime } from "../effects/types";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import type { InstrumentRuntime } from "../instruments/types";

interface TrackNodes {
  input: GainNode;
  panner: StereoPannerNode;
  gain: GainNode;
  analyser: AnalyserNode;
  fx: FxChainState;
}

interface FxChainState {
  runtimes: Map<string, EffectRuntime>;
  params: Map<string, Record<string, number>>;
  signature: string;
}

interface InstrumentState {
  runtime: InstrumentRuntime;
  params: Record<string, number>;
  sampleId: string | null;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  trackId: string;
  chokeGroup: number | null;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private bank: SampleBank | null = null;
  private doc: ProjectDocument | null = null;
  private trackNodes = new Map<string, TrackNodes>();
  private instruments = new Map<string, InstrumentState>();
  private voices = new Set<Voice>();
  private missedAssets = new Set<string>();
  private levelBuf = new Float32Array(1024);
  private syncedBpm = 0;

  attachBank(bank: SampleBank): void {
    this.bank = bank;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  get missingAssets(): string[] {
    return [...this.missedAssets];
  }

  ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.master.connect(this.masterAnalyser);
      this.master.connect(this.ctx.destination);
      if (this.doc) this.syncProject(this.doc);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  setProject(doc: ProjectDocument): void {
    this.doc = doc;
    if (this.ctx) this.syncProject(doc);
  }

  transportStarted(time: number, beatPhase: number): void {
    for (const nodes of this.trackNodes.values()) {
      for (const rt of nodes.fx.runtimes.values()) {
        rt.onTransportStarted?.(time, beatPhase);
      }
    }
  }

  private fxSignature(track: ProjectDocument["tracks"][number]): string {
    return track.effects.filter((e) => !e.bypassed).map((e) => `${e.id}:${e.type}`).join("|");
  }

  private rebuildFxChain(track: ProjectDocument["tracks"][number], nodes: TrackNodes): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    nodes.fx.params.clear();
    nodes.input.disconnect();
    const bpm = this.doc?.bpm ?? 124;
    let head: AudioNode = nodes.input;
    for (const fx of track.effects) {
      if (fx.bypassed) continue;
      const def = EFFECT_DEFS[fx.type];
      if (!def) continue;
      const rt = def.factory(ctx, fx, { bpm });
      head.connect(rt.input);
      head = rt.output;
      nodes.fx.runtimes.set(fx.id, rt);
      nodes.fx.params.set(fx.id, { ...fx.params });
    }
    head.connect(nodes.panner);
    nodes.fx.signature = this.fxSignature(track);
  }

  private syncFxParams(track: ProjectDocument["tracks"][number], nodes: TrackNodes): void {
    for (const fx of track.effects) {
      if (fx.bypassed) continue;
      const rt = nodes.fx.runtimes.get(fx.id);
      const cached = nodes.fx.params.get(fx.id);
      if (!rt || !cached) continue;
      for (const [k, v] of Object.entries(fx.params)) {
        if (cached[k] !== v) rt.setParameter(k, v);
      }
      nodes.fx.params.set(fx.id, { ...fx.params });
    }
  }

  private disposeTrackNodes(id: string, nodes: TrackNodes): void {
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    nodes.fx.params.clear();
    nodes.input.disconnect();
    nodes.panner.disconnect();
    nodes.gain.disconnect();
    nodes.analyser.disconnect();
    this.trackNodes.delete(id);
  }

  private syncProject(doc: ProjectDocument): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const liveIds = new Set(doc.tracks.map((t) => t.id));
    for (const [id, nodes] of this.trackNodes) {
      if (!liveIds.has(id)) this.disposeTrackNodes(id, nodes);
    }
    for (const [id, state] of [...this.instruments]) {
      if (!liveIds.has(id)) {
        state.runtime.dispose();
        this.instruments.delete(id);
      }
    }

    for (const track of doc.tracks) {
      let nodes = this.trackNodes.get(track.id);
      if (!nodes) {
        const input = ctx.createGain();
        const panner = ctx.createStereoPanner();
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        input.connect(panner);
        panner.connect(gain);
        gain.connect(this.master);
        gain.connect(analyser);
        nodes = { input, panner, gain, analyser, fx: { runtimes: new Map(), params: new Map(), signature: "" } };
        this.trackNodes.set(track.id, nodes);
      }
      const sig = this.fxSignature(track);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(track, nodes);
      } else {
        this.syncFxParams(track, nodes);
      }
      if (track.kind === "instrument") {
        this.syncInstrument(track, nodes);
      }
      const now = ctx.currentTime;
      nodes.panner.pan.setTargetAtTime(track.pan, now, 0.01);
      const anySolo = doc.tracks.some((t) => t.solo);
      const audible = !track.mute && (!anySolo || track.solo);
      nodes.gain.gain.setTargetAtTime(audible ? track.gain : 0, now, 0.01);
    }

    if (this.syncedBpm !== doc.bpm) {
      this.syncedBpm = doc.bpm;
      for (const nodes of this.trackNodes.values()) {
        for (const rt of nodes.fx.runtimes.values()) rt.syncBpm?.(doc.bpm);
      }
    }
  }

  private syncInstrument(track: InstrumentTrack, nodes: TrackNodes): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let state = this.instruments.get(track.id);
    if (!state) {
      const runtime = INSTRUMENT_DEFS[track.instrument].factory(
        ctx,
        track,
        { bpm: this.doc?.bpm ?? 124, getSample: (id) => this.bank?.get(id) },
      );
      runtime.output.connect(nodes.input);
      state = { runtime, params: { ...track.params }, sampleId: track.sampleId };
      this.instruments.set(track.id, state);
      return;
    }
    if (state.sampleId !== track.sampleId) {
      state.runtime.setSample?.(track.sampleId);
      state.sampleId = track.sampleId;
    }
    for (const [key, value] of Object.entries(track.params)) {
      if (state.params[key] !== value) state.runtime.setParameter(key, value);
    }
    state.params = { ...track.params };
  }

  noteOn(trackId: string, pitch: number, velocity: number, when: number, durationSec: number): void {
    this.instruments.get(trackId)?.runtime.noteOn(pitch, velocity, when, durationSec);
  }

  previewNote(trackId: string, pitch: number): void {
    const ctx = this.ensureContext();
    this.noteOn(trackId, pitch, 1, ctx.currentTime + 0.005, 0.25);
  }

  trigger(trackId: string, pad: DrumPad, when: number, velocity: number): void {
    const ctx = this.ctx;
    const trackNodes = this.trackNodes.get(trackId);
    const buffer = this.bank?.get(pad.assetId);
    if (!ctx || !trackNodes) return;
    if (!buffer) {
      if (pad.assetId) this.missedAssets.add(pad.assetId);
      return;
    }
    if (pad.chokeGroup !== null) this.choke(trackId, pad.chokeGroup, when);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.pow(2, pad.pitch / 12);
    const gain = ctx.createGain();
    gain.gain.value = velocity * pad.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pad.pan;
    source.connect(gain).connect(panner).connect(trackNodes.input);

    const voice: Voice = { source, gain, trackId, chokeGroup: pad.chokeGroup };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      gain.disconnect();
      panner.disconnect();
      source.disconnect();
    };
    source.start(when);
  }

  preview(pad: DrumPad, trackId: string): void {
    const ctx = this.ensureContext();
    this.trigger(trackId, pad, ctx.currentTime + 0.005, 1);
  }

  private choke(trackId: string, chokeGroup: number, when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const voice of this.voices) {
      if (voice.trackId !== trackId || voice.chokeGroup !== chokeGroup) continue;
      voice.gain.gain.cancelScheduledValues(ctx.currentTime);
      voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      try {
        voice.source.stop(when + 0.02);
      } catch {
        // already stopped
      }
      this.voices.delete(voice);
    }
  }

  panic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.008);
      try {
        voice.source.stop(now + 0.05);
      } catch {
        // already stopped
      }
    }
    this.voices.clear();
    for (const state of this.instruments.values()) state.runtime.panic();
  }

  private peakOf(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i]);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  getTrackLevel(trackId: string): number {
    return this.peakOf(this.trackNodes.get(trackId)?.analyser ?? null);
  }

  getMasterLevel(): number {
    return this.peakOf(this.masterAnalyser);
  }

  getDiagnostics(): Record<string, string | number> {
    const effectCount = [...this.trackNodes.values()].reduce((sum, n) => sum + n.fx.runtimes.size, 0);
    return {
      contextState: this.ctx?.state ?? "not-created",
      sampleRate: this.ctx?.sampleRate ?? "-",
      activeVoices: this.voices.size,
      loadedSamples: this.bank?.size ?? 0,
      activeEffects: effectCount,
      activeInstruments: this.instruments.size,
      missingAssets: this.missingAssets.join(", ") || "none",
    };
  }
}
