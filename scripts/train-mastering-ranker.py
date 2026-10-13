"""Train a local, shadow-only mastering preference ranker from Development data.

This trainer is intentionally separate from the held-out evaluator. It accepts
only schema-v3 datasets declared "development", requires a fixed minimum of
real pairwise preferences, and writes candidate assets outside public/. It
never installs a model or marks an evaluation gate as passed.

Dependencies match the repository's other offline ONNX trainers: numpy, onnx,
and onnxruntime. No network, audio, or project files are read.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, checker, helper, numpy_helper

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = ROOT / "scratch" / "mastering-ranker-candidate"
DATASET_SCHEMA = "kyx.mastering-ranker-blind-set"
DATASET_VERSION = 3
FEATURE_VERSION = "mastering.features.v1"
FEATURE_COUNT = 51
NORMALIZATION_ID = "mastering-normalization.v1"
GENRE_BUCKETS = {"electronic", "hip-hop", "rock", "acoustic", "orchestral", "ambient", "other"}
MAX_DATASET_BYTES = 32 * 1024 * 1024
MAX_MODEL_BYTES = 16 * 1024 * 1024
MIN_TRAIN_PAIRS = 100
MIN_VALIDATION_PAIRS = 20
MIN_GENRES = 4
SEED = 0x4B5958
EPOCHS = 1500
PATIENCE = 100
LEARNING_RATE = 0.025
L2 = 0.01
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")
MANAGED_OUTPUTS = {
    "mastering-ranker-v1.onnx",
    "mastering-ranker-v1.manifest.candidate.json",
    "mastering-ranker-training-report.json",
}


def fail(message: str) -> None:
    raise ValueError(f"mastering ranker trainer: {message}")


def is_record(value: Any) -> bool:
    return type(value) is dict


def exact_keys(value: dict[str, Any], expected: set[str]) -> bool:
    return set(value) == expected


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None and ".." not in value


def validate_dataset(value: Any) -> tuple[list[dict[str, Any]], int, set[str]]:
    if not is_record(value) or not exact_keys(value, {"schema", "schemaVersion", "split", "pairs"}):
        fail("dataset must be a schema-v3 JSON object with no unsupported fields.")
    if (
        value["schema"] != DATASET_SCHEMA
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != DATASET_VERSION
        or value["split"] != "development"
    ):
        fail("training accepts only kyx.mastering-ranker-blind-set schema v3 declared development.")
    pairs = value["pairs"]
    if type(pairs) is not list or not 1 <= len(pairs) <= 5000:
        fail("dataset must contain between 1 and 5000 preference pairs.")

    pair_ids: set[str] = set()
    source_hashes: set[str] = set()
    reviewer_hashes: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for pair in pairs:
        if not is_record(pair) or not exact_keys(
            pair, {"pairId", "sourceMixHash", "genreBucket", "candidates", "judgments"}
        ):
            fail("pair has an unsupported field or is not an object.")
        pair_id = pair["pairId"]
        source_hash = pair["sourceMixHash"]
        genre = pair["genreBucket"]
        candidates = pair["candidates"]
        judgments = pair["judgments"]
        if (
            not valid_id(pair_id)
            or pair_id in pair_ids
            or not isinstance(source_hash, str)
            or HASH_RE.fullmatch(source_hash) is None
            or source_hash in source_hashes
            or not isinstance(genre, str)
            or genre not in GENRE_BUCKETS
            or type(candidates) is not list
            or len(candidates) != 2
            or type(judgments) is not list
            or not 2 <= len(judgments) <= 20
        ):
            fail("pair identity, source marker, genre, candidates, or judgment count is invalid.")
        pair_ids.add(pair_id)
        source_hashes.add(source_hash)

        candidate_ids: list[str] = []
        candidate_features: list[np.ndarray] = []
        for candidate in candidates:
            if not is_record(candidate) or not exact_keys(candidate, {"id", "features", "safeAfterPreview"}):
                fail(f"pair {pair_id} has an invalid candidate object.")
            candidate_id = candidate["id"]
            features = candidate["features"]
            if (
                not valid_id(candidate_id)
                or type(features) is not list
                or len(features) != FEATURE_COUNT
                or type(candidate["safeAfterPreview"]) is not bool
            ):
                fail(f"pair {pair_id} has an invalid candidate ID, feature width, or safety value.")
            for feature in features:
                if (
                    isinstance(feature, bool)
                    or not isinstance(feature, (int, float))
                    or feature < -1
                    or feature > 1
                    or not math.isfinite(feature)
                ):
                    fail(f"pair {pair_id} has a non-finite or out-of-range feature.")
            candidate_ids.append(candidate_id)
            candidate_features.append(np.asarray(features, dtype=np.float64))
        if candidate_ids[0] == candidate_ids[1]:
            fail(f"pair {pair_id} repeats a candidate ID.")

        pair_reviewers: set[str] = set()
        validated_judgments: list[tuple[str, str | None]] = []
        for judgment in judgments:
            if not is_record(judgment) or not exact_keys(judgment, {"reviewerHash", "preferredCandidateId"}):
                fail(f"pair {pair_id} has an invalid judgment object.")
            reviewer_hash = judgment["reviewerHash"]
            preference = judgment["preferredCandidateId"]
            if (
                not isinstance(reviewer_hash, str)
                or HASH_RE.fullmatch(reviewer_hash) is None
                or reviewer_hash in pair_reviewers
                or (preference is not None and preference not in candidate_ids)
            ):
                fail(f"pair {pair_id} has a duplicate reviewer code or invalid preference.")
            pair_reviewers.add(reviewer_hash)
            reviewer_hashes.add(reviewer_hash)
            validated_judgments.append((reviewer_hash, preference))

        normalized.append(
            {
                "pair_id": pair_id,
                "source_hash": source_hash,
                "genre": genre,
                "candidate_ids": candidate_ids,
                "features": candidate_features,
                "judgments": validated_judgments,
            }
        )
    return normalized, len(reviewer_hashes), source_hashes


def preferred_candidate(pair: dict[str, Any]) -> str | None:
    counts = Counter(preference if preference is not None else "__tie__" for _, preference in pair["judgments"])
    ordered = sorted(counts.items(), key=lambda entry: (-entry[1], entry[0]))
    if not ordered or (len(ordered) > 1 and ordered[0][1] == ordered[1][1]) or ordered[0][0] == "__tie__":
        return None
    return ordered[0][0]


def resolved_pairs(pairs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    resolved: list[dict[str, Any]] = []
    unresolved = 0
    identical_features = 0
    for pair in pairs:
        winner_id = preferred_candidate(pair)
        if winner_id is None:
            unresolved += 1
            continue
        winner_index = pair["candidate_ids"].index(winner_id)
        loser_index = 1 - winner_index
        winner = pair["features"][winner_index]
        loser = pair["features"][loser_index]
        delta = winner - loser
        if not np.any(delta):
            identical_features += 1
            continue
        resolved.append(
            {
                "delta": delta,
                "genre": pair["genre"],
                "source_hash": pair["source_hash"],
                "baseline_correct": winner_index == 0,
            }
        )
    return resolved, unresolved, identical_features


def split_development_pairs(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    random = np.random.default_rng(SEED)
    by_genre: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_genre.setdefault(row["genre"], []).append(row)
    train: list[dict[str, Any]] = []
    validation: list[dict[str, Any]] = []
    for genre in sorted(by_genre):
        group = sorted(by_genre[genre], key=lambda row: row["source_hash"])
        order = random.permutation(len(group))
        shuffled = [group[int(index)] for index in order]
        validation_count = max(1, int(round(len(shuffled) * 0.2))) if len(shuffled) >= 5 else 0
        validation.extend(shuffled[:validation_count])
        train.extend(shuffled[validation_count:])
    return train, validation


def logistic_loss(deltas: np.ndarray, weights: np.ndarray, l2: float = L2) -> float:
    logits = deltas @ weights
    return float(np.logaddexp(0.0, -logits).mean() + 0.5 * l2 * np.dot(weights, weights))


def pairwise_accuracy(deltas: np.ndarray, weights: np.ndarray) -> float:
    if len(deltas) == 0:
        return 0.0
    return float(np.mean((deltas @ weights) > 0.0))


def fit_pairwise_ranker(
    train_deltas: np.ndarray,
    validation_deltas: np.ndarray,
    *,
    epochs: int = EPOCHS,
    patience: int = PATIENCE,
    learning_rate: float = LEARNING_RATE,
    l2: float = L2,
) -> tuple[np.ndarray, int, float]:
    feature_count = int(train_deltas.shape[1])
    weights = np.zeros(feature_count, dtype=np.float64)
    first_moment = np.zeros_like(weights)
    second_moment = np.zeros_like(weights)
    best_weights = weights.copy()
    best_validation_loss = logistic_loss(validation_deltas, weights, l2)
    best_epoch = 0
    stale_epochs = 0
    beta1, beta2, epsilon = 0.9, 0.999, 1e-8

    for epoch in range(1, epochs + 1):
        logits = train_deltas @ weights
        gradient = -(train_deltas.T @ (1.0 / (1.0 + np.exp(np.clip(logits, -30.0, 30.0))))) / len(train_deltas)
        gradient += l2 * weights
        first_moment = beta1 * first_moment + (1.0 - beta1) * gradient
        second_moment = beta2 * second_moment + (1.0 - beta2) * np.square(gradient)
        first_hat = first_moment / (1.0 - beta1**epoch)
        second_hat = second_moment / (1.0 - beta2**epoch)
        weights -= learning_rate * first_hat / (np.sqrt(second_hat) + epsilon)

        current_validation_loss = logistic_loss(validation_deltas, weights, l2)
        if current_validation_loss < best_validation_loss - 1e-9:
            best_validation_loss = current_validation_loss
            best_weights = weights.copy()
            best_epoch = epoch
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs >= patience:
                break
    return best_weights, best_epoch, best_validation_loss


def build_onnx_model(weights: np.ndarray) -> bytes:
    onnx_weights = numpy_helper.from_array(weights.astype(np.float32).reshape((FEATURE_COUNT, 1)), "weight")
    bias = numpy_helper.from_array(np.zeros((1,), dtype=np.float32), "bias")
    graph = helper.make_graph(
        nodes=[
            helper.make_node(
                "Gemm",
                ["features", "weight", "bias"],
                ["score"],
                name="pairwise_linear_score",
                alpha=1.0,
                beta=1.0,
                transA=0,
                transB=0,
            )
        ],
        name="kyx_mastering_preference_ranker_v1",
        inputs=[helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, FEATURE_COUNT])],
        outputs=[helper.make_tensor_value_info("score", TensorProto.FLOAT, [None, 1])],
        initializer=[onnx_weights, bias],
    )
    model = helper.make_model(graph, producer_name="KYX local mastering ranker trainer", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    checker.check_model(model)
    return model.SerializeToString()


def validate_export(
    model_bytes: bytes,
    weights: np.ndarray,
    ranking_deltas: np.ndarray | None = None,
) -> dict[str, Any]:
    if not model_bytes or len(model_bytes) > MAX_MODEL_BYTES:
        fail(f"ONNX candidate is empty or exceeds {MAX_MODEL_BYTES // (1024 * 1024)} MiB.")
    session = ort.InferenceSession(model_bytes, providers=["CPUExecutionProvider"])
    if len(session.get_inputs()) != 1 or session.get_inputs()[0].name != "features":
        fail("exported ONNX input contract must be one tensor named features.")
    if len(session.get_outputs()) != 1 or session.get_outputs()[0].name != "score":
        fail("exported ONNX output contract must be one tensor named score.")
    probe = np.linspace(-1.0, 1.0, 3 * FEATURE_COUNT, dtype=np.float32).reshape((3, FEATURE_COUNT))
    scores = session.run(["score"], {"features": probe})[0]
    expected = probe.astype(np.float64) @ weights
    if scores.shape != (3, 1) or not np.isfinite(scores).all():
        fail("exported ONNX produced an invalid score shape or non-finite value.")
    if not np.allclose(scores.reshape(-1), expected, rtol=1e-5, atol=1e-5):
        fail("exported ONNX scores do not match the trained numpy ranker.")
    repeated = session.run(["score"], {"features": probe})[0]
    if not np.array_equal(scores, repeated):
        fail("exported ONNX inference is not deterministic.")
    contract = {"inputName": "features", "inputShape": [None, FEATURE_COUNT], "outputName": "score", "outputShape": [None, 1]}
    if ranking_deltas is not None:
        actual_ranking_scores = session.run(["score"], {"features": ranking_deltas.astype(np.float32)})[0].reshape(-1)
        expected_order = (ranking_deltas @ weights) > 0.0
        actual_order = actual_ranking_scores > 0.0
        if not np.array_equal(actual_order, expected_order):
            fail("exported ONNX changes a validation pair ordering from the trained numpy scorer.")
        contract["validationPairwiseAccuracy"] = round(float(np.mean(actual_order)), 4)
    return contract


def internal_self_test() -> None:
    rng = np.random.default_rng(SEED)
    train = rng.normal(0.0, 0.1, (96, FEATURE_COUNT))
    validation = rng.normal(0.0, 0.1, (24, FEATURE_COUNT))
    train[:, 0] += 0.8
    validation[:, 0] += 0.8
    weights, epoch, _ = fit_pairwise_ranker(train, validation)
    if epoch < 1 or pairwise_accuracy(validation, weights) < 0.95:
        fail("synthetic plumbing self-test could not recover its planted preference signal.")
    model_bytes = build_onnx_model(weights)
    output = validate_export(model_bytes, weights, validation)
    print(f"[mastering-ranker] self-test passed: valAccuracy={pairwise_accuracy(validation, weights):.3f} {output}")


def load_dataset(path: Path) -> tuple[list[dict[str, Any]], int, set[str], str]:
    if not path.is_file():
        fail(f"dataset file does not exist: {path}")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_DATASET_BYTES:
        fail(f"dataset must be non-empty and no larger than {MAX_DATASET_BYTES // (1024 * 1024)} MiB.")
    dataset_bytes = path.read_bytes()
    try:
        parsed = json.loads(dataset_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"dataset is not valid UTF-8 JSON: {error}")
    pairs, reviewer_count, source_hashes = validate_dataset(parsed)
    return pairs, reviewer_count, source_hashes, hashlib.sha256(dataset_bytes).hexdigest()


def train_from_dataset(dataset_path: Path, output_dir: Path, *, overwrite: bool = False) -> dict[str, Any]:
    pairs, reviewer_count, _, dataset_hash = load_dataset(dataset_path)
    genres = {pair["genre"] for pair in pairs}
    if reviewer_count < 2:
        fail("at least two distinct reviewer codes are required in Development data.")
    if len(genres) < MIN_GENRES:
        fail(f"Development data must cover at least {MIN_GENRES} genre buckets.")

    resolved, unresolved_count, identical_count = resolved_pairs(pairs)
    train_rows, validation_rows = split_development_pairs(resolved)
    if len(train_rows) < MIN_TRAIN_PAIRS or len(validation_rows) < MIN_VALIDATION_PAIRS:
        fail(
            f"need at least {MIN_TRAIN_PAIRS} resolved training pairs and {MIN_VALIDATION_PAIRS} internal validation pairs after consensus filtering; got {len(train_rows)} train, {len(validation_rows)} validation, {unresolved_count} ties/disagreements, and {identical_count} indistinguishable feature pairs."
        )
    if len({row["genre"] for row in train_rows}) < MIN_GENRES:
        fail("training split lost genre coverage; collect more balanced Development data.")

    train_deltas = np.stack([row["delta"] for row in train_rows]).astype(np.float64)
    validation_deltas = np.stack([row["delta"] for row in validation_rows]).astype(np.float64)
    weights, best_epoch, validation_loss = fit_pairwise_ranker(train_deltas, validation_deltas)
    baseline_accuracy = float(np.mean([row["baseline_correct"] for row in validation_rows]))
    model_bytes = build_onnx_model(weights)
    export_contract = validate_export(model_bytes, weights, validation_deltas)
    validation_accuracy = float(export_contract["validationPairwiseAccuracy"])
    if validation_accuracy <= baseline_accuracy:
        fail(
            f"candidate did not beat the deterministic planner on internal Development validation ({validation_accuracy:.3f} <= {baseline_accuracy:.3f}); no model was written."
        )
    model_hash = hashlib.sha256(model_bytes).hexdigest()
    manifest = {
        "rankerVersion": "mastering-ranker-v1",
        "featureVersion": FEATURE_VERSION,
        "normalizationId": NORMALIZATION_ID,
        "featureCount": FEATURE_COUNT,
        "modelPath": "/models/mastering-ranker-v1.onnx",
        "inputName": "features",
        "outputName": "score",
        "modelHash": model_hash,
        "evaluation": None,
    }
    report = {
        "schema": "kyx.mastering-ranker-training-report",
        "schemaVersion": 1,
        "status": "candidate-only-shadow",
        "datasetSplit": "development",
        "datasetHash": dataset_hash,
        "featureVersion": FEATURE_VERSION,
        "featureCount": FEATURE_COUNT,
        "reviewerCodeCount": reviewer_count,
        "genreBucketCount": len(genres),
        "inputPairCount": len(pairs),
        "resolvedPairCount": len(resolved),
        "unresolvedTieOrDisagreementCount": unresolved_count,
        "identicalFeaturePairCount": identical_count,
        "trainingPairCount": len(train_rows),
        "internalDevelopmentValidationPairCount": len(validation_rows),
        "internalDevelopmentValidationIsHeldOut": False,
        "seed": SEED,
        "splitRule": "sourceMixHash ordered, per-genre seeded 80/20 split; session hashes require external source ledger",
        "architecture": "linear scalar ranker; pairwise logistic loss with L2 regularization",
        "epochsRun": best_epoch,
        "validationLoss": round(validation_loss, 8),
        "internalValidationPreferenceRate": round(validation_accuracy, 4),
        "deterministicPlannerPreferenceRate": round(baseline_accuracy, 4),
        "internalValidationLift": round(validation_accuracy - baseline_accuracy, 4),
        "modelHash": model_hash,
        "modelBytes": len(model_bytes),
        "onnxContract": export_contract,
        "evaluationGate": None,
        "activation": "not-installed; held-out evaluation and product review still required",
    }

    output_dir = output_dir.resolve()
    public_dir = (ROOT / "public").resolve()
    try:
        output_dir.relative_to(public_dir)
    except ValueError:
        pass
    else:
        fail("candidate output must be outside public/; the trainer never installs application assets.")
    if output_dir == ROOT.resolve():
        fail("candidate output directory cannot be the repository root.")

    output_dir.mkdir(parents=True, exist_ok=True)
    existing = {path.name for path in output_dir.iterdir()}
    unexpected = existing - MANAGED_OUTPUTS
    if unexpected:
        fail(f"output directory contains unrelated files: {', '.join(sorted(unexpected))}.")
    if existing and not overwrite:
        fail("candidate output files already exist; choose another --out-dir or pass --overwrite to replace these three files.")

    artifacts = {
        "mastering-ranker-v1.onnx": model_bytes,
        "mastering-ranker-v1.manifest.candidate.json": (json.dumps(manifest, indent=2) + "\n").encode("utf-8"),
        "mastering-ranker-training-report.json": (json.dumps(report, indent=2) + "\n").encode("utf-8"),
    }
    for name, content in artifacts.items():
        temporary_path = output_dir / f".{name}.tmp"
        temporary_path.write_bytes(content)
        temporary_path.replace(output_dir / name)
    print(
        f"[mastering-ranker] candidate written to {output_dir}; train={len(train_rows)} val={len(validation_rows)} "
        f"lift={report['internalValidationLift']:.4f} modelSha256={model_hash}"
    )
    print("[mastering-ranker] evaluation=null; no model was installed or activated")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, help="locally exported Development JSON dataset")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="candidate output directory outside public/")
    parser.add_argument("--overwrite", action="store_true", help="replace only the three known candidate files in --out-dir")
    parser.add_argument("--self-test", action="store_true", help="run a deterministic synthetic trainer/ONNX plumbing check")
    args = parser.parse_args()
    if args.self_test:
        if args.dataset is not None:
            parser.error("--self-test cannot be combined with --dataset")
        internal_self_test()
        return 0
    if args.dataset is None:
        parser.error("--dataset is required unless --self-test is used")
    try:
        train_from_dataset(args.dataset.resolve(), args.out_dir, overwrite=args.overwrite)
    except Exception as error:  # Present a concise error for ONNX Runtime/checker failures at this CLI boundary.
        print(f"[mastering-ranker] ERROR: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
