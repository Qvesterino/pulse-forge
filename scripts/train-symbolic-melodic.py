"""Symbolic MELODIC prior trainer (INTENT_ENGINE.md T2 v2) — offline dev tooling.

Pure numpy + onnx. Mirrors train-symbolic-prior.py conventions, but the model
is a NEXT-NOTE predictor with two heads over a shared trunk:

    input [N, 29] → Gemm+Relu → Gemm+Relu → degree [N, 8] (rest + degrees 0..6)
                                          → duration [N, 4] (1/2/4/8 steps)

Loss: class-weighted cross-entropy per head (rest and duration-2 dominate the
tiny library; without weighting the heads would collapse to majority classes).
Split by group (genre#role#sequenceIndex) — no leakage between train and val.

Run: python scripts/train-symbolic-melodic.py
"""
from __future__ import annotations

import hashlib
import json
import path_helper  # noqa: F401  (adds repo root when run from anywhere)
from pathlib import Path

import numpy as np
import onnx
from onnx import checker, helper, numpy_helper, TensorProto

ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
MODELS_DIR = ROOT / "public" / "models"

HIDDEN = [64, 32]
DEGREE_CLASSES = 8
DURATION_CLASSES = 4
EPOCHS = 800
BATCH = 64
LR = 3e-3
SEED = 0x5EED
VAL_FRACTION = 0.15
MELODIC_GENRES = ["house", "techno", "trap", "ambient"]


def softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - values.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


class TwoHeadMLP:
    """Shared ReLU trunk with two linear heads, manual Adam."""

    def __init__(self, input_size: int, rng: np.random.Generator) -> None:
        self.w0 = rng.normal(0, np.sqrt(2.0 / input_size), (input_size, HIDDEN[0]))
        self.b0 = np.zeros(HIDDEN[0])
        self.w1 = rng.normal(0, np.sqrt(2.0 / HIDDEN[0]), (HIDDEN[0], HIDDEN[1]))
        self.b1 = np.zeros(HIDDEN[1])
        self.wd = rng.normal(0, np.sqrt(2.0 / HIDDEN[1]), (HIDDEN[1], DEGREE_CLASSES))
        self.bd = np.zeros(DEGREE_CLASSES)
        self.wt = rng.normal(0, np.sqrt(2.0 / HIDDEN[1]), (HIDDEN[1], DURATION_CLASSES))
        self.bt = np.zeros(DURATION_CLASSES)
        self.params = [self.w0, self.b0, self.w1, self.b1, self.wd, self.bd, self.wt, self.bt]
        self.m = [np.zeros_like(p) for p in self.params]
        self.v = [np.zeros_like(p) for p in self.params]
        self.step_count = 0

    def forward(self, x: np.ndarray):
        h0 = np.maximum(0.0, x @ self.w0 + self.b0)
        h1 = np.maximum(0.0, h0 @ self.w1 + self.b1)
        return h0, h1, h1 @ self.wd + self.bd, h1 @ self.wt + self.bt

    def train_step(
        self,
        x: np.ndarray,
        y_degree: np.ndarray,
        y_duration: np.ndarray,
        degree_weights: np.ndarray,
        duration_weights: np.ndarray,
        lr: float,
        label_smoothing: float = 0.0,
    ) -> float:
        n = len(x)
        h0, h1, degree_logits, duration_logits = self.forward(x)
        degree_probs = softmax(degree_logits)
        duration_probs = softmax(duration_logits)

        # Label smoothing pulls the one-hot targets off 0/1 — without it
        # the softmax head drives the logit gap past 35 on this sparse
        # data and the semantic channel dies (opposite-mood prompts
        # returned IDENTICAL distributions — melodic gate finding).
        n_degree_classes = degree_probs.shape[1]
        n_duration_classes = duration_probs.shape[1]
        target_degree = np.full_like(degree_probs, label_smoothing / n_degree_classes)
        target_degree[np.arange(n), y_degree] += 1.0 - label_smoothing
        target_duration = np.full_like(duration_probs, label_smoothing / n_duration_classes)
        target_duration[np.arange(n), y_duration] += 1.0 - label_smoothing

        wd = degree_weights[y_degree]
        wt = duration_weights[y_duration]
        eps = 1e-7
        loss = float(
            np.mean(wd * -np.sum(target_degree * np.log(degree_probs + eps), axis=1))
            + np.mean(wt * -np.sum(target_duration * np.log(duration_probs + eps), axis=1))
        )

        d_degree = (degree_probs - target_degree) * (wd / n)[:, None]
        d_duration = (duration_probs - target_duration) * (wt / n)[:, None]
        d_duration *= (wt / n)[:, None]

        # backprop: heads → trunk (ReLU masks) → input
        delta1 = d_degree @ self.wd.T + d_duration @ self.wt.T  # into h1 (pre-ReLU)
        masked1 = delta1 * (h1 > 0)
        delta0 = masked1 @ self.w1.T
        masked0 = delta0 * (h0 > 0)

        grads = [
            x.T @ masked0,          # w0
            masked0.sum(axis=0),    # b0
            h0.T @ masked1,         # w1
            masked1.sum(axis=0),    # b1
            h1.T @ d_degree,        # wd
            d_degree.sum(axis=0),   # bd
            h1.T @ d_duration,      # wt
            d_duration.sum(axis=0), # bt
        ]

        self.step_count += 1
        b1, b2, eps_a = 0.9, 0.999, 1e-8
        for index, param in enumerate(self.params):
            g = grads[index]
            self.m[index] = b1 * self.m[index] + (1 - b1) * g
            self.v[index] = b2 * self.v[index] + (1 - b2) * g * g
            m_hat = self.m[index] / (1 - b1**self.step_count)
            v_hat = self.v[index] / (1 - b2**self.step_count)
            param -= lr * m_hat / (np.sqrt(v_hat) + eps_a)
        return loss


def class_weights(y: np.ndarray, class_count: int) -> np.ndarray:
    counts = np.bincount(y, minlength=class_count).astype(np.float64)
    weights = np.where(counts > 0, counts.sum() / np.maximum(1, counts), 1.0)
    return weights / weights.max()


def accuracy(logits: np.ndarray, y: np.ndarray) -> float:
    return float((logits.argmax(axis=1) == y).mean())


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Train the symbolic melodic prior")
    parser.add_argument(
        "--favorites",
        help="weighted favorite next-note samples JSON (favoritesToMelodicSamples output) "
        "— folded into the TRAIN split only",
    )
    parser.add_argument(
        "--embedding",
        help="style-embeddings.json (from generate-style-embeddings.mts) — replaces "
        "genre one-hot with a 16-dim semantic vector (v2, 41-dim input)",
    )
    parser.add_argument(
        "--augmented",
        help="augmented melodic dataset JSON (generate-augmented-data.mts output) — "
        "procedural variants merged into the TRAIN split only (weight 1.0); validation "
        "stays library-only, and variants of held-out sequences are dropped",
    )
    parser.add_argument("--favorite-oversample", type=int, default=3)
    args = parser.parse_args()

    rng = np.random.default_rng(SEED)
    payload = json.loads(DATASET_PATH.read_text())
    if payload["featureVersion"] != "melodic-features.v1":
        raise SystemExit(f"unexpected feature version: {payload['featureVersion']}")

    data = payload["data"]
    x_all = np.array([sample["x"] for sample in data], dtype=np.float64)
    y_degree = np.array([sample["degree"] for sample in data], dtype=np.int64)
    y_duration = np.array([sample["duration"] for sample in data], dtype=np.int64)
    groups = np.array([sample["group"] for sample in data])

    # --embedding mode: replace genre one-hot (x[0:4]) with 16-dim semantic
    # vector from style-embeddings.json. Input goes from 29 → 41 dims.
    genre_semantic: dict[str, list[float]] = {}
    if args.embedding:
        emb_payload = json.loads(Path(args.embedding).read_text())
        style_map = emb_payload.get("styles", {})
        variant_map = emb_payload.get("variants", {})
        # Average semantic vectors per genre (melodic model is genre-level).
        # With the v2 embeddings pack, average across ALL description
        # variants of every style in the genre — centroid-only averaging
        # collapsed the genre's semantic spread (melodic gate finding).
        genre_vectors: dict[str, list[float]] = {}
        genre_counts: dict[str, int] = {}
        for style_id, vector in style_map.items():
            genre = style_id.split(".")[0]
            for vec in [vector] + list(variant_map.get(style_id, [])):
                if genre not in genre_vectors:
                    genre_vectors[genre] = list(vec)
                    genre_counts[genre] = 1
                else:
                    for d in range(len(vec)):
                        genre_vectors[genre][d] += vec[d]
                    genre_counts[genre] += 1
        for genre, total in genre_counts.items():
            for d in range(len(genre_vectors[genre])):
                genre_vectors[genre][d] /= total
        genre_semantic = genre_vectors
        print(f"[train] embedding mode: {len(genre_vectors)} genre semantic vectors")

    # v2 artifacts are SEPARATE from v1 — the one-hot prior stays intact as the
    # runtime fallback (mirrors the drum prior v2 policy).
    embedding_mode = bool(genre_semantic)
    artifact_name = "symbolic-melodic-v2" if embedding_mode else "symbolic-melodic-v1"
    feature_version = "melodic-features-v2" if embedding_mode else "melodic-features.v1"
    prior_version = "melodic-prior.v2" if embedding_mode else "melodic-prior.v1"

    if genre_semantic:
        new_rows: list[list[float]] = []
        for i, sample in enumerate(data):
            genre = sample["group"].split("#")[0]
            semantic = genre_semantic.get(genre, [0.0] * 16)
            structural = list(x_all[i][4:])  # skip genre one-hot (4 dims)
            new_rows.append(list(semantic) + structural)
        x_all = np.array(new_rows, dtype=np.float64)
        print(f"[train] features transformed to embedding-conditioned: {x_all.shape[1]} dims")

    unique_groups = np.unique(groups)
    rng.shuffle(unique_groups)
    val_count = max(1, int(len(unique_groups) * VAL_FRACTION))
    val_groups = set(unique_groups[:val_count].tolist())
    val_mask = np.array([group in val_groups for group in groups])

    x_train, x_val = x_all[~val_mask], x_all[val_mask]
    yd_train, yd_val = y_degree[~val_mask], y_degree[val_mask]
    yt_train, yt_val = y_duration[~val_mask], y_duration[val_mask]

    # Procedural augmentation (GOAL 22): transformed library sequences join the
    # TRAIN split at weight 1.0 — they are procedurally valid, not user
    # preference. Variants whose BASE sequence (`genre#role#seq`) landed in the
    # validation split are DROPPED — training on a sibling of a held-out
    # sequence would leak the val answer into the model.
    aug_count = 0
    if args.augmented:
        aug_payload = json.loads(Path(args.augmented).read_text())
        if aug_payload.get("featureVersion") != "melodic-features.v1":
            raise SystemExit(f"unexpected augmented feature version: {aug_payload.get('featureVersion')}")
        aug_x: list[list[float]] = []
        aug_yd: list[int] = []
        aug_yt: list[int] = []
        for sample in aug_payload.get("data") or []:
            aug_group = str(sample["group"])
            if "#".join(aug_group.split("#")[:3]) in val_groups:
                continue  # variant of a held-out sequence — skip, don't leak
            row_x = sample["x"]
            if embedding_mode:
                if len(row_x) == 41:
                    pass  # already v2
                elif len(row_x) == 29:
                    semantic = genre_semantic.get(aug_group.split("#")[0])
                    if semantic is None:
                        continue  # genre outside the embedding vocab — drop
                    row_x = list(semantic) + list(row_x[4:])  # strip genre one-hot
                else:
                    raise SystemExit(
                        "augmented feature width mismatch — regenerate the augmented dataset "
                        "against the current melodic-features version"
                    )
            elif len(row_x) != x_all.shape[1]:
                raise SystemExit(
                    "augmented feature width mismatch — regenerate the augmented dataset "
                    "against the current melodic-features version"
                )
            aug_x.append(list(row_x))
            aug_yd.append(int(sample["degree"]))
            aug_yt.append(int(sample["duration"]))
        aug_count = len(aug_x)
        if aug_x:
            x_train = np.concatenate([x_train, np.array(aug_x, dtype=np.float64)])
            yd_train = np.concatenate([yd_train, np.array(aug_yd, dtype=np.int64)])
            yt_train = np.concatenate([yt_train, np.array(aug_yt, dtype=np.int64)])
            print(f"[train] augmented merged: {aug_count} procedural samples (train-only, val siblings dropped)")

    # Favorites feedback loop (C1): weighted user-kept melodic phrases join
    # the TRAIN split only — validation stays library-only so reported
    # metrics keep meaning. Oversampling = repeating samples by weight.
    if args.favorites:
        favorites_payload = json.loads(Path(args.favorites).read_text())
        favorite_samples = favorites_payload["data"] if isinstance(favorites_payload, dict) else favorites_payload
        favorite_x: list[list[float]] = []
        favorite_yd: list[int] = []
        favorite_yt: list[int] = []
        for sample in favorite_samples:
            row_x = sample["x"]
            if embedding_mode:
                if len(row_x) == 41:
                    pass  # already v2 (re-exported against melodic-features-v2)
                elif len(row_x) == 29:
                    # Decode the genre from the v1 one-hot block, then swap it
                    # for the genre's semantic vector (favorites samples carry
                    # no explicit genre field — the one-hot IS the record).
                    genre_block = list(row_x[0:4])
                    genre_index = genre_block.index(max(genre_block)) if max(genre_block) > 0 else -1
                    semantic = genre_semantic.get(MELODIC_GENRES[genre_index]) if genre_index >= 0 else None
                    if semantic is None:
                        continue  # undecodable / out-of-vocab genre — drop, don't fail
                    row_x = list(semantic) + list(row_x[4:])  # strip genre one-hot (4 dims)
                else:
                    raise SystemExit(
                        "favorites feature width mismatch — regenerate the pack against the current melodic-features version"
                    )
            elif len(row_x) != x_all.shape[1]:
                raise SystemExit(
                    "favorites feature width mismatch — regenerate the pack against the current melodic-features version"
                )
            repeat = max(1, int(round(float(sample.get("weight", 1)))) * max(1, args.favorite_oversample))
            favorite_x.extend([list(row_x)] * repeat)
            favorite_yd.extend([int(sample["degree"])] * repeat)
            favorite_yt.extend([int(sample["duration"])] * repeat)
        if favorite_x:
            x_train = np.concatenate([x_train, np.array(favorite_x, dtype=np.float64)])
            yd_train = np.concatenate([yd_train, np.array(favorite_yd, dtype=np.int64)])
            yt_train = np.concatenate([yt_train, np.array(favorite_yt, dtype=np.int64)])
            print(f"[train] favorites merged: {len(favorite_x)} weighted next-note samples")

    dw = class_weights(yd_train, DEGREE_CLASSES)
    tw = class_weights(yt_train, DURATION_CLASSES)
    print(
        f"[train] samples={len(x_all)} train={len(x_train)} val={len(x_val)} "
        f"degreeBaseline={max(np.bincount(yd_train, minlength=DEGREE_CLASSES)) / max(1, len(yd_train)):.3f} "
        f"durationBaseline={max(np.bincount(yt_train, minlength=DURATION_CLASSES)) / max(1, len(yt_train)):.3f}"
    )

    model = TwoHeadMLP(x_all.shape[1], rng)
    for epoch in range(EPOCHS):
        order = rng.permutation(len(x_train))
        epoch_loss = 0.0
        batches = 0
        for start in range(0, len(order), BATCH):
            batch = order[start : start + BATCH]
            smoothing = 0.1 if embedding_mode else 0.0
            epoch_loss += model.train_step(x_train[batch], yd_train[batch], yt_train[batch], dw, tw, LR, smoothing)
            batches += 1
        if (epoch + 1) % 100 == 0 or epoch == 0:
            _, _, vd, vt = model.forward(x_val)
            print(
                f"[train] epoch {epoch + 1}/{EPOCHS} loss={epoch_loss / max(1, batches):.4f} "
                f"valDegreeAcc={accuracy(vd, yd_val):.3f} valDurationAcc={accuracy(vt, yt_val):.3f}"
            )

    _, _, vd, vt = model.forward(x_val)
    _, _, td, tt = model.forward(x_train)
    report = {
        "datasetVersion": payload["datasetVersion"],
        "featureVersion": feature_version,
        "featureCount": int(x_all.shape[1]),
        "mode": "embedding-v2" if embedding_mode else "genre-onehot-v1",
        "augmentedSamples": aug_count,
        "hidden": HIDDEN,
        "epochs": EPOCHS,
        "samples": int(len(x_all)),
        "valDegreeAcc": round(accuracy(vd, yd_val), 4),
        "trainDegreeAcc": round(accuracy(td, yd_train), 4),
        "valDurationAcc": round(accuracy(vt, yt_val), 4),
        "trainDurationAcc": round(accuracy(tt, yt_train), 4),
    }

    # ONNX export: shared trunk, two heads. transB=1 expects [out, in] weights.
    initializers = [
        numpy_helper.from_array(model.w0.T.astype(np.float32), "W0"),
        numpy_helper.from_array(model.b0.astype(np.float32), "B0"),
        numpy_helper.from_array(model.w1.T.astype(np.float32), "W1"),
        numpy_helper.from_array(model.b1.astype(np.float32), "B1"),
        numpy_helper.from_array(model.wd.T.astype(np.float32), "WD"),
        numpy_helper.from_array(model.bd.astype(np.float32), "BD"),
        numpy_helper.from_array(model.wt.T.astype(np.float32), "WT"),
        numpy_helper.from_array(model.bt.astype(np.float32), "BT"),
    ]
    input_tensor = helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, x_all.shape[1]])
    degree_tensor = helper.make_tensor_value_info("degree", TensorProto.FLOAT, [None, DEGREE_CLASSES])
    duration_tensor = helper.make_tensor_value_info("duration", TensorProto.FLOAT, [None, DURATION_CLASSES])
    graph = helper.make_graph(
        [
            helper.make_node("Gemm", ["features", "W0", "B0"], ["h0"], alpha=1.0, beta=1.0, transB=1),
            helper.make_node("Relu", ["h0"], ["a0"]),
            helper.make_node("Gemm", ["a0", "W1", "B1"], ["h1"], alpha=1.0, beta=1.0, transB=1),
            helper.make_node("Relu", ["h1"], ["a1"]),
            helper.make_node("Gemm", ["a1", "WD", "BD"], ["degree"], alpha=1.0, beta=1.0, transB=1),
            helper.make_node("Gemm", ["a1", "WT", "BT"], ["duration"], alpha=1.0, beta=1.0, transB=1),
        ],
        artifact_name,
        [input_tensor],
        [degree_tensor, duration_tensor],
        initializer=initializers,
    )
    model_onnx = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model_onnx.ir_version = 8
    checker.check_model(model_onnx)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODELS_DIR / f"{artifact_name}.onnx"
    model_path.write_bytes(model_onnx.SerializeToString())
    model_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()

    manifest = {
        "priorVersion": prior_version,
        "featureVersion": feature_version,
        "featureCount": int(x_all.shape[1]),
        "modelPath": f"/models/{artifact_name}.onnx",
        "inputName": "features",
        "degreeOutputName": "degree",
        "durationOutputName": "duration",
        "degreeClasses": DEGREE_CLASSES,
        "durationClasses": DURATION_CLASSES,
        "modelHash": model_hash,
        "hidden": HIDDEN,
        "report": report,
    }
    if embedding_mode:
        # v2 carries its kind explicitly so the runtime guard can route it.
        manifest["kind"] = "melodic-v2"
        manifest["conditioning"] = "embedding"
    (MODELS_DIR / f"{artifact_name}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    validation_name = "symbolic-melodic-v2-validation.json" if embedding_mode else "symbolic-melodic-validation.json"
    (ROOT / "scripts" / "data" / validation_name).write_text(json.dumps(report, indent=2) + "\n")

    size_kb = model_path.stat().st_size / 1024
    print(
        f"[train] OK valDegreeAcc={report['valDegreeAcc']} valDurationAcc={report['valDurationAcc']} "
        f"size={size_kb:.1f} kB sha256={model_hash[:16]}…"
    )


if __name__ == "__main__":
    main()
