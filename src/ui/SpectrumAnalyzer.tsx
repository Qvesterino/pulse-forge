import { useEffect, useRef } from "react";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

/**
 * Log-frequency spectrum analyzer canvas. Reads getFloatFrequencyData from an
 * existing AnalyserNode (observer-only — never touches the audio graph).
 *
 * X axis: log frequency 20 Hz → Nyquist.
 * Y axis: dB magnitude −100 → 0.
 * Draws a filled area with gradient. Peak-hold trace (slow decay) included.
 */
export function SpectrumAnalyzer({
  analyser,
  height = 72,
  accent = "#f59e0b",
  id,
}: {
  analyser: AnalyserNode | null;
  height?: number;
  accent?: string;
  id: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyser) return;
    const fftSize = analyser.fftSize;
    const binCount = fftSize >> 1;
    const freqData = new Float32Array(binCount);
    const peakHold = new Float32Array(binCount).fill(-120);
    const sampleRate = analyser.context.sampleRate;
    const minFreq = 20;
    const maxFreq = sampleRate / 2;
    const logMin = Math.log(minFreq);
    const logRange = Math.log(maxFreq) - logMin;
    const minDb = -100;
    const dbRange = 100;

    let last = 0;
    registerRaf(`spectrum-${id}`, (t) => {
      if (t - last < 33) return; // ~30 Hz
      last = t;

      analyser.getFloatFrequencyData(freqData);

      // Decay peak hold
      for (let i = 0; i < binCount; i++) {
        if (freqData[i] > peakHold[i]) peakHold[i] = freqData[i];
        else peakHold[i] = Math.max(minDb, peakHold[i] - 0.5); // 0.5 dB/frame decay
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Background grid: horizontal dB lines
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let db = -20; db > minDb; db -= 20) {
        const y = h * (1 - (db - minDb) / dbRange);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Frequency tick labels (100 Hz, 1 kHz, 10 kHz)
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.font = "9px monospace";
      const ticks: [number, string][] = [
        [100, "100"],
        [1000, "1k"],
        [10000, "10k"],
      ];
      for (const [freq, label] of ticks) {
        if (freq < minFreq || freq > maxFreq) continue;
        const x = (w * (Math.log(freq) - logMin)) / logRange;
        ctx.fillText(label, x + 2, h - 3);
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      // Spectrum fill + line
      const points: { x: number; y: number }[] = [];
      const step = Math.max(1, Math.floor((binCount / w) * 2)); // skip bins for performance on wide canvases
      for (let bin = 1; bin < binCount; bin += step) {
        const freq = (bin * sampleRate) / fftSize;
        if (freq < minFreq || freq > maxFreq) continue;
        const x = (w * (Math.log(freq) - logMin)) / logRange;
        const db = Math.max(minDb, Math.min(0, freqData[bin]));
        const y = h * (1 - (db - minDb) / dbRange);
        points.push({ x, y });
      }
      if (points.length < 2) return;

      // Gradient fill under curve
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, accent + "40"); // 25% opacity
      gradient.addColorStop(1, accent + "05"); // ~2% opacity
      ctx.beginPath();
      ctx.moveTo(points[0].x, h);
      for (const p of points) ctx.lineTo(p.x, p.y);
      ctx.lineTo(points[points.length - 1].x, h);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Spectrum line
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const p of points) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Peak hold line (dimmer)
      const peakPoints: { x: number; y: number }[] = [];
      for (let bin = 1; bin < binCount; bin += step) {
        const freq = (bin * sampleRate) / fftSize;
        if (freq < minFreq || freq > maxFreq) continue;
        const x = (w * (Math.log(freq) - logMin)) / logRange;
        const db = Math.max(minDb, Math.min(0, peakHold[bin]));
        const y = h * (1 - (db - minDb) / dbRange);
        peakPoints.push({ x, y });
      }
      ctx.beginPath();
      ctx.moveTo(peakPoints[0].x, peakPoints[0].y);
      for (const p of peakPoints) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = accent + "30";
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    return () => unregisterRaf(`spectrum-${id}`);
  }, [analyser, id, accent]);

  return (
    <canvas
      ref={canvasRef}
      className="spectrum-analyzer"
      style={{ width: "100%", height, display: "block" }}
      width={600}
      height={height}
      aria-label="Frequency spectrum"
      role="img"
    />
  );
}
