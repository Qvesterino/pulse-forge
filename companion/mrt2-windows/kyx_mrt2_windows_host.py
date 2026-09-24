#!/usr/bin/env python3
"""KYX Windows MRT2 companion.

This process is intentionally small and protocol-first.  Electron owns the
executable path and model root; this process only receives the framed protocol
over stdin/stdout.  The optional JAX backend is imported lazily so a missing
Windows runtime produces an honest ``supportsCapture=false`` handshake instead
of a process crash or synthetic audio.

The JAX path is capture-only until a benchmark has proved a stronger tier. It
uses the public ``magenta_rt.MagentaRT2Jax`` API and keeps all model inference
outside the browser and AudioWorklet threads.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import struct
import sys
import threading
import time
import uuid
from typing import Any


PROTOCOL_VERSION = 1
PROVIDER_ID = "mrt2"
MODEL_ID = "mrt2_small"
SAMPLE_RATE = 48_000
CHANNELS = 2
MODEL_FRAME_RATE = 25
MODEL_SAMPLES_PER_FRAME = SAMPLE_RATE // MODEL_FRAME_RATE
MAX_CAPTURE_SECONDS = 120.0
MAX_CONTROL_BYTES = 64 * 1024
MAX_PACKET_FRAMES = SAMPLE_RATE * 15
MAX_FRAME_BYTES = 5_760_288
MAGIC = b"KYXMRT2\0"
AUDIO_HEADER_FORMAT = "<8sHBBIIIII"
AUDIO_HEADER_BYTES = struct.calcsize(AUDIO_HEADER_FORMAT)


def _json_bytes(value: dict[str, Any]) -> bytes:
  payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
  if len(payload) > MAX_CONTROL_BYTES:
    raise ValueError("MRT2 control message is too large")
  return payload


def _bounded_string(value: Any, label: str, limit: int = 400) -> str:
  if not isinstance(value, str) or not value or len(value) > limit:
    raise ValueError(f"{label} must be a non-empty bounded string")
  return value


def _canonical_hash(value: Any) -> str:
  encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
  return hashlib.sha256(encoded).hexdigest()


def _read_exact(stream, size: int) -> bytes | None:
  chunks: list[bytes] = []
  remaining = size
  while remaining:
    chunk = stream.read(remaining)
    if not chunk:
      return None
    chunks.append(chunk)
    remaining -= len(chunk)
  return b"".join(chunks)


class Mrt2WindowsHost:
  def __init__(self, model_root: Path):
    self.model_root = model_root.expanduser().resolve()
    self.resources = self.model_root / "resources"
    self.checkpoint = self.model_root / "checkpoints" / f"{MODEL_ID}.safetensors"
    self.exported_model = self.model_root / "models" / MODEL_ID
    self._stdout_lock = threading.Lock()
    self._shutdown = False
    self._session_inputs: dict[tuple[str, str], dict[str, Any]] = {}
    self._systems: dict[str, Any] = {}
    self._runtime_version = self._package_version()
    self._has_runtime = self._runtime_available()
    self._has_assets = self._asset_layout_available()

  @staticmethod
  def _package_version() -> str | None:
    try:
      return importlib.metadata.version("magenta-rt")
    except importlib.metadata.PackageNotFoundError:
      return None

  @staticmethod
  def _runtime_available() -> bool:
    # Do not import JAX or Magenta during startup.  Importing either can load
    # large native libraries and may take longer than Electron's ready-line
    # timeout.  The actual imports happen on the first capture request.
    return importlib.util.find_spec("magenta_rt") is not None and importlib.util.find_spec("jax") is not None

  def _asset_layout_available(self) -> bool:
    shared_resources = (self.resources / "musiccoca").is_dir() and (self.resources / "spectrostream").is_dir()
    # JAX needs the raw checkpoint.  Keep the exported-model directory as a
    # valid installation marker for a future CUDA/ONNX adapter, but do not
    # claim that this adapter can load it.
    return shared_resources and (self.checkpoint.is_file() or self.exported_model.is_dir())

  def runtime_profile(self) -> dict[str, Any]:
    warning: str | None = None
    if not self._has_runtime:
      warning = "Install magenta-rt with a Windows-compatible JAX runtime before using capture"
    elif not self._has_assets:
      warning = "MRT2 Small checkpoint and shared resources are missing from the Windows model root"
    else:
      warning = "Windows JAX backend is capture-only until the realtime benchmark promotes it"
    return {
      "backendId": "mrt2-windows-jax",
      "executionMode": "capture",
      **({"runtimeVersion": self._runtime_version} if self._runtime_version else {}),
      "warning": warning,
    }

  def supports_capture(self) -> bool:
    # An exported MLX model is deliberately not treated as a Windows runtime.
    # Capture becomes available only when the JAX package and raw checkpoint
    # are both present.
    return self._has_runtime and self._has_assets and self.checkpoint.is_file()

  def write_ready_line(self) -> None:
    ready = {
      "version": PROTOCOL_VERSION,
      "type": "ready",
      "providerId": PROVIDER_ID,
      "modelId": MODEL_ID,
      "runtimeProfile": self.runtime_profile(),
    }
    sys.stdout.write(json.dumps(ready, separators=(",", ":")) + "\n")
    sys.stdout.flush()

  def _send_frame(self, frame_type: int, transport_id: str, payload: bytes = b"") -> None:
    transport_bytes = transport_id.encode("utf-8")
    if not 1 <= len(transport_bytes) <= 128:
      raise ValueError("MRT2 transport id is invalid")
    body = bytes((frame_type,)) + struct.pack(">H", len(transport_bytes)) + transport_bytes + payload
    if len(body) < 3 or len(body) > MAX_FRAME_BYTES:
      raise ValueError("MRT2 child frame is too large")
    frame = struct.pack(">I", len(body)) + body
    with self._stdout_lock:
      sys.stdout.buffer.write(frame)
      sys.stdout.buffer.flush()

  def _send_control(self, transport_id: str, message: dict[str, Any]) -> None:
    self._send_frame(0, transport_id, _json_bytes(message))

  def _send_status(
    self,
    transport_id: str,
    state: str,
    request_id: str | None = None,
    session_id: str | None = None,
    message: str | None = None,
  ) -> None:
    status: dict[str, Any] = {"version": PROTOCOL_VERSION, "type": "status", "state": state}
    if request_id:
      status["requestId"] = request_id
    if session_id:
      status["sessionId"] = session_id
    if message:
      status["message"] = message[:400]
    self._send_control(transport_id, status)

  def _send_error(
    self,
    transport_id: str,
    code: str,
    message: str,
    request_id: str | None = None,
    session_id: str | None = None,
  ) -> None:
    error: dict[str, Any] = {
      "version": PROTOCOL_VERSION,
      "type": "error",
      "code": code[:120],
      "message": message[:400],
    }
    if request_id:
      error["requestId"] = request_id
    if session_id:
      error["sessionId"] = session_id
    self._send_control(transport_id, error)

  def _send_audio(self, transport_id: str, sequence: int, samples: Any) -> None:
    # Numpy is imported only after a real model has been requested.
    import numpy as np

    array = np.asarray(samples, dtype=np.float32)
    if array.ndim == 1:
      array = array.reshape((-1, 1))
    if array.ndim != 2 or array.shape[1] != CHANNELS:
      raise ValueError("MRT2 JAX backend returned non-stereo PCM")
    if array.shape[0] < 1 or array.shape[0] > MAX_PACKET_FRAMES:
      raise ValueError("MRT2 output packet frame count is invalid")
    if not np.isfinite(array).all():
      raise ValueError("MRT2 JAX backend returned non-finite PCM")
    pcm = np.ascontiguousarray(array, dtype="<f4").tobytes()
    header = struct.pack(
      AUDIO_HEADER_FORMAT,
      MAGIC,
      PROTOCOL_VERSION,
      0,
      CHANNELS,
      SAMPLE_RATE,
      int(array.shape[0]),
      sequence,
      len(pcm),
      0,
    )
    if len(header) != AUDIO_HEADER_BYTES or AUDIO_HEADER_BYTES != 32:
      raise RuntimeError("MRT2 audio packet header layout is invalid")
    self._send_frame(1, transport_id, header + pcm)

  def _system_for(self, model_id: str) -> Any:
    if model_id in self._systems:
      return self._systems[model_id]
    if not self.supports_capture():
      raise RuntimeError(self.runtime_profile()["warning"])
    # These imports are intentionally local.  A missing native dependency is
    # converted into a protocol error instead of killing the companion.
    from magenta_rt import MagentaRT2Jax, paths

    paths.set_magenta_home(self.model_root)
    system = MagentaRT2Jax(
      size=model_id,
      checkpoint=str(self.checkpoint),
      temperature=1.3,
      top_k=40,
      cfg_scales={"musiccoca": 3.0, "notes": 1.0, "drums": 1.0},
    )
    self._systems[model_id] = system
    return system

  def _generate_capture(self, input_value: dict[str, Any], duration_sec: float) -> tuple[Any, int]:
    import numpy as np
    from magenta_rt.config import DRUM_PIANOROLL, MUSICCOCA, PIANOROLL_WITH_ONSETS

    style = input_value.get("style")
    prompt = "instrumental cinematic pulse"
    if isinstance(style, dict) and style.get("kind") == "text":
      prompt = _bounded_string(style.get("text"), "input.style.text")
    target_frames = max(1, min(int(math.ceil(duration_sec * SAMPLE_RATE)), SAMPLE_RATE * int(MAX_CAPTURE_SECONDS)))
    model_frames = max(1, int(math.ceil(target_frames / MODEL_SAMPLES_PER_FRAME)))
    system = self._system_for(MODEL_ID)
    embedding = system.embed_style(prompt, use_mapper=True)
    # The JAX API accepts one 25 Hz piano-roll/drum token frame per generate
    # call. Carry the returned state between calls so notes and drums can
    # change throughout a bounded capture instead of being reduced to the
    # first frame. Tokenizing the style once avoids repeating MusicCoCa work.
    style_tokens = system.tokenize_style(embedding).tolist()
    note_frames = input_value.get("noteFrames")
    if not isinstance(note_frames, list):
      note_frames = []
    drum_mode = input_value.get("drumsMode", "provider-default")
    drum_token = 0 if drum_mode == "off" else 1 if drum_mode == "on" else -1
    generated: list[np.ndarray] = []
    state = None
    for frame_index in range(model_frames):
      frame = note_frames[frame_index] if frame_index < len(note_frames) else None
      pitch_state = frame.get("pitchState") if isinstance(frame, dict) else None
      if not isinstance(pitch_state, list) or len(pitch_state) != PIANOROLL_WITH_ONSETS.rvq_truncation_level:
        pitch_state = [0] * PIANOROLL_WITH_ONSETS.rvq_truncation_level
      waveform, state = system.generate(
        conditioning={
          MUSICCOCA.key: style_tokens,
          PIANOROLL_WITH_ONSETS.key: pitch_state,
          DRUM_PIANOROLL.key: [drum_token],
        },
        frames=1,
        state=state,
      )
      generated.append(np.asarray(waveform.samples, dtype=np.float32))
    samples = np.concatenate(generated, axis=0)
    if samples.ndim != 2 or samples.shape[1] != CHANNELS:
      raise RuntimeError("MRT2 JAX backend returned an unsupported waveform shape")
    return samples[:target_frames], min(target_frames, int(samples.shape[0]))

  def _handle_hello(self, transport_id: str, request_id: str) -> None:
    supports_capture = self.supports_capture()
    self._send_control(
      transport_id,
      {
        "version": PROTOCOL_VERSION,
        "type": "hello.ok",
        "requestId": request_id,
        "providerId": PROVIDER_ID,
        "modelIds": [MODEL_ID],
        "outputSampleRates": [SAMPLE_RATE],
        "outputChannels": [CHANNELS],
        "supportsRealtime": False,
        "supportsCapture": supports_capture,
        "supportsTextStyle": supports_capture,
        "supportsNoteConditioning": supports_capture,
        "supportsAudioStyle": False,
        "supportsDrumsMode": supports_capture,
        "supportsSeed": False,
        "maxCaptureSeconds": MAX_CAPTURE_SECONDS if supports_capture else 0,
        "macroSupport": {
          "energy": "unsupported",
          "density": "unsupported",
          "variation": "unsupported",
          "texture": "unsupported",
        },
        "runtimeProfile": self.runtime_profile(),
      },
    )
    if not supports_capture:
      self._send_status(transport_id, "unavailable", message=self.runtime_profile()["warning"])

  def _handle_control(self, transport_id: str, message: dict[str, Any]) -> None:
    message_type = message.get("type")
    request_id = message.get("requestId")
    if not isinstance(request_id, str) or not request_id:
      raise ValueError("MRT2 requestId is required")
    session_id = message.get("sessionId")

    if message_type == "hello":
      if message.get("client") != "kyx":
        raise ValueError("MRT2 hello client is invalid")
      self._handle_hello(transport_id, request_id)
      return

    if message_type == "session.create":
      config = message.get("config")
      if not isinstance(config, dict) or config.get("modelId") != MODEL_ID:
        raise ValueError("MRT2 session model is unsupported")
      if config.get("outputSampleRate") != SAMPLE_RATE or config.get("outputChannels") != CHANNELS:
        raise ValueError("MRT2 session output format is unsupported")
      created_id = str(uuid.uuid4())
      self._session_inputs[(transport_id, created_id)] = {}
      self._send_control(transport_id, {"version": PROTOCOL_VERSION, "type": "session.ok", "requestId": request_id, "sessionId": created_id})
      if self.supports_capture():
        self._send_status(transport_id, "ready", session_id=created_id)
      return

    if not isinstance(session_id, str) or not session_id or (transport_id, session_id) not in self._session_inputs:
      raise ValueError("MRT2 session is unknown")
    key = (transport_id, session_id)

    if message_type == "input.update":
      input_value = message.get("input")
      if not isinstance(input_value, dict):
        raise ValueError("MRT2 input is invalid")
      self._session_inputs[key] = input_value
      self._send_status(transport_id, "ready", request_id=request_id, session_id=session_id)
      return

    if message_type == "session.start":
      self._send_error(transport_id, "realtime_unsupported", "Windows MRT2 companion is capture-only", request_id, session_id)
      return

    if message_type == "session.stop":
      self._send_status(transport_id, "ready", request_id=request_id, session_id=session_id)
      return

    if message_type == "session.close":
      self._session_inputs.pop(key, None)
      self._send_status(transport_id, "idle", request_id=request_id, session_id=session_id)
      return

    if message_type == "capture.start":
      duration_sec = message.get("durationSec")
      if (
        isinstance(duration_sec, bool)
        or not isinstance(duration_sec, (int, float))
        or not math.isfinite(duration_sec)
        or duration_sec <= 0
        or duration_sec > MAX_CAPTURE_SECONDS
      ):
        raise ValueError("MRT2 capture duration is invalid")
      if not self.supports_capture():
        self._send_error(transport_id, "capture_unavailable", self.runtime_profile()["warning"], request_id, session_id)
        return
      self._send_status(transport_id, "capturing", session_id=session_id)
      started = time.perf_counter()
      try:
        samples, frames = self._generate_capture(self._session_inputs[key], float(duration_sec))
        sequence = 0
        for offset in range(0, frames, MODEL_SAMPLES_PER_FRAME):
          chunk = samples[offset : min(frames, offset + MODEL_SAMPLES_PER_FRAME)]
          self._send_audio(transport_id, sequence, chunk)
          sequence += 1
        elapsed_ms = (time.perf_counter() - started) * 1000
        self._send_control(
          transport_id,
          {
            "version": PROTOCOL_VERSION,
            "type": "capture.ok",
            "requestId": request_id,
            "sessionId": session_id,
            "frames": frames,
            "durationSec": frames / SAMPLE_RATE,
            "inputHash": _canonical_hash(self._session_inputs[key]),
          },
        )
        self._send_status(transport_id, "ready", session_id=session_id, message=f"Captured {frames / SAMPLE_RATE:.2f}s in {elapsed_ms:.0f}ms")
      except Exception as error:  # noqa: BLE001 - process boundary must stay alive
        message_text = str(error) or error.__class__.__name__
        self._send_status(transport_id, "error", request_id=request_id, session_id=session_id, message=message_text)
        self._send_error(transport_id, "capture_failed", message_text, request_id, session_id)
      return

    raise ValueError(f"Unsupported MRT2 control message: {message_type}")

  def serve(self) -> None:
    self.write_ready_line()
    input_stream = sys.stdin.buffer
    while not self._shutdown:
      header = _read_exact(input_stream, 4)
      if header is None:
        break
      (body_length,) = struct.unpack(">I", header)
      if body_length < 3 or body_length > MAX_FRAME_BYTES:
        raise ValueError("MRT2 child frame length is invalid")
      body = _read_exact(input_stream, body_length)
      if body is None:
        break
      frame_type = body[0]
      id_length = struct.unpack(">H", body[1:3])[0]
      if id_length < 1 or 3 + id_length > len(body):
        raise ValueError("MRT2 transport id is invalid")
      payload = body[3 + id_length :]
      transport_id = ""
      message: dict[str, Any] | None = None
      try:
        transport_id = body[3 : 3 + id_length].decode("utf-8")
        if frame_type == 0:
          if len(payload) > MAX_CONTROL_BYTES:
            raise ValueError("MRT2 control message is too large")
          message = json.loads(payload.decode("utf-8"))
          if not isinstance(message, dict) or message.get("version") != PROTOCOL_VERSION:
            raise ValueError("MRT2 control message is invalid")
          self._handle_control(transport_id, message)
        elif frame_type == 1:
          # Audio style conditioning is intentionally unsupported by the first
          # Windows adapter.  Reject instead of silently ignoring user input.
          self._send_error(transport_id, "audio_style_unsupported", "Windows MRT2 companion does not accept audio style packets")
        elif frame_type == 2:
          for key in [key for key in self._session_inputs if key[0] == transport_id]:
            self._session_inputs.pop(key, None)
          self._send_frame(2, transport_id, b"transport closed")
        elif frame_type == 3:
          self._shutdown = True
        else:
          raise ValueError("MRT2 frame type is unsupported")
      except (BrokenPipeError, OSError):
        self._shutdown = True
      except Exception as error:  # noqa: BLE001 - malformed renderer data is recoverable
        request_id = None
        session_id = None
        if isinstance(message, dict):
          request_id = message.get("requestId")
          session_id = message.get("sessionId")
        if transport_id:
          self._send_error(transport_id, "protocol_error", str(error) or error.__class__.__name__, request_id, session_id)


def main() -> int:
  parser = argparse.ArgumentParser(description="KYX Windows MRT2 companion")
  parser.add_argument("--model-root", default=os.environ.get("KYX_MRT2_WINDOWS_MODEL_ROOT"))
  args = parser.parse_args()
  model_root = Path(args.model_root) if args.model_root else Path.home() / "Documents" / "Magenta" / "magenta-rt-v2-windows"
  try:
    Mrt2WindowsHost(model_root).serve()
  except BrokenPipeError:
    return 0
  except Exception as error:  # noqa: BLE001 - startup failures must be visible to Electron stderr
    print(f"KYX MRT2 Windows companion failed: {error}", file=sys.stderr, flush=True)
    return 1
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
