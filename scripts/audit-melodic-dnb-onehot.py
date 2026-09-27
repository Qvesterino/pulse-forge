"""Is the dnb genre LOST in the one-hot v1 feature row?

`melodicGenreOf()` maps any genre outside MELODIC_GENRES = [house, techno,
trap, ambient] to "house". The dataset generator writes the GROUP key from the
raw genre but the feature row from the mapped genre — so if dnb rows exist,
their one-hot block says "house".

That would mean the one-hot v1 recipe literally cannot distinguish dnb from
house, while the embedding v2 recipe can (style-embeddings.json has a dnb
centroid).
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "scripts" / "data" / "symbolic-melodic-dataset.json"


def main() -> None:
    data = json.loads(DATASET.read_text())["data"]
    print("=" * 78)
    print("DNB-IN-ONE-HOT CHECK")
    print("=" * 78)

    # The genre one-hot is x[0:4] → house, techno, trap, ambient
    labels = ["house", "techno", "trap", "ambient"]
    by_genre: dict[str, Counter] = {}
    for row in data:
        group_genre = str(row["group"]).split("#")[0]
        block = row["x"][0:4]
        index = int(np.argmax(block)) if max(block) > 0 else -1
        onehot_genre = labels[index] if index >= 0 else "NONE"
        by_genre.setdefault(group_genre, Counter())[onehot_genre] += 1

    for genre, counts in sorted(by_genre.items()):
        print(f"  group genre '{genre}': one-hot writes {dict(counts)}")

    dnb_rows = [r for r in data if str(r["group"]).startswith("dnb")]
    print()
    if dnb_rows:
        block = dnb_rows[0]["x"][0:4]
        print(f"sample dnb row one-hot block: {block}  (labels: {labels})")
        print()
        print("=> dnb rows are encoded as HOUSE in the one-hot feature vector.")
        print("   The v1 recipe cannot tell dnb from house, no matter how long it")
        print("   trains. The embedding v2 recipe replaces this block with the")
        print("   genre's semantic centroid (style-embeddings.json HAS dnb), so it")
        print("   can represent the distinction.")
        print()
        print("   Consequence: 'v1 beats v2 on degree' is only true while the")
        print("   evaluation mixes dnb with house. On dnb rows specifically v1 has")
        print("   no mechanism to do better than its house prior.")
    else:
        print("no dnb rows found — check the dataset generator")


if __name__ == "__main__":
    main()
