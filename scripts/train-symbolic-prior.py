"""Symbolic drum-prior trainer (INTENT_ENGINE.md T2) — offline dev tooling.

Pure numpy + onnx: no torch, no network, no browser involvement. Mirrors
train-intent-ranker.py conventions.

1. Loads scripts/data/symbolic-prior-dataset.json (prior-features.v1 rows +
   binary hit labels from the groove library).
2. Trains a tiny ReLU MLP (44 -> 64 -> 32 -> 1, sigmoid) with Adam on a
   class-weighted binary cross-entropy (hits are ~8% of samples; without
   weighting the model would collapse to "never hit").
3. Exports the weights as a minimal ONNX graph (Gemm+Relu x2 -> Gemm;
   input [N, 44] -> output [N, 1] logits) via the official onnx helper and
   validates with onnx.checker.
4. Writes public/models/symbolic-prior-v1.onnx, the manifest (sha256) and a
   validation report (AUC, precision/recall/F1 at the best-F1 threshold).

Split is by groove#pattern GROUP — no leakage between train and val.
Run: python scripts/train-symbolic-prior.py
"""
from __future__ import annotations

import hashlib
import json
import path_helper  # noqa: F401  (adds repo root when run from anywhere)
from pathlib import Path

import numpy as np
import onnx
from onnx import checker, helper, TensorProto

ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = ROOT / "scripts" / "data" / "symbolic-prior-dataset.json"
MODELS_DIR = ROOT / "public" / "models"

HIDDEN = [64, 32]
EPOCHS = 500
BATCH = 8192
LR = 1.5e-3
SEED = 0x5EED
VAL_FRACTION = 0.15


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -30.0, 30.0)))


class MLP:
    """Tiny ReLU MLP with manual Adam on a weighted BCE loss."""

    def __init__(self, sizes: list[int], rng: np.random.Generator) -> None:
        self.weights: list[np.ndarray] = []
        self.biases: list[np.ndarray] = []
        for index in range(1, len(sizes)):
            scale = np.sqrt(2.0 / sizes[index - 1])
            self.weights.append(rng.normal(0, scale, (sizes[index - 1], sizes[index])).astype(np.float64))
            self.biases.append(np.zeros(sizes[index], dtype=np.float64))
        self.mW = [np.zeros_like(w) for w in self.weights]
        self.vW = [np.zeros_like(w) for w in self.weights]
        self.mB = [np.zeros_like(b) for b in self.biases]
        self.vB = [np.zeros_like(b) for b in self.biases]
        self.step_count = 0

    def forward(self, x: np.ndarray) -> list[np.ndarray]:
        activations = [x]
        last = len(self.weights) - 1
        for index, (weight, bias) in enumerate(zip(self.weights, self.biases)):
            out = activations[-1] @ weight + bias
            if index != last:
                out = np.maximum(0.0, out)
            activations.append(out)
        return activations

    def train_step(
        self,
        x: np.ndarray,
        y: np.ndarray,
        pos_weight: float,
        lr: float,
        label_smoothing: float = 0.0,
    ) -> float:
        acts = self.forward(x)
        logits = acts[-1][:, 0]
        probs = sigmoid(logits)
        eps = 1e-7
        # Label smoothing pulls targets off 0/1 — without it the sigmoid head
        # drives |logit| past 16 on the sparse grid and the exported prior
        # saturates into walls/silence (v3 gate finding). 0.1 keeps the
        # ranking sharp while capping reachable confidence.
        y = y * (1.0 - label_smoothing) + label_smoothing / 2.0
        weights = np.where(y > 0.5, pos_weight, 1.0)
        loss = float(np.mean(weights * -(y * np.log(probs + eps) + (1 - y) * np.log(1 - probs + eps))))

        # d/dlogits of weighted BCE
        diff = (probs - y) * weights
        grad = (acts[-2].T @ (diff / len(y)))[:, None]
        gradsW: list[np.ndarray] = [grad]
        gradsB: list[np.ndarray] = [np.array([diff.sum() / len(y)])]

        # backprop through hidden layers
        delta = diff[:, None] @ self.weights[-1].T  # [batch, last_hidden]
        for layer in range(len(self.weights) - 2, -1, -1):
            hidden_in = acts[layer]
            gradsW.insert(0, hidden_in.T @ delta / len(y))
            gradsB.insert(0, delta.mean(axis=0))
            if layer > 0:
                delta = (delta @ self.weights[layer].T) * (acts[layer] > 0)

        self.step_count += 1
        b1, b2, eps = 0.9, 0.999, 1e-8
        for index in range(len(self.weights)):
            for grads, params, m, v in (
                (gradsW, self.weights, self.mW, self.vW),
                (gradsB, self.biases, self.mB, self.vB),
            ):
                g = grads[index]
                m[index] = b1 * m[index] + (1 - b1) * g
                v[index] = b2 * v[index] + (1 - b2) * g * g
                m_hat = m[index] / (1 - b1**self.step_count)
                v_hat = v[index] / (1 - b2**self.step_count)
                params[index] -= lr * m_hat / (np.sqrt(v_hat) + eps)
        return loss


def auc_score(y: np.ndarray, probs: np.ndarray) -> float:
    """Rank-based AUC (Mann-Whitney U / pair count)."""
    pos = probs[y > 0.5]
    neg = probs[y <= 0.5]
    if len(pos) == 0 or len(neg) == 0:
        return 0.5
    order = np.argsort(np.concatenate([neg, pos]), kind="mergesort")
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, len(order) + 1)
    # average ranks for ties
    values = np.concatenate([neg, pos])
    sorted_values = values[order]
    unique, counts = np.unique(sorted_values, return_counts=True)
    for value, count in zip(unique, counts):
        if count > 1:
            mask = values == value
            ranks[mask] = ranks[mask].mean()
    sum_pos = ranks[len(neg):].sum()
    return float((sum_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Train the symbolic drum prior")
    parser.add_argument(
        "--favorites",
        help="weighted favorite samples JSON (symbolic-prior-favorites-samples.json "
        "from scripts/export-favorites-training.mts) — folded into the TRAIN split only",
    )
    parser.add_argument(
        "--augmented",
        help="augmented drum dataset JSON (generate-augmented-data.mts output) — "
        "procedural variants merged into the TRAIN split only (weight 1.0); validation "
        "stays library-only, and variants of held-out grooves are dropped",
    )
    parser.add_argument(
        "--embedding",
        help="style-embeddings.json (from generate-style-embeddings.mts) — replaces "
        "genre+style one-hot with a 16-dim semantic vector (v2, 35-dim input)",
    )
    parser.add_argument(
        "--hybrid",
        action="store_true",
        help="with --embedding: KEEP the genre+style one-hots on top of the "
        "semantic vector (v3, 60-dim input) — the shadow-A/B hybrid",
    )
    args = parser.parse_args()

    rng = np.random.default_rng(SEED)
    payload = json.loads(DATASET_PATH.read_text())
    if payload["featureVersion"] != "prior-features.v1":
        raise SystemExit(f"unexpected feature version: {payload['featureVersion']}")

    data = payload["data"]
    x_all_raw = np.array([sample["x"] for sample in data], dtype=np.float64)
    y_all = np.array([sample["y"] for sample in data], dtype=np.float64)
    groups = np.array([sample["groove"] for sample in data])

    # --embedding mode: replace genre(4)+style(21) one-hot with a 16-dim
    # semantic vector from style-embeddings.json. The model input becomes
    # 35 dims instead of 44. Structural features (x[25:]) are preserved.
    embedding_lookup: dict[str, list[float]] = {}
    embedding_variants: dict[str, list[list[float]]] = {}
    if args.embedding:
        emb_payload = json.loads(Path(args.embedding).read_text())
        embedding_lookup = emb_payload.get("styles", {})
        # v2 pack: per-style DESCRIPTION VARIANTS (not just the centroid) —
        # training across the style's real semantic spread flattens the
        # logit saturation the centroid-only v3 run showed (v3 gate).
        embedding_variants = emb_payload.get("variants", {})
        variant_total = sum(len(v) for v in embedding_variants.values())
        print(f"[train] embedding mode: {len(embedding_lookup)} style vectors, {variant_total} variants loaded")

    # v2 artifacts are SEPARATE from v1 — the one-hot prior stays intact as the
    # runtime fallback (roadmap Fáza D.4).
    embedding_mode = bool(embedding_lookup)
    hybrid_mode = bool(args.hybrid) and embedding_mode
    if args.hybrid and not embedding_mode:
        raise SystemExit("--hybrid requires --embedding")
    artifact_name = (
        "symbolic-prior-v3" if hybrid_mode else ("symbolic-prior-v2" if embedding_mode else "symbolic-prior-v1")
    )
    feature_version = (
        "prior-features-v3" if hybrid_mode else ("prior-features-v2" if embedding_mode else "prior-features.v1")
    )
    prior_version = "prior.v3" if hybrid_mode else ("prior.v2" if embedding_mode else "prior.v1")

    def semantic_for(style_id: str, salt: int) -> list[float]:
        # Deterministic variant pick: same sample → same variant, different
        # samples → different points across the style's semantic spread.
        base = embedding_lookup.get(style_id)
        if base is None:
            return [0.0] * 16
        variants = embedding_variants.get(style_id)
        if not variants:
            return base
        salt_sum = sum(ord(ch) for ch in style_id) + salt
        return variants[salt_sum % len(variants)]

    x_rows: list[list[float]] = []
    for i, sample in enumerate(data):
        if embedding_lookup:
            style_id = sample["groove"].split("#")[0]  # e.g. "house.driving" from "house.driving#0"
            semantic = semantic_for(style_id, i)
            if hybrid_mode:
                # v3: semantic PREPENDED, the full 44-dim v1 row (genre+style
                # one-hot + structural) stays intact — both conditioning channels.
                x_rows.append(list(semantic) + list(x_all_raw[i]))
            else:
                structural = list(x_all_raw[i][25:])  # skip genre(4) + style(21) one-hot
                x_rows.append(list(semantic) + structural)
        else:
            x_rows.append(list(x_all_raw[i]))
    x_all = np.array(x_rows, dtype=np.float64)

    input_size = x_all.shape[1]

    # Group split (groove#pattern) — whole sequences stay on one side.
    unique_groups = np.unique(groups)
    rng.shuffle(unique_groups)
    val_count = max(1, int(len(unique_groups) * VAL_FRACTION))
    val_groups = set(unique_groups[:val_count].tolist())
    val_mask = np.array([group in val_groups for group in groups])

    x_train, y_train = x_all[~val_mask], y_all[~val_mask]
    x_val, y_val = x_all[val_mask], y_all[val_mask]

    # Procedural augmentation (GOAL 22): transformed library grooves join the
    # TRAIN split at weight 1.0. Variants whose BASE groove (`styleId#pattern`)
    # landed in the validation split are DROPPED — training on a sibling of a
    # held-out groove would leak the val answer into the model.
    aug_count = 0
    if args.augmented:
        aug_payload = json.loads(Path(args.augmented).read_text())
        if aug_payload.get("featureVersion") != "prior-features.v1":
            raise SystemExit(f"unexpected augmented feature version: {aug_payload.get('featureVersion')}")
        aug_x: list[list[float]] = []
        aug_y: list[float] = []
        for sample in aug_payload.get("data") or []:
            aug_groove = str(sample["groove"])
            if "#".join(aug_groove.split("#")[:2]) in val_groups:
                continue  # variant of a held-out groove — skip, don't leak
            row_x = sample["x"]
            if embedding_mode:
                if len(row_x) == x_all.shape[1]:
                    pass  # already the current conditioning layout
                elif len(row_x) == 44:
                    style_id = aug_groove.split("#")[0]
                    semantic = embedding_lookup.get(style_id)
                    if semantic is None:
                        continue  # style outside the embedding vocab — drop
                    if hybrid_mode:
                        row_x = list(semantic) + list(row_x)  # v3: semantic + full v1 row
                    else:
                        row_x = list(semantic) + list(row_x[25:])  # v2: strip genre(4)+style(21) one-hot
                else:
                    raise SystemExit(
                        "augmented feature width mismatch — regenerate the augmented dataset "
                        "against the current prior-features version"
                    )
            elif len(row_x) != x_all.shape[1]:
                raise SystemExit(
                    "augmented feature width mismatch — regenerate the augmented dataset "
                    "against the current prior-features version"
                )
            aug_x.append(list(row_x))
            aug_y.append(float(sample["y"]))
        aug_count = len(aug_x)
        if aug_x:
            x_train = np.concatenate([x_train, np.array(aug_x, dtype=np.float64)])
            y_train = np.concatenate([y_train, np.array(aug_y, dtype=np.float64)])
            print(f"[train] augmented merged: {aug_count} procedural samples (train-only, val siblings dropped)")

    # Favorites feedback loop (T2 v2): weighted user-kept rolls join the TRAIN
    # split only — validation stays library-only so reported metrics keep
    # meaning. Oversampling = repeating the sample `weight` times.
    if args.favorites:
        favorites_payload = json.loads(Path(args.favorites).read_text())
        favorite_samples = (
            favorites_payload["data"] if isinstance(favorites_payload, dict) else favorites_payload
        )
        favorite_x: list[list[float]] = []
        favorite_y: list[float] = []
        for sample in favorite_samples:
            row_x = sample["x"]
            if embedding_mode:
                if len(row_x) == x_all.shape[1]:
                    pass  # already the current conditioning layout
                elif len(row_x) == 44:
                    style_id = str(sample.get("groove", "")).split("#")[0]
                    semantic = embedding_lookup.get(style_id)
                    if semantic is None:
                        continue  # style outside the embedding vocab — drop, don't fail
                    if hybrid_mode:
                        row_x = list(semantic) + list(row_x)  # v3: semantic + full v1 row
                    else:
                        row_x = list(semantic) + list(row_x[25:])  # v2: strip genre(4)+style(21) one-hot
                else:
                    raise SystemExit(
                        "favorites feature width mismatch — regenerate the pack against the current prior-features version"
                    )
            elif len(row_x) != x_all.shape[1]:
                raise SystemExit(
                    "favorites feature width mismatch — regenerate the pack against the current prior-features version"
                )
            repeat = max(1, int(round(float(sample.get("weight", 1)))))
            favorite_x.extend([list(row_x)] * repeat)
            favorite_y.extend([float(sample["y"])] * repeat)
        if favorite_x:
            x_train = np.concatenate([x_train, np.array(favorite_x, dtype=np.float64)])
            y_train = np.concatenate([y_train, np.array(favorite_y, dtype=np.float64)])
            print(f"[train] favorites merged: {len(favorite_x)} weighted samples from user-kept rolls")

    pos_weight = float((y_train == 0).sum() / max(1, (y_train == 1).sum()))
    print(f"[train] samples={len(x_all)} train={len(x_train)} val={len(x_val)} pos_weight={pos_weight:.2f}")

    sizes = [x_all.shape[1], *HIDDEN, 1]
    model = MLP(sizes, rng)

    for epoch in range(EPOCHS):
        order = rng.permutation(len(x_train))
        epoch_loss = 0.0
        batches = 0
        for start in range(0, len(order), BATCH):
            batch = order[start : start + BATCH]
            smoothing = 0.1 if (embedding_mode or hybrid_mode) else 0.0
            epoch_loss += model.train_step(x_train[batch], y_train[batch], pos_weight, LR, smoothing)
            batches += 1
        if (epoch + 1) % 50 == 0 or epoch == 0:
            val_probs = sigmoid(model.forward(x_val)[-1][:, 0])
            print(
                f"[train] epoch {epoch + 1}/{EPOCHS} loss={epoch_loss / batches:.4f} valAUC={auc_score(y_val, val_probs):.4f}"
            )

    # Final metrics
    val_probs = sigmoid(model.forward(x_val)[-1][:, 0])
    train_probs = sigmoid(model.forward(x_train)[-1][:, 0])
    thresholds = np.linspace(0.05, 0.95, 91)
    best_f1, best_threshold = 0.0, 0.5
    for threshold in thresholds:
        pred = val_probs >= threshold
        tp = float(((pred) & (y_val > 0.5)).sum())
        fp = float(((pred) & (y_val <= 0.5)).sum())
        fn = float((~pred & (y_val > 0.5)).sum())
        f1 = 2 * tp / max(1e-9, 2 * tp + fp + fn)
        if f1 > best_f1:
            best_f1, best_threshold = f1, float(threshold)

    def metrics_at(y: np.ndarray, probs: np.ndarray, threshold: float) -> dict[str, float]:
        pred = probs >= threshold
        tp = float((pred & (y > 0.5)).sum())
        fp = float((pred & (y <= 0.5)).sum())
        fn = float((~pred & (y > 0.5)).sum())
        precision = tp / max(1e-9, tp + fp)
        recall = tp / max(1e-9, tp + fn)
        return {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(2 * precision * recall / max(1e-9, precision + recall), 4),
        }

    report = {
        "datasetVersion": payload["datasetVersion"],
        "featureVersion": feature_version,
        "featureCount": int(x_all.shape[1]),
        "mode": "embedding-v2" if embedding_mode else "one-hot-v1",
        "augmentedSamples": aug_count,
        "hidden": HIDDEN,
        "epochs": EPOCHS,
        "samples": int(len(x_all)),
        "hitRatio": payload["hitRatio"],
        "posWeight": round(pos_weight, 3),
        "valAuc": round(auc_score(y_val, val_probs), 4),
        "trainAuc": round(auc_score(y_train, train_probs), 4),
        "bestF1Threshold": round(best_threshold, 3),
        "val": metrics_at(y_val, val_probs, best_threshold),
        "train": metrics_at(y_train, train_probs, best_threshold),
    }

    # ONNX export: Gemm+Relu x2 -> Gemm (logits); runtime applies sigmoid.
    # Our weights are stored [in, out]; Gemm transB=1 expects [out, in].
    weights_f32 = [w.T.astype(np.float32) for w in model.weights]
    biases_f32 = [b.astype(np.float32).reshape(-1) for b in model.biases]
    initializers = [
        numpy_helper_from_array(weights_f32[0], "W0"),
        numpy_helper_from_array(biases_f32[0], "B0"),
        numpy_helper_from_array(weights_f32[1], "W1"),
        numpy_helper_from_array(biases_f32[1], "B1"),
        numpy_helper_from_array(weights_f32[2], "W2"),
        numpy_helper_from_array(biases_f32[2], "B2"),
    ]
    input_tensor = helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, sizes[0]])
    output_tensor = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [None, 1])
    graph = helper.make_graph(
        [
            helper.make_node("Gemm", ["features", "W0", "B0"], ["h0"], alpha=1.0, beta=1.0, transB=1),
            helper.make_node("Relu", ["h0"], ["a0"]),
            helper.make_node("Gemm", ["a0", "W1", "B1"], ["h1"], alpha=1.0, beta=1.0, transB=1),
            helper.make_node("Relu", ["h1"], ["a1"]),
            helper.make_node("Gemm", ["a1", "W2", "B2"], ["logits"], alpha=1.0, beta=1.0, transB=1),
        ],
        artifact_name,
        [input_tensor],
        [output_tensor],
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
        "featureCount": int(sizes[0]),
        "modelPath": f"/models/{artifact_name}.onnx",
        "inputName": "features",
        "outputName": "logits",
        "modelHash": model_hash,
        "hidden": HIDDEN,
        "report": report,
    }
    if embedding_mode:
        # v2/v3 carry their kind explicitly so the runtime guard can route it.
        manifest["kind"] = "drums-v3" if hybrid_mode else "drums-v2"
        manifest["conditioning"] = "hybrid-v3" if hybrid_mode else "embedding"
    (MODELS_DIR / f"{artifact_name}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    validation_name = "symbolic-prior-v2-validation.json" if embedding_mode else "symbolic-prior-validation.json"
    (ROOT / "scripts" / "data" / validation_name).write_text(json.dumps(report, indent=2) + "\n")

    size_kb = model_path.stat().st_size / 1024
    print(
        f"[train] OK valAUC={report['valAuc']} val={report['val']} size={size_kb:.1f} kB sha256={model_hash[:16]}…"
    )


def numpy_helper_from_array(array: np.ndarray, name: str):
    from onnx import numpy_helper

    return numpy_helper.from_array(array, name)


if __name__ == "__main__":
    main()
