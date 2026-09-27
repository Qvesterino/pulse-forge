"""Symbolic MELODIC prior error analysis (audit 2026-09-27).

Answers "WHERE does the melodic prior lose accuracy?" instead of the single
valDegreeAcc number the trainers print. Loads the shipped ONNX artifacts with
onnxruntime, reproduces the trainer's group split deterministically, and breaks
the error down by:

  - genre / role / degree class / duration class
  - context: sequence start vs mid-sequence, previous degree=rest
  - rhythmic position in the bar
  - contour class (big-down .. big-up)
  - calibration (does the softmax confidence mean anything?)
  - k-fold group CV (the shipped 29-row split is too small to trust)
  - v1 vs v2 head-to-head on the SAME rows (the documented comparison)

Read-only: never writes model artifacts. Prints a report and exits non-zero
only on a hard failure to load, so it can run in CI as a diagnostic.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
MODELS = ROOT / "public" / "models"

SEED = 0x5EED
VAL_FRACTION = 0.15
MELODIC_GENRES = ["house", "techno", "trap", "ambient"]
ROLES = ["bass", "chord", "lead"]
DURATION_VALUES = [1, 2, 4, 8]
DEGREE_LABELS = ["rest", "d0", "d1", "d2", "d3", "d4", "d5", "d6"]
DURATION_LABELS = ["1", "2", "4", "8"]
CONTOUR_LABELS = ["big-down", "down", "same", "up", "big-up"]


def softmax_rows(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def load_session(name: str):
    manifest = json.loads((MODELS / f"{name}.manifest.json").read_text())
    path = MODELS / Path(manifest["modelPath"]).name
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return session, manifest


def run(session, manifest, x: np.ndarray):
    """Return (degree_logits, duration_logits) for a feature matrix."""
    input_name = manifest["inputName"]
    outputs = session.run(
        [manifest["degreeOutputName"], manifest["durationOutputName"]],
        {input_name: x.astype(np.float32)},
    )
    return np.asarray(outputs[0]), np.asarray(outputs[1])


def reproduce_split(groups: np.ndarray):
    """The trainer's exact split: shuffle unique groups with SEED, take 15 %."""
    rng = np.random.default_rng(SEED)
    unique = np.unique(groups)
    rng.shuffle(unique)
    val_count = max(1, int(len(unique) * VAL_FRACTION))
    val_groups = set(unique[:val_count].tolist())
    return np.array([g in val_groups for g in groups])


def genre_semantic_vectors() -> dict[str, list[float]]:
    """The trainer's genre-averaged 16-dim vectors (styles + variants mean)."""
    path = ROOT / "scripts" / "data" / "style-embeddings.json"
    payload = json.loads(path.read_text())
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
    return vectors


def transform_for_v2(x_all: np.ndarray, groups: np.ndarray):
    """v1 → v2 rows: swap the 4-dim genre one-hot for the 16-dim semantic."""
    vectors = genre_semantic_vectors()
    rows: list[list[float]] = []
    for i, group in enumerate(groups):
        genre = str(group).split("#")[0]
        semantic = vectors.get(genre)
        if semantic is None:
            return None  # genre outside the embedding vocab
        rows.append(list(semantic) + list(x_all[i][4:]))
    return np.array(rows, dtype=np.float64)


def group_kfold(groups: np.ndarray, k: int = 5):
    """Deterministic group k-fold: every group is validation exactly once."""
    unique = np.unique(groups)
    rng = np.random.default_rng(SEED)
    rng.shuffle(unique)
    folds = np.array_split(unique, k)
    for fold in folds:
        held = set(fold.tolist())
        yield np.array([g in held for g in groups])


def acc(pred: np.ndarray, y: np.ndarray) -> float:
    return float((pred == y).mean()) if len(y) else float("nan")


def confusion(pred: np.ndarray, y: np.ndarray, n: int) -> np.ndarray:
    m = np.zeros((n, n), dtype=int)
    for p, t in zip(pred, y):
        m[int(t), int(p)] += 1
    return m


def pct(x: float) -> str:
    return "  n/a" if not np.isfinite(x) else f"{x * 100:5.1f}%"


def main() -> None:
    payload = json.loads(DATASET.read_text())
    data = payload["data"]
    x_all = np.array([s["x"] for s in data], dtype=np.float64)
    y_degree = np.array([s["degree"] for s in data], dtype=np.int64)
    y_duration = np.array([s["duration"] for s in data], dtype=np.int64)
    groups = np.array([s["group"] for s in data])

    val_mask = reproduce_split(groups)
    print("=" * 78)
    print("MELODIC PRIOR ERROR ANALYSIS")
    print("=" * 78)
    print(f"dataset      : {payload['datasetVersion']} ({payload['featureVersion']})")
    print(f"samples      : {len(data)}  groups: {len(np.unique(groups))}")
    print(f"val split    : {val_mask.sum()} rows in {len(set(groups[val_mask]))} groups "
          f"({val_mask.mean() * 100:.0f}% of rows)")

    # ── Baselines ────────────────────────────────────────────────────────────
    train_mask = ~val_mask
    deg_majority = Counter(y_degree[train_mask]).most_common(1)[0]
    dur_majority = Counter(y_duration[train_mask]).most_common(1)[0]
    print()
    print(f"baseline deg     : always '{DEGREE_LABELS[deg_majority[0]]}' -> {pct(deg_majority[1] / train_mask.sum())}")
    print(f"baseline dur     : always '{DURATION_LABELS[dur_majority[0]]}' -> {pct(dur_majority[1] / train_mask.sum())}")

    # ── Models ──────────────────────────────────────────────────────────────
    # v2 is embedding-conditioned (41 dims: 16 semantic + 25 structural). Build
    # its feature matrix from the SAME genre-averaged semantic vectors the
    # trainer uses, so the head-to-head is apples-to-apples.
    x_v2 = transform_for_v2(x_all, groups)
    results = {}
    for name in ["symbolic-melodic-v1", "symbolic-melodic-v2"]:
        session, manifest = load_session(name)
        width = int(manifest["featureCount"])
        features = x_v2 if width == 41 else x_all
        if features is None or width != features.shape[1]:
            print(f"\n{name}: feature width {width} has no matching matrix -- CANNOT be evaluated")
            results[name] = None
            continue
        logits_d, logits_t = run(session, manifest, features)
        pred_d = logits_d.argmax(axis=1)
        pred_t = logits_t.argmax(axis=1)
        results[name] = {
            "manifest": manifest,
            "pred_d": pred_d,
            "pred_t": pred_t,
            "probs_d": softmax_rows(logits_d),
            "probs_t": softmax_rows(logits_t),
            "logits_d": logits_d,
        }

    rows = [k for k, v in results.items() if v is not None]
    for name in rows:
        r = results[name]
        m = r["manifest"]
        rep = m.get("report", {})
        print()
        print("-" * 78)
        print(f"{name}  ({m['featureVersion']}, {m.get('mode', '?')}, sha {m['modelHash'][:12]}…)")
        print("-" * 78)
        print(f"  model report : valDeg={rep.get('valDegreeAcc')} valDur={rep.get('valDurationAcc')} "
              f"trainedOn={rep.get('samples')} samples")
        print(f"  ON THIS SPLIT: deg={pct(acc(r['pred_d'][val_mask], y_degree[val_mask]))} "
              f"dur={pct(acc(r['pred_t'][val_mask], y_duration[val_mask]))}")
        print(f"  train fit    : deg={pct(acc(r['pred_d'][train_mask], y_degree[train_mask]))} "
              f"dur={pct(acc(r['pred_t'][train_mask], y_duration[train_mask]))}")

    # ── v1 vs v2 head to head ───────────────────────────────────────────────
    if len(rows) == 2:
        v1, v2 = results["symbolic-melodic-v1"], results["symbolic-melodic-v2"]
        same = np.array_equal(v1["pred_d"][val_mask], v2["pred_d"][val_mask])
        print()
        print("v1 vs v2 (same rows):")
        print(f"  identical degree predictions on val rows: {same}")
        agree = float((v1["pred_d"] == v2["pred_d"]).mean())
        print(f"  agreement over ALL rows: {agree * 100:.1f}%")

    # ── Breakdown: the actual audit ─────────────────────────────────────────
    for name in rows:
        r = results[name]
        pred_d, pred_t = r["pred_d"], r["pred_t"]
        probs_d = r["probs_d"]
        print()
        print("=" * 78)
        print(f"BREAKDOWN -- {name}")
        print("=" * 78)

        # genre × role
        genres = np.array([g.split("#")[0] for g in groups])
        roles = np.array([g.split("#")[1] if len(g.split("#")) > 1 else "?" for g in groups])
        print("\nby genre (val rows):")
        for genre in MELODIC_GENRES:
            m = val_mask & (genres == genre)
            if m.sum() == 0:
                continue
            print(f"  {genre:8s} n={m.sum():3d}  deg={pct(acc(pred_d[m], y_degree[m]))}  "
                  f"dur={pct(acc(pred_t[m], y_duration[m]))}")
        print("\nby role (val rows):")
        for role in ROLES:
            m = val_mask & (roles == role)
            if m.sum() == 0:
                continue
            print(f"  {role:8s} n={m.sum():3d}  deg={pct(acc(pred_d[m], y_degree[m]))}  "
                  f"dur={pct(acc(pred_t[m], y_duration[m]))}")

        # per-class recall (val)
        print("\ndegree class recall (val rows):")
        for cls in range(8):
            m = val_mask & (y_degree == cls)
            if m.sum() == 0:
                print(f"  {DEGREE_LABELS[cls]:5s} n=  0  -- no validation examples")
                continue
            rec = acc(pred_d[m], y_degree[m])
            bar = "#" * int(round(rec * 20))
            print(f"  {DEGREE_LABELS[cls]:5s} n={m.sum():3d}  recall={pct(rec)} {bar}")
        print("\nduration class recall (val rows):")
        for cls in range(4):
            m = val_mask & (y_duration == cls)
            if m.sum() == 0:
                print(f"  {DURATION_LABELS[cls]:5s} n=  0  -- no validation examples")
                continue
            rec = acc(pred_t[m], y_duration[m])
            bar = "#" * int(round(rec * 20))
            print(f"  {DURATION_LABELS[cls]:5s} n={m.sum():3d}  recall={pct(rec)} {bar}")

        # context: sequence start (prev degree = rest)
        is_start = np.array([s["x"][9] == 1 for s in data])  # prevDegree class 0 = rest
        print("\nby context (val rows):")
        for label, m in [("seq start (prev=rest)", val_mask & is_start), ("mid-sequence", val_mask & ~is_start)]:
            if m.sum() == 0:
                continue
            print(f"  {label:22s} n={m.sum():3d}  deg={pct(acc(pred_d[m], y_degree[m]))}")

        # contour (last 5 dims are the contour one-hot)
        contour = np.array([int(np.argmax(s["x"][-5:])) for s in data])
        print("\nby contour into the note (val rows):")
        for cls, label in enumerate(CONTOUR_LABELS):
            m = val_mask & (contour == cls)
            if m.sum() == 0:
                continue
            print(f"  {label:9s} n={m.sum():3d}  deg={pct(acc(pred_d[m], y_degree[m]))}")

        # calibration: bucketed confidence vs accuracy
        conf = probs_d.max(axis=1)
        print("\ncalibration (val rows): confidence bucket -> accuracy")
        for lo, hi in [(0.0, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)]:
            m = val_mask & (conf >= lo) & (conf < hi)
            if m.sum() == 0:
                continue
            print(f"  conf {lo:.1f}–{hi:.1f}  n={m.sum():3d}  acc={pct(acc(pred_d[m], y_degree[m]))}  "
                  f"meanConf={conf[m].mean():.3f}")
        mean_conf = float(conf[val_mask].mean())
        val_acc = acc(pred_d[val_mask], y_degree[val_mask])
        print(f"  mean confidence={mean_conf:.3f} vs accuracy={val_acc:.3f} "
              f"-> {'over-confident' if mean_conf > val_acc + 0.05 else 'calibrated-ish'}")

        # confusion (top confusions)
        m_conf = confusion(pred_d[val_mask], y_degree[val_mask], 8)
        pairs = []
        for t in range(8):
            for p in range(8):
                if t != p and m_conf[t, p] > 0:
                    pairs.append((m_conf[t, p], t, p))
        pairs.sort(reverse=True)
        print("\ntop confusions (true -> predicted):")
        for count, t, p in pairs[:8]:
            print(f"  {DEGREE_LABELS[t]:5s} -> {DEGREE_LABELS[p]:5s}  ×{count}")

    print()
    print("=" * 78)
    print("K-FOLD GROUP CV (every group validated once -- the honest number)")
    print("=" * 78)
    print("The shipped split validates on a handful of groups; these folds use")
    print("all 33 groups, so the mean is what you should compare retrains against.")
    print()
    for name in rows:
        r = results[name]
        manifest = r["manifest"]
        width = int(manifest["featureCount"])
        features = x_v2 if width == 41 else x_all
        session, _ = load_session(name)
        fold_deg: list[float] = []
        fold_dur: list[float] = []
        for mask in group_kfold(groups, k=5):
            logits_d, logits_t = run(session, manifest, features[mask])
            fold_deg.append(acc(logits_d.argmax(axis=1), y_degree[mask]))
            fold_dur.append(acc(logits_t.argmax(axis=1), y_duration[mask]))
        # Pooled: concatenate all folds' predictions for one aggregate number.
        pooled_d = np.zeros(len(y_degree), dtype=np.int64)
        pooled_t = np.zeros(len(y_duration), dtype=np.int64)
        for mask in group_kfold(groups, k=5):
            logits_d, logits_t = run(session, manifest, features[mask])
            pooled_d[mask] = logits_d.argmax(axis=1)
            pooled_t[mask] = logits_t.argmax(axis=1)
        print(f"  {name}")
        print(f"    deg  folds=[{', '.join(f'{x:.3f}' for x in fold_deg)}]  "
              f"mean={np.mean(fold_deg):.4f}  std={np.std(fold_deg):.4f}  pooled={acc(pooled_d, y_degree):.4f}")
        print(f"    dur  folds=[{', '.join(f'{x:.3f}' for x in fold_dur)}]  "
              f"mean={np.mean(fold_dur):.4f}  std={np.std(fold_dur):.4f}  pooled={acc(pooled_t, y_duration):.4f}")

    # Majority baselines on the same folds, so the model's lift is visible.
    print()
    print("  majority baselines (same folds):")
    for label, y in [("deg", y_degree), ("dur", y_duration)]:
        scores = []
        for mask in group_kfold(groups, k=5):
            train = ~mask
            majority = Counter(y[train]).most_common(1)[0][0]
            scores.append(float((y[mask] == majority).mean()))
        print(f"    {label}  mean={np.mean(scores):.4f}  std={np.std(scores):.4f}")

    print()
    print("=" * 78)
    print("VERDICT")
    print("=" * 78)


if __name__ == "__main__":
    main()
