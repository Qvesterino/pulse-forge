"""Why does the SHIPPED v1 (0.8621 duration) beat every retrain on ds.v2?

Hypothesis: the shipped artifacts trained on an OLDER dataset vintage. Their
manifests record `augmentedSamples` (v1: 2249, v2: 2946) and the library grew
from ds.v1 (190 rows) to ds.v2 (239 rows) when DnB melodic references were
added. If the new rows are HARDER (dnb/breakbeat melodies), the "regression"
partly measures a harder problem.

This checks the composition of the current dataset per genre.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"
AUGMENTED = ROOT / "scripts" / "data" / "augmented-melodic-dataset.json"

DUR_LABELS = ["1", "2", "4", "8"]


def describe(label: str, rows: list[dict]) -> None:
    genres = Counter(str(r["group"]).split("#")[0] for r in rows)
    durations = Counter(int(r["duration"]) for r in rows)
    print(f"{label}: {len(rows)} rows / {len(set(r['group'] for r in rows))} groups")
    print(f"  genres    : {dict(sorted(genres.items()))}")
    print(f"  durations : {{ {', '.join(f'{DUR_LABELS[k]}={v}' for k, v in sorted(durations.items()))} }}")


def main() -> None:
    payload = json.loads(DATASET.read_text())
    base = payload["data"]
    aug = json.loads(AUGMENTED.read_text())["data"]
    dataset_version = payload.get("datasetVersion", "unknown")

    print("=" * 78)
    print("DATASET COMPOSITION (why old artifacts score higher)")
    print("=" * 78)
    describe(f"current base ({dataset_version})", base)
    describe("current augmented", aug)

    dnb_base = [r for r in base if str(r["group"]).startswith("dnb")]
    dnb_aug = [r for r in aug if str(r["group"]).startswith("dnb")]
    print()
    print(f"dnb base rows : {len(dnb_base)}  (groups: {len(set(r['group'] for r in dnb_base))})")
    print(f"dnb aug rows  : {len(dnb_aug)} ({len(set(r['group'] for r in dnb_aug))} groups)")
    print()
    print("Manifest provenance of the shipped artifacts:")
    for name in ["symbolic-melodic-v1", "symbolic-melodic-v2"]:
        manifest = json.loads((ROOT / "public" / "models" / f"{name}.manifest.json").read_text())
        report = manifest.get("report", {})
        print(f"  {name}: dataset={report.get('datasetVersion')} samples={report.get('samples')} "
              f"augmented={report.get('augmentedSamples')} featureVersion={report.get('featureVersion')}")
    print()
    print(f"=> A retrain today trains on {dataset_version} ({len(base)} rows). The shipped v1")
    print("   trained on ds.v1 (190 rows, no dnb melodic references) with an older")
    print("   augmentation pool. Comparing them is comparing two problems, so the")
    print("   gate compares RECIPES on the SAME current data instead.")


if __name__ == "__main__":
    main()
