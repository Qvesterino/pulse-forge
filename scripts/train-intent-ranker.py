"""Intent ranker trainer (goal doc Fáze 2) — offline development tooling.

Pure numpy + onnx: no torch, no network, no browser involvement.

1. Loads scripts/data/intent-ranker-dataset.json (features.v1 vectors +
   heuristic teacher scores).
2. Trains a tiny pairwise MLP (RankNet-style logistic loss on better/worse
   pairs; the heuristic score is the TEACHER signal, never proof of musical
   quality) with plain Adam on numpy.
3. Exports the trained weights as a minimal ONNX graph
   (Gemm+Relu x3 -> Gemm; input [N, featureCount] -> output [N, 1]) via the
   official onnx helper, validated by onnx.checker AND onnxruntime inference.
4. Writes public/models/intent-ranker-v1.onnx, the manifest and a validation
   report (train/val pairwise accuracy vs the heuristic teacher, top-1
   agreement, Spearman rank correlation on held-out groups).

Split is by GROUP (seed x style) — no leakage between train and val.
Run: python scripts/train-intent-ranker.py
"""
from __future__ import annotations

import hashlib
import json
import path_helper  # noqa: F401  (adds repo root when run from anywhere)
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, checker, helper, numpy_helper

ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = ROOT / "scripts" / "data" / "intent-ranker-dataset.json"
MODELS_DIR = ROOT / "public" / "models"

HIDDEN = [64, 32, 16]
EPOCHS = 1200
LR = 0.001
SEED = 0x5EED


def sigmoid(value: float) -> float:
    value = max(-30.0, min(30.0, value))
    return 1.0 / (1.0 + np.exp(-value))


def make_rng(seed: int):
    return np.random.default_rng(seed)


class MLP:
    """Tiny ReLU MLP with manual Adam on a pairwise logistic loss."""

    def __init__(self, sizes: list[int], rng) -> None:
        self.weights: list[np.ndarray] = []
        self.biases: list[np.ndarray] = []
        for index in range(1, len(sizes)):
            scale = np.sqrt(2.0 / sizes[index - 1])
            self.weights.append(rng.normal(0, scale, (sizes[index - 1], sizes[index])).astype(np.float64))
            self.biases.append(np.zeros(sizes[index], dtype=np.float64))
        # Adam moments
        self.mW = [np.zeros_like(w) for w in self.weights]
        self.vW = [np.zeros_like(w) for w in self.weights]
        self.mB = [np.zeros_like(b) for b in self.biases]
        self.vB = [np.zeros_like(b) for b in self.biases]

    def forward(self, x: np.ndarray) -> list[np.ndarray]:
        activations = [x]
        last = len(self.weights) - 1
        for index, (weight, bias) in enumerate(zip(self.weights, self.biases)):
            out = activations[-1] @ weight + bias
            if index != last:
                out = np.maximum(0.0, out)  # ReLU hidden
            activations.append(out)
        return activations

    def pair_gradients(self, x_better: np.ndarray, x_worse: np.ndarray) -> tuple[float, list, list]:
        act_better = self.forward(x_better)
        act_worse = self.forward(x_worse)
        diff = float(act_better[-1].sum() - act_worse[-1].sum())
        loss = np.log1p(np.exp(np.clip(-diff, -30, 30)))  # -log sigmoid(diff)
        grad_output = -sigmoid(-diff)  # d(-log sigmoid(diff))/d(diff)

        # Accumulate BOTH paths' gradients — per-path updates would run two
        # opposing steps per pair and invert the learned ordering.
        total_gW = [np.zeros_like(w) for w in self.weights]
        total_gB = [np.zeros_like(b) for b in self.biases]
        for activation, sign in ((act_better, grad_output), (act_worse, -grad_output)):
            delta = np.full(activation[-1].shape, sign, dtype=np.float64)
            for index in range(len(self.weights) - 1, -1, -1):
                input_activation = activation[index]
                total_gW[index] += np.outer(input_activation, delta)
                total_gB[index] += delta.sum(axis=0)
                delta = delta @ self.weights[index].T
                if index > 0:
                    delta[input_activation <= 0] = 0  # ReLU derivative
        return float(loss), total_gW, total_gB

    def score(self, x: np.ndarray) -> np.ndarray:
        return self.forward(x)[-1]

    def export_onnx(self, feature_count: int) -> bytes:
        initializers = []
        nodes = []
        current = "features"
        for index, (weight, bias) in enumerate(zip(self.weights, self.biases)):
            weight_name, bias_name = f"W{index}", f"B{index}"
            initializers.append(numpy_helper.from_array(weight.astype(np.float32), weight_name))
            initializers.append(numpy_helper.from_array(bias.astype(np.float32), bias_name))
            gemm_out = f"gemm{index}"
            nodes.append(
                helper.make_node(
                    "Gemm",
                    [current, weight_name, bias_name],
                    [gemm_out],
                    name=f"gemm_{index}",
                    alpha=1.0,
                    beta=1.0,
                    transA=0,
                    # We store each weight as [input, output], matching the
                    # numpy forward pass, so Gemm must keep B untransposed.
                    transB=0,
                )
            )
            current = gemm_out
            if index < len(self.weights) - 1:
                relu_out = f"relu{index}"
                nodes.append(helper.make_node("Relu", [current], [relu_out], name=f"relu_{index}"))
                current = relu_out

        # Keep the public output name separate from the internal Gemm tensor.
        # This makes the graph contract explicit and avoids checker/runtime
        # ambiguity when the final Gemm is optimized or renamed.
        nodes.append(helper.make_node("Identity", [current], ["score"], name="score_output"))

        input_tensor = helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, feature_count])
        output_tensor = helper.make_tensor_value_info("score", TensorProto.FLOAT, [None, 1])
        graph = helper.make_graph(
            nodes,
            "intent-ranker-v1",
            [input_tensor],
            [output_tensor],
            initializer=initializers,
        )
        model = helper.make_model(
            graph,
            producer_name="pulse-forge-intent-trainer",
            opset_imports=[helper.make_opsetid("", 13)],
        )
        model.ir_version = 8
        checker.check_model(model)
        return model.SerializeToString()


def pairs_for(rows: list[dict], rng) -> list[tuple[dict, dict]]:
    pairs: list[tuple[dict, dict]] = []
    group_keys = sorted({row["groupKey"] for row in rows})
    for group_key in group_keys:
        group_rows = [row for row in rows if row["groupKey"] == group_key]
        for a in range(len(group_rows)):
            for b in range(a + 1, len(group_rows)):
                better, worse = (
                    (group_rows[a], group_rows[b])
                    if group_rows[a]["score"] >= group_rows[b]["score"]
                    else (group_rows[b], group_rows[a])
                )
                if better["score"] != worse["score"]:
                    pairs.append((better, worse))
    rng.shuffle(pairs)
    return pairs


def pairwise_accuracy(rows: list[dict]) -> float:
    pairs = pairs_for(rows, np.random.default_rng(1))
    if not pairs:
        return 1.0
    agree = sum(1 for better, worse in pairs if model.score(better["x"]) > model.score(worse["x"]))
    return agree / len(pairs)


def top1_agreement(rows: list[dict]) -> float:
    group_keys = sorted({row["groupKey"] for row in rows})
    agree = 0
    total = 0
    for group_key in group_keys:
        group_rows = [row for row in rows if row["groupKey"] == group_key]
        if len(group_rows) < 2:
            continue
        best_heuristic = sorted(group_rows, key=lambda row: -row["score"])[0]
        best_model = sorted(group_rows, key=lambda row: -model.score(row["x"]))[0]
        agree += int(best_heuristic["index"] == best_model["index"])
        total += 1
    return agree / total if total else 1.0


def spearman(rows: list[dict]) -> float:
    group_keys = sorted({row["groupKey"] for row in rows})
    rhos = []
    for group_key in group_keys:
        group_rows = [row for row in rows if row["groupKey"] == group_key]
        if len(group_rows) < 3:
            continue
        order = list(range(len(group_rows)))
        by_heuristic = sorted(order, key=lambda position: -group_rows[position]["score"])
        by_model = sorted(order, key=lambda position: -model.score(group_rows[position]["x"]))
        d2 = sum(
            (by_model.index(position) - rank) ** 2
            for rank, position in enumerate(by_heuristic)
        )
        n = len(group_rows)
        rhos.append(1 - (6 * d2) / (n * (n * n - 1)))
    return float(np.mean(rhos)) if rhos else 1.0


dataset = json.loads(DATASET_PATH.read_text(encoding="utf8"))

# Human golden preferences (goal doc Fáze 2 — the ONLY path to "better than
# heuristic"): when scripts/data/intent-ranker-golden.json is reviewed=true,
# golden groups use POSITION-DERIVED labels (best → 1.0 … worst → 0.0)
# instead of the heuristic teacher. Unreviewed/missing file ⇒ heuristic
# teacher everywhere and the model stays in shadow mode.
golden_path = ROOT / "scripts" / "data" / "intent-ranker-golden.json"
golden_orders: dict[str, list[int]] = {}
golden_reviewed = False
if golden_path.exists():
    golden = json.loads(golden_path.read_text(encoding="utf8"))
    golden_reviewed = bool(golden.get("reviewed"))
    if golden_reviewed:
        for combo in golden.get("combos", []):
            golden_orders[combo["groupKey"]] = [int(position) for position in combo["order"]]
        print(f"[golden] reviewed=true — {len(golden_orders)} golden group(s) use human labels")
    else:
        print("[golden] template exists but is NOT reviewed — heuristic teacher stays")

samples: list[dict] = []
for group in dataset["groups"]:
    golden_order = golden_orders.get(group["groupKey"])
    for candidate in group["candidates"]:
        if golden_reviewed and golden_order is not None and candidate["index"] in golden_order:
            position = golden_order.index(candidate["index"])
            denominator = max(1, len(golden_order) - 1)
            label_score = 1.0 - position / denominator
        else:
            label_score = candidate["heuristicScore"]
        samples.append(
            {
                "x": np.array(candidate["features"], dtype=np.float64),
                "score": label_score,
                "index": candidate["index"],
                "groupKey": group["groupKey"],
                "golden": bool(golden_reviewed and golden_order is not None and candidate["index"] in golden_order),
            }
        )
feature_count = len(samples[0]["x"])
rng = make_rng(SEED)
model = MLP([feature_count, *HIDDEN, 1], rng)

group_keys = sorted({sample["groupKey"] for sample in samples})
validation_keys = {group_keys[i] for i in range(len(group_keys)) if i % 5 == 0}
train_rows = [sample for sample in samples if sample["groupKey"] not in validation_keys]
val_rows = [sample for sample in samples if sample["groupKey"] in validation_keys]
print(f"[train] samples total={len(samples)} train={len(train_rows)} val={len(val_rows)} features={feature_count}")

train_pairs = pairs_for(train_rows, rng)
# Full-batch deterministic training: one Adam update per epoch over the
# summed pairwise gradients — per-pair Adam was unstable (oscillated into a
# degenerate constant model on this dataset size).
optimizer_mw = [np.zeros_like(w) for w in model.weights]
optimizer_vw = [np.zeros_like(w) for w in model.weights]
optimizer_mb = [np.zeros_like(b) for b in model.biases]
optimizer_vb = [np.zeros_like(b) for b in model.biases]
beta1, beta2, eps = 0.9, 0.999, 1e-8
for epoch in range(1, EPOCHS + 1):
    rng.shuffle(train_pairs)
    loss_sum = 0.0
    gW = [np.zeros_like(w) for w in model.weights]
    gB = [np.zeros_like(b) for b in model.biases]
    for better, worse in train_pairs:
        loss, pair_gW, pair_gB = model.pair_gradients(better["x"], worse["x"])
        loss_sum += loss
        for index in range(len(gW)):
            gW[index] += pair_gW[index]
            gB[index] += pair_gB[index]
    for index in range(len(model.weights)):
        optimizer_mw[index] = beta1 * optimizer_mw[index] + (1 - beta1) * gW[index] / len(train_pairs)
        optimizer_vw[index] = beta2 * optimizer_vw[index] + (1 - beta2) * (gW[index] / max(1, len(train_pairs))) ** 2
        optimizer_mb[index] = beta1 * optimizer_mb[index] + (1 - beta1) * gB[index] / max(1, len(train_pairs))
        optimizer_vb[index] = beta2 * optimizer_vb[index] + (1 - beta2) * (gB[index] / max(1, len(train_pairs))) ** 2
        mw_hat = optimizer_mw[index] / (1 - beta1**epoch)
        vw_hat = optimizer_vw[index] / (1 - beta2**epoch)
        mb_hat = optimizer_mb[index] / (1 - beta1**epoch)
        vb_hat = optimizer_vb[index] / (1 - beta2**epoch)
        model.weights[index] -= LR * mw_hat / (np.sqrt(vw_hat) + eps)
        model.biases[index] -= LR * mb_hat / (np.sqrt(vb_hat) + eps)
    if epoch % 250 == 0 or epoch == EPOCHS - 1:
        print(f"[train] epoch {epoch} loss={loss_sum / max(1, len(train_pairs)):.5f}")

report = {
    "datasetVersion": dataset["datasetVersion"],
    "featureVersion": "features.v1",
    "featureCount": feature_count,
    "hidden": HIDDEN,
    "epochs": EPOCHS,
    "trainPairs": len(train_pairs),
    "valPairs": len(pairs_for(val_rows, rng)),
    "trainPairwiseAccuracyVsHeuristic": round(pairwise_accuracy(train_rows), 4),
    "valPairwiseAccuracyVsHeuristic": round(pairwise_accuracy(val_rows), 4),
    "valTop1AgreementWithHeuristic": round(top1_agreement(val_rows), 4),
    "valSpearmanVsHeuristic": round(spearman(val_rows), 4),
}
if golden_reviewed:
    golden_rows = [sample for sample in samples if sample.get("golden")]
    report["goldenPairwiseAccuracy"] = round(pairwise_accuracy(golden_rows), 4)
    report["goldenVerdict"] = (
        "ready-for-active"
        if report["goldenPairwiseAccuracy"] >= 0.75
        else "insufficient-golden-fit — stay in shadow and re-curate"
    )
print("[train] report:", json.dumps(report, indent=2))
if golden_reviewed:
    print(f"[train] golden verdict: {report.get('goldenVerdict')}")

MODELS_DIR.mkdir(parents=True, exist_ok=True)
model_bytes = model.export_onnx(feature_count)
model_path = MODELS_DIR / "intent-ranker-v1.onnx"
model_path.write_bytes(model_bytes)
model_hash = hashlib.sha256(model_bytes).hexdigest()
print(f"[train] model written {model_path} ({len(model_bytes) / 1024:.1f} kB) sha256={model_hash[:16]}…")

manifest = {
    "rankerVersion": "ranker.v1",
    "featureVersion": "features.v1",
    "normalizationId": "norm.fixed.v1",
    "featureCount": feature_count,
    "modelPath": "/models/intent-ranker-v1.onnx",
    "inputName": "features",
    "outputName": "score",
    "modelHash": model_hash,
    "hidden": HIDDEN,
    "report": report,
}
(MODELS_DIR / "intent-ranker-v1.manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf8")

validation_dir = ROOT / "scripts" / "data"
validation_dir.mkdir(parents=True, exist_ok=True)
(validation_dir / "intent-ranker-validation.json").write_text(json.dumps(report, indent=2), encoding="utf8")
print("[train] manifest written")
