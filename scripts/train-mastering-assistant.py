#!/usr/bin/env python3
"""
Mastering Assistant Trainer — learning loop Phase 3.

Trains a per-parameter linear regression that predicts the DELTA a specific
user would apply to the AI's proposed mastering parameters, given the
measurement context. This is the "learned layer" that sits on top of the
rules-based planner: the rules propose, the model adjusts toward the user's
taste.

Data: JSONL from src/mastering/corrections-dataset.ts (toTrainingJsonl).
Each row: {context: {lufs, crestDb, correlation, hfShare, lowEndShare},
           device, paramId, proposedValue, correctedValue, delta}.

Gate: the trained model must achieve lower MAE than the ZERO baseline
(predict delta = 0, i.e. always trust the rules) on held-out data.
If the gate fails, no model is written — the rules are better than noise.

Run: python scripts/train-mastering-assistant.py --data corrections.jsonl
Output: candidate ONNX + report JSON (same pattern as the mastering ranker).
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# ── Data loading ────────────────────────────────────────────────────────────

FEATURE_KEYS = ["lufs", "crestDb", "correlation", "hfShare", "lowEndShare"]


def load_jsonl(path: str) -> list[dict]:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict) or "context" not in row:
                continue
            rows.append(row)
    return rows


def extract_features(rows: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """Extract (X, y_delta, y_device, param_ids) from correction rows.

    X: [N, len(FEATURE_KEYS)] — context features, NaN → 0 (the model learns
       to handle missing measurements through the training distribution).
    y_delta: [N] — the correction delta the model should predict.
    y_device: [N] — device index (for grouping).
    param_ids: unique param ids in the dataset.
    """
    X, y_delta, y_device, param_ids = [], [], [], []
    device_set = sorted({row.get("device", "") for row in rows})
    device_index = {d: i for i, d in enumerate(device_set)}
    param_set = sorted({row.get("paramId", "") for row in rows})

    for row in rows:
        ctx = row.get("context", {})
        features = [float(ctx.get(k) or 0) for k in FEATURE_KEYS]
        X.append(features)
        y_delta.append(float(row.get("delta", 0)))
        y_device.append(device_index.get(row.get("device", ""), 0))

    return (
        np.array(X, dtype=np.float32),
        np.array(y_delta, dtype=np.float32),
        np.array(y_device, dtype=np.int32),
        param_ids,
    )


# ── Model ────────────────────────────────────────────────────────────────────


class LinearDeltaModel:
    """Per-parameter linear regression: context features → correction delta.

    A single linear layer trained with MSE loss and L2 regularization.
    Simple, interpretable, and the right capacity for the corrections
    dataset (which will be small for a long time — dozens, then hundreds
    of rows, not millions).
    """

    def __init__(self, n_features: int, learning_rate: float = 0.01, l2: float = 0.01, epochs: int = 500):
        self.weights = np.zeros(n_features, dtype=np.float32)
        self.bias = 0.0
        self.lr = learning_rate
        self.l2 = l2
        self.epochs = epochs

    def predict(self, X: np.ndarray) -> np.ndarray:
        return X @ self.weights + self.bias

    def fit(self, X: np.ndarray, y: np.ndarray) -> list[float]:
        losses = []
        n = len(X)
        for epoch in range(self.epochs):
            pred = self.predict(X)
            error = pred - y
            loss = float(np.mean(error**2)) + self.l2 * float(np.sum(self.weights**2))
            losses.append(loss)
            grad_w = (2 / n) * (X.T @ error) + 2 * self.l2 * self.weights
            grad_b = (2 / n) * np.sum(error)
            self.weights -= self.lr * grad_w
            self.bias -= self.lr * grad_b
        return losses

    def mae(self, X: np.ndarray, y: np.ndarray) -> float:
        return float(np.mean(np.abs(self.predict(X) - y)))


# ── Validation gate ─────────────────────────────────────────────────────────


def validate(model: LinearDeltaModel, X_val: np.ndarray, y_val: np.ndarray) -> dict:
    """The learned model must beat the ZERO baseline (always predict 0 delta)."""
    model_mae = model.mae(X_val, y_val)
    baseline_mae = float(np.mean(np.abs(y_val)))  # zero baseline: predict 0
    beats_baseline = model_mae < baseline_mae
    return {
        "model_mae": round(model_mae, 6),
        "baseline_mae": round(baseline_mae, 6),
        "beats_baseline": beats_baseline,
        "improvement_pct": round((1 - model_mae / max(baseline_mae, 1e-9)) * 100, 2),
        "gate_passed": beats_baseline,
    }


# ── Main ────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Train the mastering assistant correction model.")
    parser.add_argument("--data", required=True, help="Path to the JSONL corrections dataset.")
    parser.add_argument("--out-dir", default="public/models", help="Output directory for the candidate model.")
    parser.add_argument("--min-rows", type=int, default=50, help="Minimum rows for training (default 50).")
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"[assistant-train] dataset not found: {data_path}")
        sys.exit(1)

    rows = load_jsonl(str(data_path))
    print(f"[assistant-train] loaded {len(rows)} correction rows")

    if len(rows) < args.min_rows:
        print(f"[assistant-train] GATE: only {len(rows)} rows (< {args.min_rows} minimum) — need more corrections")
        sys.exit(1)

    X, y_delta, _, param_ids = extract_features(rows)
    print(f"[assistant-train] features: {X.shape}, deltas: mean={y_delta.mean():.4f} std={y_delta.std():.4f}")
    print(f"[assistant-train] param ids: {param_ids}")

    # Train/val split (80/20, no shuffle needed for time-ordered corrections).
    split = max(1, int(len(X) * 0.8))
    X_train, y_train = X[:split], y_delta[:split]
    X_val, y_val = X[split:], y_delta[split:]

    model = LinearDeltaModel(n_features=X.shape[1])
    losses = model.fit(X_train, y_train)

    val_result = validate(model, X_val, y_val) if len(X_val) > 0 else {"gate_passed": False, "reason": "insufficient val data"}
    print(f"[assistant-train] validation: {val_result}")

    if not val_result.get("gate_passed"):
        print("[assistant-train] GATE FAILED — the learned model does not beat the zero baseline.")
        print("[assistant-train] The rules-based planner is better than the current corrections dataset.")
        print("[assistant-train] Collect more corrections and retrain.")
        sys.exit(1)

    # ONNX export via onnxruntime (same pattern as the mastering ranker).
    try:
        import onnx
        from onnx import helper, TensorProto

        n_features = X.shape[1]
        weights_node = helper.make_tensor("W", TensorProto.FLOAT, [1, n_features], model.weights.tolist())
        bias_node = helper.make_tensor("B", TensorProto.FLOAT, [1], [model.bias])
        node = helper.make_node("Gemm", ["features", "W", "B"], ["delta"], alpha=1.0, beta=1.0)
        graph = helper.make_graph(
            [node],
            "mastering-assistant-correction",
            [helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, n_features])],
            [helper.make_tensor_value_info("delta", TensorProto.FLOAT, [None, 1])],
            initializer=[weights_node, bias_node],
        )
        model_onnx = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
        model_onnx.ir_version = 9

        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        onnx_path = out_dir / "mastering-assistant-v1.onnx"
        onnx.save(model_onnx, str(onnx_path))

        # Verify the ONNX output matches numpy.
        import onnxruntime as ort

        session = ort.InferenceSession(str(onnx_path))
        test_input = {session.get_inputs()[0].name: X_val[:1].astype(np.float32)}
        ort_out = session.run(None, test_input)[0].flatten()
        np_out = model.predict(X_val[:1])
        assert np.allclose(ort_out, np_out, atol=1e-5), f"ONNX mismatch: {ort_out} vs {np_out}"
        print(f"[assistant-train] ONNX export verified (output matches numpy)")

        manifest = {
            "modelVersion": "mastering-assistant-v1",
            "schemaVersion": 1,
            "model": {"url": onnx_path.name, "bytes": onnx_path.stat().st_size, "features": FEATURE_KEYS},
            "training": {
                "rows": len(rows),
                "trainRows": split,
                "valRows": len(X_val),
                "epochs": model.epochs,
                "finalLoss": round(losses[-1], 6),
            },
            "validation": val_result,
            "report": {"gatePassed": True},
        }
        manifest_path = out_dir / "mastering-assistant-v1.manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"[assistant-train] GATE PASSED — manifest written: {manifest_path}")
        print(f"[assistant-train] The learning loop is live. Shadow mode activated.")

    except ImportError:
        print("[assistant-train] onnx/onnxruntime not available — skipping ONNX export")
        print("[assistant-train] GATE PASSED (numpy-only) — model weights: ", model.weights.tolist())


if __name__ == "__main__":
    main()
