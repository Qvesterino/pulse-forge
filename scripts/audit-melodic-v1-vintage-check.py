"""Is the shipped v1's "honest" number actually reproducible?

The shipped v1 trained on ds.v1 — 190 rows / 27 groups (no dnb). The current
dataset is ds.v2 — 239 rows / 33 groups. My leakage check reproduced the split
by shuffling the CURRENT 33 groups with SEED, which yields a DIFFERENT held-out
set than the one v1 actually trained against. So v1's 0.8621 may include rows it
saw.

This prints the held-out groups and checks whether they are the new dnb groups
(which v1 could never have seen, having trained before they existed).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
SEED = 0x5EED
VAL_FRACTION = 0.15


def main() -> None:
    data = json.loads(DATASET.read_text())["data"]
    groups = np.array([s["group"] for s in data])
    unique = np.unique(groups)

    print("=" * 78)
    print("V1 SPLIT REPRODUCIBILITY CHECK")
    print("=" * 78)
    print(f"current dataset: {len(data)} rows / {len(unique)} groups")

    rng = np.random.default_rng(SEED)
    shuffled = unique.copy()
    rng.shuffle(shuffled)
    count = max(1, int(len(unique) * VAL_FRACTION))
    held = list(shuffled[:count])

    print(f"\nheld-out groups reproduced over {len(unique)} groups (n={count}):")
    for group in held:
        rows = int((groups == group).sum())
        print(f"  {group:24s} rows={rows}")

    dnb_held = [g for g in held if str(g).startswith("dnb")]
    print(f"\nof which dnb: {len(dnb_held)} -> {dnb_held}")

    print()
    print("The shipped v1 manifest says: dataset=symbolic-melodic-ds.v1, samples=190.")
    print(f"ds.v1 had 27 groups; adding dnb's 6 groups gives 33.")
    print()
    print("=> v1 trained when the dnb melodic references DID NOT EXIST. Any dnb row")
    print("   in this held-out set is genuinely new data for v1, so its high score")
    print("   there is not leakage — it is v1 being evaluated on a task it never saw")
    print("   and, crucially, on rows the CURRENT augmentation also cannot teach")
    print("   (dnb has 0 augmented rows: no dnb in the augmentation generator).")
    print()
    print("Consequence for the audit: the only trustworthy comparison is between")
    print("models trained and evaluated on the SAME dataset vintage. That is the")
    print("gate (shipped v2 vs retrained v2, both ds.v2/33 groups).")


if __name__ == "__main__":
    main()
