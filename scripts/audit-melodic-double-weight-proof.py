"""Proof of the double-weight bug on line 105 of train-symbolic-melodic.py.

Line 104 already multiplies the duration gradient by (wt / n).
Line 105 multiplies it AGAIN by (wt / n).

Effect: the duration head's effective class weight is wt^2, not wt. For the
rarest class (duration 8, weight 1.000) the squared weight is still ~1, but for
the COMMON classes the penalty becomes quadratically small:

    class 2 (122 samples): wt = 0.098  ->  wt^2 = 0.0096   (10x smaller again)
    class 4 ( 70 samples): wt = 0.171  ->  wt^2 = 0.0293
    class 1 ( 35 samples): wt = 0.343  ->  wt^2 = 0.118

So the head is pushed HARD toward the rare class and away from the frequent
ones -- exactly the signature the audit measured (55 predictions for 12 truths
of class 8; class 2 recall 32.8%).

This script proves the gradient is wrong by comparing it against a finite
difference of the loss.
"""
from __future__ import annotations

import numpy as np

DURATION_CLASSES = 4
EPS = 1e-7


def softmax(v: np.ndarray) -> np.ndarray:
    shifted = v - v.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def loss_and_grad(logits, y, weights, smoothing, double_weight: bool):
    n = len(logits)
    probs = softmax(logits)
    target = np.full_like(probs, smoothing / DURATION_CLASSES)
    target[np.arange(n), y] += 1.0 - smoothing
    w = weights[y]

    loss = float(np.mean(w * -np.sum(target * np.log(probs + EPS), axis=1)))

    # Analytic gradient exactly as the trainer computes it.
    d = (probs - target) * (w / n)[:, None]
    if double_weight:
        d = d * (w / n)[:, None]
    return loss, d


def main() -> None:
    rng = np.random.default_rng(0)
    n = 6
    logits = rng.normal(0, 0.5, (n, DURATION_CLASSES))
    y = np.array([3, 1, 1, 0, 2, 1])  # mostly the common class (1)
    weights = np.array([0.343, 0.098, 0.171, 1.0])  # the trainer's linear weights
    smoothing = 0.1

    print("=" * 74)
    print("DOUBLE-WEIGHT BUG PROOF (finite-difference gradient check)")
    print("=" * 74)
    print()
    print(f"{'class weights':>14} {'analytic grad norm':>20} {'finite-diff norm':>18} {'match':>7}")
    for label, double in [("intended (wt x1)", False), ("BUGGY (wt x2)", True)]:
        _, grad = loss_and_grad(logits, y, weights, smoothing, double)
        # Finite difference over every logit.
        fd = np.zeros_like(logits)
        h = 1e-6
        for i in range(n):
            for j in range(DURATION_CLASSES):
                up = logits.copy()
                up[i, j] += h
                down = logits.copy()
                down[i, j] -= h
                l_up, _ = loss_and_grad(up, y, weights, smoothing, double)
                l_down, _ = loss_and_grad(down, y, weights, smoothing, double)
                fd[i, j] = (l_up - l_down) / (2 * h)
        # Compare only the direction/shape; the trainer's d is already the
        # gradient of the mean loss w.r.t. logits, so norms should be close.
        match = np.allclose(grad, fd, atol=1e-4, rtol=1e-2)
        print(f"{label:>14} {np.linalg.norm(grad):>20.6f} {np.linalg.norm(fd):>18.6f} {str(match):>7}")

    print()
    print("Interpretation: the finite-difference norm is the TRUE gradient of the")
    print("printed loss. The buggy analytic gradient does not match it, so the")
    print("trainer was not descending the loss it reported.")
    print()
    print("Effect: the duration head's effective weight becomes wt^2, which mostly")
    print("scales the COMMON classes down and leaves the rare class untouched --")
    print("so the relative pull toward the rare class grows by 1/wt:")
    for cls, wt in enumerate(weights):
        print(f"  duration {['1','2','4','8'][cls]:>2}: wt={wt:.3f}  wt^2={wt * wt:.4f}  "
              f"relative pull x{1 / max(1e-9, wt):.1f}")


if __name__ == "__main__":
    main()
