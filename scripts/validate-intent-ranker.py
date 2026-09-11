"""Validate the trained ONNX artifact with onnxruntime (goal doc Fáze 2/5).

Checks: session loads locally, input/output names match the manifest, a
deterministic probe batch yields finite scores, identical inputs produce
identical outputs, and the artifact stays under the 1 MB size budget.

Run: python scripts/validate-intent-ranker.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "public" / "models"
manifest = json.loads((MODELS_DIR / "intent-ranker-v1.manifest.json").read_text(encoding="utf8"))
model_path = MODELS_DIR / Path(manifest["modelPath"]).name

session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
assert session.get_inputs()[0].name == manifest["inputName"], "input name mismatch"
assert session.get_outputs()[0].name == manifest["outputName"], "output name mismatch"

feature_count = manifest["featureCount"]
probe = np.full((3, feature_count), 0.4, dtype=np.float32)
scores = session.run(None, {manifest["inputName"]: probe})[0]
assert scores.shape == (3, 1), f"output shape {scores.shape} != (3, 1)"
assert np.isfinite(scores).all(), "non-finite scores"

again = session.run(None, {manifest["inputName"]: probe})[0]
assert np.array_equal(scores, again), "inference is not deterministic"

model_bytes = model_path.read_bytes()
size_kb = len(model_bytes) / 1024
assert size_kb <= 1024, f"model artifact too large: {size_kb:.1f} kB"

# Manifest hash must match the artifact on disk.
disk_hash = hashlib.sha256(model_bytes).hexdigest()
assert disk_hash == manifest["modelHash"], "model hash mismatch vs manifest"

print(
    f"[validate] OK — output={scores.flatten().round(4).tolist()} "
    f"size={size_kb:.1f} kB sha256={disk_hash[:16]}…"
)
