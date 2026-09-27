"""Faithful class-weight A/B for the melodic prior (audit 2026-09-27).

The first A/B train the base dataset only -- but the real trainer merges
2000-3000 procedurally AUGMENTED samples into the train split, which is what
lifts validation from ~0.50 to ~0.70. Comparing recipes without that data is
not apples-to-apples.

This harness replicates the trainer's pipeline exactly (base + augmented merged
into train, augmentation rows whose BASE sequence is held out are dropped) and
then flips ONLY the weighting/smoothing recipe:

  A. linear inverse-frequency + smoothing 0.0   (v1 recipe)
  B. linear inverse-frequency + smoothing 0.1   (v2 recipe, the broken one)
  C. sqrt-tempered weights  + smoothing 0.1     (proposed fix)
  D. sqrt-tempered weights  + smoothing 0.0

Read-only: never writes public/models. Run:
  python scripts/audit-melodic-weights-ab.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
AUGMENTED = ROOT / "scripts" / "data" / "augmented-melodic-dataset.json"

SEED = 0x5EED
HIDDEN = [64, 32]
DEGREE_CLASSES = 8
DURATION_CLASSES = 4
EPOCHS = 800
BATCH = 64
LR = 3e-3
FOLDS = 5


def softmax(v: np.ndarray) -> np.ndarray:
    shifted = v - v.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


class MLP:
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
        self.step = 0

    def forward(self, x):
        h0 = np.maximum(0.0, x @ self.w0 + self.b0)
        h1 = np.maximum(0.0, h0 @ self.w1 + self.b1)
        return h0, h1, h1 @ self.wd + self.bd, h1 @ self.wt + self.bt

    def train_step(self, x, yd, yt, wd_w, wt_w, smoothing=0.0):
        n = len(x)
        h0, h1, dl, tl = self.forward(x)
        dp, tp = softmax(dl), softmax(tl)
        target_d = np.full_like(dp, smoothing / DEGREE_CLASSES)
        target_d[np.arange(n), yd] += 1.0 - smoothing
        target_t = np.full_like(tp, smoothing / DURATION_CLASSES)
        target_t[np.arange(n), yt] += 1.0 - smoothing
        wd_v, wt_v = wd_w[yd], wt_w[yt]
        eps = 1e-7
        loss = float(
            np.mean(wd_v * -np.sum(target_d * np.log(dp + eps), axis=1))
            + np.mean(wt_v * -np.sum(target_t * np.log(tp + eps), axis=1))
        )
        d_d = (dp - target_d) * (wd_v / n)[:, None]
        d_t = (tp - target_t) * (wt_v / n)[:, None]
        delta1 = d_d @ self.wd.T + d_t @ self.wt.T
        m1 = delta1 * (h1 > 0)
        delta0 = m1 @ self.w1.T
        m0 = delta0 * (h0 > 0)
        grads = [x.T @ m0, m0.sum(0), h0.T @ m1, m1.sum(0), h1.T @ d_d, d_d.sum(0), h1.T @ d_t, d_t.sum(0)]
        self.step += 1
        b1, b2, eps_a = 0.9, 0.999, 1e-8
        for i, p in enumerate(self.params):
            g = grads[i]
            self.m[i] = b1 * self.m[i] + (1 - b1) * g
            self.v[i] = b2 * self.v[i] + (1 - b2) * g * g
            mh = self.m[i] / (1 - b1**self.step)
            vh = self.v[i] / (1 - b2**self.step)
            p -= LR * mh / (np.sqrt(vh) + eps_a)
        return loss


def linear_weights(y, classes):
    counts = np.bincount(y, minlength=classes).astype(float)
    w = np.where(counts > 0, counts.sum() / np.maximum(1, counts), 1.0)
    return w / w.max()


def sqrt_weights(y, classes):
    counts = np.bincount(y, minlength=classes).astype(float)
    w = np.sqrt(counts.sum() / np.maximum(1, counts))
    return w / w.max()


def load_data():
    base = json.loads(DATASET.read_text())["data"]
    aug = json.loads(AUGMENTED.read_text())["data"]
    return base, aug


def train_fold(base, aug, held_groups, weighting, smoothing):
    """One fold: base-minus-validation + augmented (val siblings dropped)."""
    xb = np.array([s["x"] for s in base], dtype=np.float64)
    ybd = np.array([s["degree"] for s in base], dtype=np.int64)
    ybt = np.array([s["duration"] for s in base], dtype=np.int64)
    groups = np.array([s["group"] for s in base])
    val_mask = np.array([g in held_groups for g in groups])

    x_train, x_val = xb[~val_mask], xb[val_mask]
    yd_train, yd_val = ybd[~val_mask], ybd[val_mask]
    yt_train, yt_val = ybt[~val_mask], ybt[val_mask]

    # Augmentation joins TRAIN only; a variant of a held-out sequence is dropped
    # (exactly the trainer's leak guard).
    ax, ad, at = [], [], []
    for sample in aug:
        base_seq = "#".join(str(sample["group"]).split("#")[:3])
        if base_seq in held_groups:
            continue
        ax.append(sample["x"])
        ad.append(int(sample["degree"]))
        at.append(int(sample["duration"]))
    if ax:
        x_train = np.concatenate([x_train, np.array(ax, dtype=np.float64)])
        yd_train = np.concatenate([yd_train, np.array(ad, dtype=np.int64)])
        yt_train = np.concatenate([yt_train, np.array(at, dtype=np.int64)])

    rng = np.random.default_rng(SEED)
    model = MLP(x_train.shape[1], rng)
    wd_w = weighting(yd_train, DEGREE_CLASSES)
    wt_w = weighting(yt_train, DURATION_CLASSES)
    for _ in range(EPOCHS):
        order = rng.permutation(len(x_train))
        for s in range(0, len(order), BATCH):
            b = order[s : s + BATCH]
            model.train_step(x_train[b], yd_train[b], yt_train[b], wd_w, wt_w, smoothing)
    _, _, vd, vt = model.forward(x_val)
    return (
        float((vd.argmax(1) == yd_val).mean()),
        float((vt.argmax(1) == yt_val).mean()),
        vd.argmax(1),
        yd_val,
    )


def main() -> None:
    base, aug = load_data()
    groups = np.array([s["group"] for s in base])
    unique = np.unique(groups)
    rng = np.random.default_rng(SEED)
    rng.shuffle(unique)
    folds = [set(f.tolist()) for f in np.array_split(unique, FOLDS)]

    recipes = [
        ("A linear + no-smoothing (v1 recipe)", linear_weights, 0.0),
        ("B linear + smoothing 0.1 (v2 recipe)", linear_weights, 0.1),
        ("C sqrt   + smoothing 0.1 (proposed)", sqrt_weights, 0.1),
        ("D sqrt   + no-smoothing", sqrt_weights, 0.0),
    ]

    print("=" * 78)
    print(f"FAITHFUL CLASS-WEIGHT A/B -- {FOLDS}-fold group CV, augmentation merged")
    print("=" * 78)
    print(f"base={len(base)} rows, augmented={len(aug)} rows (train-only, val siblings dropped)")
    print()
    for label, weighting, smoothing in recipes:
        deg, dur = [], []
        for held in folds:
            d, t, _, _ = train_fold(base, aug, held, weighting, smoothing)
            deg.append(d)
            dur.append(t)
        print(f"{label}")
        print(f"  deg mean={np.mean(deg):.4f} std={np.std(deg):.4f}  folds=[{', '.join(f'{s:.3f}' for s in deg)}]")
        print(f"  dur mean={np.mean(dur):.4f} std={np.std(dur):.4f}  folds=[{', '.join(f'{s:.3f}' for s in dur)}]")
        print()
    print("Compare against the shipped artifacts (k-fold audit):")
    print("  v1 (29-dim, recipe A): deg 0.7043  dur 0.7610")
    print("  v2 (41-dim, recipe B): deg 0.7521  dur 0.4511  <- duration collapsed")


if __name__ == "__main__":
    main()
