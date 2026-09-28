"""K-FOLD GATE for the melodic retrain (audit 2026-09-27, fix 4a+4b).

The shipped validator only checks "does the model load and run" — it cannot
tell a fixed duration head from a collapsed one. This gate trains a fresh model
per fold with the CURRENT trainer code and reports honest 5-fold group CV
numbers, so a retrain is accepted only when it BEATS the baseline.

Pre-registered gate (written before the fix was measured):
  - duration pooled k-fold >= majority baseline (0.4997)   [was 0.4511 — the bug]
  - degree   pooled k-fold >= shipped v2 (0.7521)          [no regression]
  - both heads use all classes (no collapse onto one class)

Read-only: never writes public/models. Run:
  python scripts/gate-melodic-retrain.py [--weight-power 0.5] [--folds 5]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from train_symbolic_melodic_lib import (  # noqa: E402
    BATCH,
    DATASET_PATH,
    DEGREE_CLASSES,
    DURATION_CLASSES,
    EPOCHS,
    LR,
    MLP,
    SEED,
    VAL_FRACTION,
    SemanticLookup,
    class_weights,
    load_datasets,
    softmax,
)

BASELINE = {
    # HONEST baselines: measured on rows the model NEVER trained on.
    # WARNING — the first audit pass reported v2 degree 0.7521. That number was
    # LEAKED: it evaluated the SHIPPED artifact on all 5 folds, but the shipped
    # model had trained on the evaluation rows of every fold that did not
    # contain its own held-out groups (scripts/audit-melodic-leakage-check.py
    # measures the gap: v2 deg 0.7952 seen vs 0.4828 unseen).
    "shippedV2Degree": 0.4828,
    "shippedV2Duration": 0.3793,
    "shippedV1Degree": 0.6897,
    "shippedV1Duration": 0.8621,
    "shippedSplitRows": 29,
    "majorityDuration": 0.4997,
}

GATE = {
    # Duration must clear the majority baseline — the shipped v2 collapsed below
    # it (0.3793 honest). Degree must not regress against the honest v2 number.
    "durationMin": BASELINE["majorityDuration"],
    "degreeMin": BASELINE["shippedV2Degree"],
    "degreeMinV1": BASELINE["shippedV1Degree"],
}


def genre_semantic_vectors() -> SemanticLookup:
    """The trainer's style-aware lookup (style vectors + genre centroids)."""
    return SemanticLookup(ROOT / "scripts" / "data" / "style-embeddings.json")


def to_v2_rows(x_v1: np.ndarray, groups: np.ndarray) -> np.ndarray | None:
    """Swap the 4-dim genre one-hot for the 16-dim semantic vector."""
    vectors = genre_semantic_vectors()
    rows: list[list[float]] = []
    for i, group in enumerate(groups):
        semantic = vectors.vector_for(str(group))
        if semantic is None:
            return None
        rows.append(list(semantic) + list(x_v1[i][4:]))
    return np.array(rows, dtype=np.float64)


def train_fold(base, aug, held_groups, weight_power: float, smoothing: float, embedding: bool):
    xb = np.array([s["x"] for s in base], dtype=np.float64)
    ybd = np.array([s["degree"] for s in base], dtype=np.int64)
    ybt = np.array([s["duration"] for s in base], dtype=np.int64)
    groups = np.array([s["group"] for s in base])
    val_mask = np.array([g in held_groups for g in groups])

    x_train = xb[~val_mask]
    x_val = xb[val_mask]
    yd_train, yd_val = ybd[~val_mask], ybd[val_mask]
    yt_train, yt_val = ybt[~val_mask], ybt[val_mask]

    vectors = genre_semantic_vectors() if embedding else None
    if embedding:

        def transform(rows_x, rows_groups):
            out = []
            for i, group in enumerate(rows_groups):
                semantic = vectors.vector_for(str(group))  # type: ignore[union-attr]
                if semantic is None:
                    return None
                out.append(list(semantic) + list(rows_x[i][4:]))
            return np.array(out, dtype=np.float64)

        x_train = transform(x_train, groups[~val_mask])
        x_val = transform(x_val, groups[val_mask])
        if x_train is None or x_val is None:
            raise SystemExit("embedding transform failed — genre outside the vocab")

    ax, ad, at, ag = [], [], [], []
    for sample in aug:
        base_seq = "#".join(str(sample["group"]).split("#")[:3])
        if base_seq in held_groups:
            continue
        row = sample["x"]
        if embedding:
            if len(row) == 41:
                pass
            else:
                semantic = vectors.vector_for(str(sample["group"]))  # type: ignore[union-attr]
                if semantic is None:
                    continue
                row = list(semantic) + list(row[4:])
        ax.append(row)
        ad.append(int(sample["degree"]))
        at.append(int(sample["duration"]))
        ag.append(str(sample["group"]))
    if ax:
        x_train = np.concatenate([x_train, np.array(ax, dtype=np.float64)])
        yd_train = np.concatenate([yd_train, np.array(ad, dtype=np.int64)])
        yt_train = np.concatenate([yt_train, np.array(at, dtype=np.int64)])

    rng = np.random.default_rng(SEED)
    model = MLP(x_train.shape[1], rng)
    dw = class_weights(yd_train, DEGREE_CLASSES, weight_power)
    tw = class_weights(yt_train, DURATION_CLASSES, weight_power)
    for _ in range(EPOCHS):
        order = rng.permutation(len(x_train))
        for start in range(0, len(order), BATCH):
            batch = order[start : start + BATCH]
            model.train_step(x_train[batch], yd_train[batch], yt_train[batch], dw, tw, LR, smoothing)

    _, _, vd, vt = model.forward(x_val)
    _, _, td, tt = model.forward(x_train)
    # Collapse is measured on the TRAINING predictions, not the validation set:
    # a 28-row fold may simply not contain the rare duration class, so "the head
    # only predicted 3 of 4 classes here" is not evidence of collapse. On the
    # full training distribution it is.
    return (
        vd.argmax(1),
        yd_val,
        vt.argmax(1),
        yt_val,
        td.argmax(1),
        tt.argmax(1),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weight-power", type=float, default=0.5)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--embedding", action="store_true", help="v2 recipe (41-dim semantic conditioning)")
    parser.add_argument(
        "--shipped-split",
        action="store_true",
        help="use the trainer's EXACT 15%% split instead of k-fold, so the result "
        "is directly comparable with the shipped artifact's honest numbers",
    )
    parser.add_argument(
        "--exclude-dnb",
        action="store_true",
        help="drop dnb rows from base AND augmentation — reproduces the ds.v1 "
        "problem space, which is the only fair comparison for the shipped v1",
    )
    args = parser.parse_args()

    base, aug = load_datasets()
    if args.exclude_dnb:
        base = [s for s in base if not str(s["group"]).startswith("dnb")]
        aug = [s for s in aug if not str(s["group"]).startswith("dnb")]
    groups = np.array([s["group"] for s in base])
    unique = np.unique(groups)
    rng = np.random.default_rng(SEED)
    rng.shuffle(unique)
    if args.shipped_split:
        val_count = max(1, int(len(unique) * VAL_FRACTION))
        folds = [set(unique[:val_count].tolist())]
    else:
        folds = [set(f.tolist()) for f in np.array_split(unique, args.folds)]

    dataset_version = json.loads(DATASET_PATH.read_text()).get("datasetVersion", "unknown")
    recipe = "embedding-v2" if args.embedding else "genre-onehot-v1"
    mode = "shipped 15% split" if args.shipped_split else f"{args.folds}-fold group CV"
    vintage = f"{dataset_version} -- no dnb" if args.exclude_dnb else f"{dataset_version} (current)"
    print("=" * 78)
    print(f"MELODIC RETRAIN GATE -- {mode}, {recipe}, {vintage}, weightPower={args.weight_power}")
    print("=" * 78)
    print(f"base={len(base)} rows / {len(unique)} groups, augmented={len(aug)} rows (train-only)")
    print()

    all_vd, all_yd, all_vt, all_yt, all_td, all_tt = [], [], [], [], [], []
    for index, held in enumerate(folds):
        vd, yd, vt, yt, td, tt = train_fold(base, aug, held, args.weight_power, 0.1, args.embedding)
        all_vd.append(vd)
        all_yd.append(yd)
        all_vt.append(vt)
        all_yt.append(yt)
        all_td.append(td)
        all_tt.append(tt)
        print(f"  fold {index + 1}: deg={(vd == yd).mean():.4f}  dur={(vt == yt).mean():.4f}  (n={len(yd)})")

    vd = np.concatenate(all_vd)
    yd = np.concatenate(all_yd)
    vt = np.concatenate(all_vt)
    yt = np.concatenate(all_yt)
    td = np.concatenate(all_td)
    tt = np.concatenate(all_tt)

    deg_acc = float((vd == yd).mean())
    dur_acc = float((vt == yt).mean())
    deg_classes = len(set(td.tolist()))
    dur_classes = len(set(tt.tolist()))

    print()
    print(f"pooled: degree={deg_acc:.4f}  duration={dur_acc:.4f}")
    print(f"classes used (train): degree={deg_classes}/{DEGREE_CLASSES}  duration={dur_classes}/{DURATION_CLASSES}")
    print()
    print("baselines (shipped artifacts, same CV):")
    print(f"  v1 degree {BASELINE['shippedV1Degree']:.4f}  v1 duration {BASELINE['shippedV1Duration']:.4f}")
    print(f"  v2 degree {BASELINE['shippedV2Degree']:.4f}  v2 duration {BASELINE['shippedV2Duration']:.4f} (collapsed)")
    print(f"  majority duration {BASELINE['majorityDuration']:.4f}")
    print()

    failures = []
    if dur_acc < GATE["durationMin"]:
        failures.append(f"duration {dur_acc:.4f} < gate {GATE['durationMin']:.4f} (majority baseline)")
    if deg_acc < GATE["degreeMin"]:
        failures.append(f"degree {deg_acc:.4f} < gate {GATE['degreeMin']:.4f} (shipped v2)")
    if dur_classes < DURATION_CLASSES:
        failures.append(
            f"duration head collapses: predicts only {dur_classes}/{DURATION_CLASSES} classes on its own TRAINING data"
        )
    if deg_classes < 2:
        failures.append(f"degree head collapses: predicts only {deg_classes}/{DEGREE_CLASSES} classes")

    print("-" * 78)
    if failures:
        print("GATE FAIL")
        for failure in failures:
            print(f"  x {failure}")
        sys.exit(1)
    print("GATE PASS")
    print(f"  duration {dur_acc:.4f} >= {GATE['durationMin']:.4f}   (+{dur_acc - BASELINE['shippedV2Duration']:.4f} vs shipped v2)")
    print(f"  degree   {deg_acc:.4f} >= {GATE['degreeMin']:.4f}   (+{deg_acc - BASELINE['shippedV2Degree']:.4f} vs shipped v2)")
    print(f"  no collapse: both heads span their full class range on training data")


if __name__ == "__main__":
    main()
