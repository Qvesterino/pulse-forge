"""Check for LEAKAGE in the shipped-model "k-fold" numbers (audit follow-up).

The k-fold audit evaluated the SHIPPED artifacts on all 5 folds. But a shipped
artifact was trained with one specific 15 % split held out — so for the folds
that do not contain those held-out groups, the model has SEEN the evaluation
rows during training. Its "CV" number is then mostly training accuracy.

This measures the difference: accuracy on the 4 groups the model was actually
held out from vs accuracy on everything else.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
MODELS = ROOT / "public" / "models"
SEED = 0x5EED
VAL_FRACTION = 0.15


def shipped_val_groups(groups: np.ndarray):
    rng = np.random.default_rng(SEED)
    unique = np.unique(groups)
    rng.shuffle(unique)
    count = max(1, int(len(unique) * VAL_FRACTION))
    return set(unique[:count].tolist())


def transform_for_v2(x_all: np.ndarray, groups: np.ndarray):
    payload = json.loads((ROOT / "scripts" / "data" / "style-embeddings.json").read_text())
    style_map = payload.get("styles", {})
    variant_map = payload.get("variants", {})
    vectors: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for style_id, vector in style_map.items():
        genre = style_id.split(".")[0]
        for vec in [vector] + list(variant_map.get(style_id, [])):
            if genre not in vectors:
                vectors[genre] = list(vec)
                counts[genre] = 1
            else:
                for d in range(len(vec)):
                    vectors[genre][d] += vec[d]
                counts[genre] += 1
    for genre, total in counts.items():
        for d in range(len(vectors[genre])):
            vectors[genre][d] /= total
    rows = []
    for i, group in enumerate(groups):
        semantic = vectors.get(str(group).split("#")[0])
        if semantic is None:
            return None
        rows.append(list(semantic) + list(x_all[i][4:]))
    return np.array(rows, dtype=np.float64)


def main() -> None:
    payload = json.loads(DATASET.read_text())
    data = payload["data"]
    x_all = np.array([s["x"] for s in data], dtype=np.float64)
    yd = np.array([s["degree"] for s in data], dtype=np.int64)
    yt = np.array([s["duration"] for s in data], dtype=np.int64)
    groups = np.array([s["group"] for s in data])
    x_v2 = transform_for_v2(x_all, groups)

    held = shipped_val_groups(groups)
    unseen = np.array([g in held for g in groups])
    seen = ~unseen
    print("=" * 78)
    print("SHIPPED-MODEL EVALUATION LEAKAGE CHECK")
    print("=" * 78)
    print(f"held-out groups: {len(held)}  unseen rows: {unseen.sum()}  seen rows: {seen.sum()}")
    print()

    for name in ["symbolic-melodic-v1", "symbolic-melodic-v2"]:
        manifest = json.loads((MODELS / f"{name}.manifest.json").read_text())
        session = ort.InferenceSession(str(MODELS / Path(manifest["modelPath"]).name), providers=["CPUExecutionProvider"])
        features = x_v2 if int(manifest["featureCount"]) == 41 else x_all
        out = session.run(
            [manifest["degreeOutputName"], manifest["durationOutputName"]],
            {manifest["inputName"]: features.astype(np.float32)},
        )
        dp = np.asarray(out[0]).argmax(axis=1)
        tp = np.asarray(out[1]).argmax(axis=1)
        print(f"{name}:")
        print(f"  UNSEEN (honest)  deg={(dp[unseen] == yd[unseen]).mean():.4f}  dur={(tp[unseen] == yt[unseen]).mean():.4f}")
        print(f"  SEEN  (leaked)   deg={(dp[seen] == yd[seen]).mean():.4f}  dur={(tp[seen] == yt[seen]).mean():.4f}")
        print(f"  the k-fold-audit number averaged BOTH -> inflated for every fold")
        print(f"  that did not contain the held-out groups")
        print()

    print("Interpretation: a shipped model can only be honestly measured on the")
    print("rows it never trained on. Retrained-from-scratch folds (the gate) are")
    print("the only apples-to-apples comparison between recipes.")


if __name__ == "__main__":
    main()
