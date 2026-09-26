"""DnB retrain gate analysis (TEMPORARY, deleted after the verdict).

Compares backup (pre-dnb) vs retrained (dnb) v2/v3 drum priors on the NEW
validation split: overall AUC each + per-group AUC, so dilution by hard new
dnb groups is distinguishable from regression on old groups.
"""

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
BACKUP = Path(r"C:\Users\danie\AppData\Local\Temp\opencode\prior-backup")

SEED = 0x5EED
VAL_FRACTION = 0.15


def auc_score(y_true, y_prob):
    y_true = np.asarray(y_true, dtype=np.float64)
    y_prob = np.asarray(y_prob, dtype=np.float64)
    order = np.argsort(y_prob, kind="stable")
    y_sorted = y_true[order]
    pos = int(y_sorted.sum())
    neg = len(y_sorted) - pos
    if pos == 0 or neg == 0:
        return float("nan")
    rank_sum = np.sum(np.flatnonzero(y_sorted) + 1)
    return float((rank_sum - pos * (pos + 1) / 2) / (pos * neg))


def run(model_path, rows):
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    out = []
    batch = np.array(rows, dtype=np.float32)
    logits = session.run(None, {name: batch})[0]
    return 1.0 / (1.0 + np.exp(-np.asarray(logits).reshape(-1)))


dataset = json.loads((ROOT / "scripts" / "data" / "symbolic-prior-dataset.json").read_text())
pack = json.loads((ROOT / "scripts" / "data" / "style-embeddings.json").read_text())
styles = pack["styles"]

data = dataset["data"]
groups = np.array([s["groove"] for s in data])
unique_groups = np.unique(groups)
rng = np.random.default_rng(SEED)
rng.shuffle(unique_groups)
val_count = max(1, int(len(unique_groups) * VAL_FRACTION))
val_groups = set(unique_groups[:val_count].tolist())
print(f"[gate] val groups ({len(val_groups)}): {sorted(val_groups)}")

val_idx = [i for i, s in enumerate(data) if s["groove"] in val_groups]
print(f"[gate] val rows: {len(val_idx)}")

# v3 rows: semantic centroid + full 44-dim row
v3_rows, v3_y, v3_groups = [], [], []
for i in val_idx:
    s = data[i]
    style_id = s["groove"].split("#")[0]
    vec = styles.get(style_id)
    if vec is None:
        continue
    v3_rows.append(list(vec) + list(s["x"]))
    v3_y.append(s["y"])
    v3_groups.append(s["groove"].split("#")[0])
v3_rows = np.array(v3_rows, dtype=np.float64)
print(f"[gate] v3 val rows: {len(v3_rows)}")

# non-dnb mask — used by both v3 and v2 summaries below
non_dnb = np.array([not g.startswith("dnb.") for g in v3_groups])

for label, path in [
    ("old-v3", BACKUP / "symbolic-prior-v3.onnx"),
    ("new-v3", ROOT / "public" / "models" / "symbolic-prior-v3.onnx"),
]:
    probs = run(path, v3_rows)
    print(f"[gate] {label} overall valAUC={auc_score(v3_y, probs):.4f}")
    seen = sorted(set(v3_groups))
    for g in seen:
        mask = np.array([x == g for x in v3_groups])
        if mask.sum() < 10:
            continue
        print(f"[gate]   {label} {g}: auc={auc_score(np.array(v3_y)[mask], probs[mask]):.4f} (n={mask.sum()})")
    print(
        f"[gate]   {label} non-dnb valAUC={auc_score(np.array(v3_y)[non_dnb], probs[non_dnb]):.4f} "
        f"dnb valAUC={auc_score(np.array(v3_y)[~non_dnb], probs[~non_dnb]):.4f}"
    )

# v2 rows: semantic centroid + structural x[25:]
v2_rows = []
for i in val_idx:
    s = data[i]
    vec = styles.get(s["groove"].split("#")[0])
    if vec is None:
        continue
    v2_rows.append(list(vec) + list(s["x"][25:]))
print(f"[gate] v2 val rows: {len(v2_rows)}")
v2_y = list(v3_y)
for label, path in [
    ("old-v2", BACKUP / "symbolic-prior-v2.onnx"),
    ("new-v2", ROOT / "public" / "models" / "symbolic-prior-v2.onnx"),
]:
    probs = run(path, np.array(v2_rows))
    print(
        f"[gate] {label} overall valAUC={auc_score(v2_y, probs):.4f} "
        f"non-dnb valAUC={auc_score(np.array(v2_y)[non_dnb], probs[non_dnb]):.4f}"
    )
