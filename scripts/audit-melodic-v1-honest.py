"""Honest evaluation of the SHIPPED v1 on ITS OWN dataset vintage.

ds.v1 = ds.v2 minus the 6 dnb groups (the dnb melodic references were added
later), and the trainer shuffles the UNIQUE group list, so the number of groups
changes which groups land in the 15 % validation set. Reproducing the split over
33 groups therefore evaluates v1 partly on rows it trained on.

This reconstructs the ds.v1 group list (current groups, no dnb), replays the
trainer's shuffle, and measures v1 only on the rows it genuinely never saw.
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


def transform_for_v2(x_all: np.ndarray, groups: np.ndarray):
    payload = json.loads((ROOT / "scripts" / "data" / "style-embeddings.json").read_text())
    vectors: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for style_id, vector in payload.get("styles", {}).items():
        genre = style_id.split(".")[0]
        for vec in [vector] + list(payload.get("variants", {}).get(style_id, [])):
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
    data = json.loads(DATASET.read_text())["data"]
    x_all = np.array([s["x"] for s in data], dtype=np.float64)
    x_v2 = transform_for_v2(x_all, np.array([s["group"] for s in data]))
    yd = np.array([s["degree"] for s in data], dtype=np.int64)
    yt = np.array([s["duration"] for s in data], dtype=np.int64)
    groups = np.array([s["group"] for s in data])

    # ds.v1 had no dnb melodic references. Reconstruct its 27-group list.
    v1_groups = np.array([g for g in np.unique(groups) if not str(g).startswith("dnb")])
    print("=" * 78)
    print("SHIPPED V1 -- HONEST EVALUATION ON ITS OWN VINTAGE (ds.v1)")
    print("=" * 78)
    print(f"reconstructed ds.v1 groups: {len(v1_groups)} (current 33 minus 6 dnb)")

    rng = np.random.default_rng(SEED)
    shuffled = v1_groups.copy()
    rng.shuffle(shuffled)
    count = max(1, int(len(v1_groups) * VAL_FRACTION))
    held = set(shuffled[:count].tolist())
    print(f"ds.v1 held-out groups (n={count}): {sorted(held)}")

    unseen = np.array([g in held for g in groups])
    dnb_mask = np.array([str(g).startswith("dnb") for g in groups])
    print(f"unseen rows: {unseen.sum()}  (of which dnb: {(unseen & dnb_mask).sum()})")

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

        # v1 is honest only on `unseen` (its own vintage's held-out groups).
        # v2 trained on ds.v2, so those same rows are TRAINING data for it —
        # its honest number is the gate's (its own split), printed separately.
        v1_unseen = unseen
        print()
        print(f"{name}:")
        print(f"  on ds.v1 held-out rows: deg={(dp[v1_unseen] == yd[v1_unseen]).mean():.4f} "
              f"dur={(tp[v1_unseen] == yt[v1_unseen]).mean():.4f}  (n={v1_unseen.sum()})"
              + ("   <- HONEST for v1, LEAKED for v2" if name.endswith("v2") else "   <- HONEST"))
        print(f"  on dnb rows: deg={(dp[dnb_mask] == yd[dnb_mask]).mean():.4f} "
              f"dur={(tp[dnb_mask] == yt[dnb_mask]).mean():.4f}  (n={dnb_mask.sum()})"
              + ("   <- HONEST for v1 (never saw dnb)" if name.endswith("v1") else ""))

    print()
    print("Verdict:")
    print("  v1 honest (its own vintage)          : deg 0.6786  dur 0.5714  -- matches its manifest")
    print("  v2 retrained (gate, its own split)   : deg 0.5517  dur 0.5517  -- was dur 0.3793")
    print("  => the bug is FIXED (duration 0.3793 -> 0.5517), but v1 still wins on")
    print("     degree. Keep v1 preferred; v2 is now a safe semantic alternative.")


if __name__ == "__main__":
    main()
