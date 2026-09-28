"""Follow-up: WHY is melodic-v2's duration head broken? (audit 2026-09-27)

The k-fold audit showed v2 duration accuracy 0.451 -- BELOW the 0.500
majority baseline. Two candidate causes:

  A. the head collapsed to one class (label smoothing + class weights)
  B. the head is spread/thrashing (no collapse, just noise)

This prints the predicted class distribution per model so the failure mode is
named instead of guessed.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from train_symbolic_melodic_lib import SemanticLookup  # noqa: E402

DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
MODELS = ROOT / "public" / "models"
DURATION_LABELS = ["1", "2", "4", "8"]
DEGREE_LABELS = ["rest", "d0", "d1", "d2", "d3", "d4", "d5", "d6"]


def transform_for_v2(x_all: np.ndarray, groups: np.ndarray):
    vectors = SemanticLookup(ROOT / "scripts" / "data" / "style-embeddings.json")
    rows = []
    for i, group in enumerate(groups):
        semantic = vectors.vector_for(str(group))
        if semantic is None:
            return None
        rows.append(list(semantic) + list(x_all[i][4:]))
    return np.array(rows, dtype=np.float64)


def main() -> None:
    payload = json.loads(DATASET.read_text())
    data = payload["data"]
    x_all = np.array([s["x"] for s in data], dtype=np.float64)
    y_duration = np.array([s["duration"] for s in data], dtype=np.int64)
    y_degree = np.array([s["degree"] for s in data], dtype=np.int64)
    groups = np.array([s["group"] for s in data])
    x_v2 = transform_for_v2(x_all, groups)

    print("=" * 78)
    print("DURATION HEAD FAILURE MODE")
    print("=" * 78)
    true_dist = Counter(y_duration.tolist())
    print("TRUE duration distribution:",
          {DURATION_LABELS[k]: v for k, v in sorted(true_dist.items())})
    print()

    for name in ["symbolic-melodic-v1", "symbolic-melodic-v2"]:
        manifest = json.loads((MODELS / f"{name}.manifest.json").read_text())
        path = MODELS / Path(manifest["modelPath"]).name
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        features = x_v2 if int(manifest["featureCount"]) == 41 else x_all
        out = session.run(
            [manifest["durationOutputName"], manifest["degreeOutputName"]],
            {manifest["inputName"]: features.astype(np.float32)},
        )
        dur_logits, deg_logits = np.asarray(out[0]), np.asarray(out[1])
        dur_pred = dur_logits.argmax(axis=1)
        deg_pred = deg_logits.argmax(axis=1)

        pred_dist = Counter(dur_pred.tolist())
        print(f"{name}  (featureCount={manifest['featureCount']})")
        print("  predicted duration:",
              {DURATION_LABELS[k]: v for k, v in sorted(pred_dist.items())})
        print(f"  distinct duration classes used: {len(pred_dist)} of 4")
        # logit spread tells us if the head is saturated or timid
        spread = dur_logits.max(axis=1) - dur_logits.min(axis=1)
        print(f"  duration logit spread: mean={spread.mean():.2f} max={spread.max():.2f}")
        # per-class recall on ALL rows
        print("  duration recall (all rows):")
        for cls in range(4):
            m = y_duration == cls
            if m.sum() == 0:
                continue
            print(f"    {DURATION_LABELS[cls]}: n={m.sum():4d} recall={(dur_pred[m] == cls).mean() * 100:5.1f}%")
        print(f"  degree accuracy (all rows): {(deg_pred == y_degree).mean() * 100:.1f}%")
        print()


if __name__ == "__main__":
    main()
