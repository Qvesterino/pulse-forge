"""Shared training primitives for the symbolic MELODIC prior.

Extracted from `train-symbolic-melodic.py` so the retrain gate
(`gate-melodic-retrain.py`) trains with the EXACT SAME code path — a gate that
re-implements the trainer could pass while the trainer is still broken.

Pure functions + one small class; no file IO, no argument parsing.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
AUGMENTED_PATH = ROOT / "scripts" / "data" / "augmented-melodic-dataset.json"

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


class MLP:
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

        # BOTH heads are weighted exactly ONCE, matching the loss above.
        # Regression guard: the original trainer multiplied the duration
        # gradient by (wt / n) a second time (audit 2026-09-27, proof in
        # scripts/audit-melodic-double-weight-proof.py), which made the head
        # optimise wt^2 and collapse onto the rarest duration class.
        d_degree = (degree_probs - target_degree) * (wd / n)[:, None]
        d_duration = (duration_probs - target_duration) * (wt / n)[:, None]

        delta1 = d_degree @ self.wd.T + d_duration @ self.wt.T
        masked1 = delta1 * (h1 > 0)
        delta0 = masked1 @ self.w1.T
        masked0 = delta0 * (h0 > 0)

        grads = [
            x.T @ masked0,
            masked0.sum(axis=0),
            h0.T @ masked1,
            masked1.sum(axis=0),
            h1.T @ d_degree,
            d_degree.sum(axis=0),
            h1.T @ d_duration,
            d_duration.sum(axis=0),
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


def class_weights(y: np.ndarray, class_count: int, power: float = 1.0) -> np.ndarray:
    """Inverse-frequency class weights with a tempering exponent.

    power = 1.0 is linear inverse frequency (the historical recipe). On the
    melodic library that gives duration-8 (12 samples) a 10.2x weight over
    duration-2 (122 samples). power = 0.5 is square-root tempering: the ratio
    drops to 3.2x, keeping the rare class visible without letting it dominate.

    Audit 2026-09-27: the shipped collapse had ONE proven cause (the doubled
    gradient weight), so tempering is chosen by measurement via
    `gate-melodic-retrain.py`, never by taste.
    """
    counts = np.bincount(y, minlength=class_count).astype(np.float64)
    raw = np.where(counts > 0, counts.sum() / np.maximum(1, counts), 1.0)
    weights = np.power(raw, power)
    return weights / weights.max()


def accuracy(logits: np.ndarray, y: np.ndarray) -> float:
    return float((logits.argmax(axis=1) == y).mean())


def load_datasets():
    base = json.loads(DATASET_PATH.read_text())["data"]
    aug = json.loads(AUGMENTED_PATH.read_text())["data"]
    return base, aug


SEMANTIC_DIMS = 16


def _mean_vectors(vectors: list[list[float]]) -> list[float]:
    return [sum(column) / len(vectors) for column in zip(*vectors)]


class SemanticLookup:
    """Style-aware 16-dim semantic conditioning for melodic next-note rows.

    The runtime conditions the v2 prior on the PCA projection of the intent
    TEXT — one vector per generation. Training conditions library rows on the
    matching semantic region:

      - genre-level group ('dnb#bass#0')            -> genre centroid
      - style-dialect group ('dnb.techstep#bass#0') -> style vector

    Both are the SAME averaging operation (centroid + all description variants)
    at different granularity, so a per-sub-genre row trains in the region its
    prompt text actually lands in, while the historical genre recipe stays
    byte-identical for every pre-existing group key.

    Regression guard (2026-09-27 depth-wave follow-up): the old code looked up
    `group.split("#")[0]` verbatim, so a dialect key ('dnb.techstep') missed
    every genre centroid and silently embedded as a ZERO vector — the retrain
    gate then failed with "embedding transform failed — genre outside the
    vocab" on the very first fold. `require()` now fails loudly instead of
    zero-filling, and `vector_for()` resolves style prefixes first.
    """

    def __init__(self, path: str | Path) -> None:
        payload = json.loads(Path(path).read_text())
        styles = payload.get("styles", {})
        variants = payload.get("variants", {})
        if not styles:
            raise SystemExit(f"semantic lookup: no styles in {path}")
        width = len(next(iter(styles.values())))
        if width != SEMANTIC_DIMS:
            raise SystemExit(f"semantic lookup: expected {SEMANTIC_DIMS} dims, pack has {width}")

        genre_buckets: dict[str, list[list[float]]] = {}
        for style_id, vector in styles.items():
            genre = style_id.split(".")[0]
            genre_buckets.setdefault(genre, []).append(list(vector))
            genre_buckets[genre].extend(list(v) for v in variants.get(style_id, []))

        self.genre_vectors = {genre: _mean_vectors(bucket) for genre, bucket in genre_buckets.items()}
        self.style_vectors = {
            style_id: _mean_vectors([list(vector)] + [list(v) for v in variants.get(style_id, [])])
            for style_id, vector in styles.items()
        }

    @staticmethod
    def prefix_for(group: str) -> str:
        return str(group).split("#")[0]

    def vector_for(self, group_or_prefix: str) -> list[float] | None:
        prefix = self.prefix_for(group_or_prefix)
        style = self.style_vectors.get(prefix)
        if style is not None:
            return style
        return self.genre_vectors.get(prefix)

    def genre_vector(self, genre: str) -> list[float] | None:
        return self.genre_vectors.get(genre)

    def require(self, group: str) -> list[float]:
        vector = self.vector_for(group)
        if vector is None:
            raise SystemExit(
                f"semantic lookup: no vector for group prefix '{self.prefix_for(group)}' — "
                f"regenerate style-embeddings.json or fix the dataset group key"
            )
        return vector
