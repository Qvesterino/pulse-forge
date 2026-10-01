"""Local intent model v1 trainer — offline development tooling.

Pure numpy + onnx: no torch, no network, no browser involvement. Mirrors
scripts/train-intent-ranker.py in shape and discipline.

The v1 student is a small MULTI-HEAD slot-filling network (not a generative
LM): a shared ReLU trunk over a binary bag-of-words of the instruction, with
one classification head per action slot. Every head's class list is CLOSED
and corpus-derived (sorted for determinism) — the heads ARE the constraint
that a GBNF grammar provides for the future LLM student; wrong-kind output
is structurally impossible and out-of-scope kinds decode to an explicit
ABSTAIN (fall back), never a guess.

Pipeline:
1. Loads scripts/data/intent-sft/{train,val,golden}.jsonl (teacher = the
   deterministic intent layer itself).
2. Builds the tokenizer vocabulary from TRAIN instructions only (freq desc,
   then lexicographic, cap 1024) and the closed per-slot class lists from
   TRAIN+VAL (class sets are schema, like the GBNF enums — not weights).
3. Trains trunk [V,256,128] + heads with plain Adam on summed cross-entropy.
4. Exports ONE ONNX graph (input "features" [N,V] -> trunk -> per-head
   outputs "head_<name>") via the official onnx helper, checked.
5. Writes public/models/intent-model-v1.onnx,
   public/models/intent-model-v1.vocab.json and
   scripts/data/intent-model-report.json (head accuracies + sizes).
   The MANIFEST is written by scripts/write-intent-model-manifest.mts —
   it must pin grammarSha256 = sha256(toGbnfGrammar()) from the LIVE
   TypeScript grammar, which python cannot compute.

Featurization is re-implemented from src/intent/model-decoder.ts
(tokenizeIntentInstruction / buildIntentBow); any drift between the two
implementations craters the validate gate, which runs the TS decoder on
real ORT outputs.

Run: python scripts/train-intent-model.py
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, checker, helper, numpy_helper

ROOT = Path(__file__).resolve().parent.parent
SFT_DIR = ROOT / "scripts" / "data" / "intent-sft"
MODELS_DIR = ROOT / "public" / "models"

TRUNK = [384, 192]
VOCAB_CAP = 4096
EPOCHS = 4000
LR = 2.5e-4
GRAD_CLIP_NORM = 1.0
WEIGHT_DECAY = 1e-4
SEED = 0x5EED

# Per-head importance for long-tail CLASS-BALANCED heads (kind, clipToBar).
# 1.0 keeps the plain sqrt-inverse-frequency balance — a 3× kind boost was
# tried (wave 5) and confounded by the parked preset heads; revisit only
# with a clean A/B.
KIND_LOSS_WEIGHT = 1.0

ABSENT = "__absent__"

# In-scope kinds (closed heads); everything else abstains.
# Failure-mining wave 3 (2026-10-01): the list now mirrors the schema's
# MODEL_ACTIONS contract (src/intent/model-schema.ts) instead of a frozen
# 15-kind subset — arrange/compound/clarify/clips/preset/presetUnknown rows
# were previously relabelled to abstain at training time, so the kind head
# had NO class for them and could only ever decode them as a wrong kind or
# abstain (measured: val "duplicate the intro" → exact/duplicateTrack).
# These kinds decode kind-only (their slot heads stay __absent__); the
# resolver refuses empty-slot routes and the deterministic layer takes over,
# so recognition is learned without any silent no-op risk.
KINDS = [
    "fader",
    "exact",
    "transport",
    "save",
    "export",
    "record",
    "select",
    "effectIntent",
    "sendIntent",
    "bypassIntent",
    "mix",
    "loudness",
    "tempo",
    "production",
    "revise",
    "arrange",
    "clips",
    "compound",
    "clarify",
    "preset",
    "presetUnknown",
]

# Arrange slot mirrors of the schema enums (src/intent/model-schema.ts VOCAB)
# — class sets are schema, like the GBNF enums, not weights. Sequence-student
# phase 1 (failure-mining wave 4): the arrange family is single-op in the
# whole corpus, so three closed heads cover it exactly; nested parts
# (compound) and engine-resolved clip refs stay out of the classifier's
# reach and keep abstaining.
ARRANGE_OPS = ["addRole", "autoArrange", "duplicate", "remove", "reorder", "resize"]
ARRANGE_ROLES = ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"]
# Sequence-student phase 2 (failure-mining wave 5): clip ops are single-op
# across the whole corpus with engine-resolved clipId stripped by the decode
# contract, so three closed heads cover the family. Compound emits its
# two-fader subset through per-part closed heads (part1/part2 ×
# direction/target/percent/amount/pads); non-fader parts and missing second
# parts abstain — the resolver refuses kind-only compounds anyway.
CLIP_OPS = ["copyClip", "deleteClip", "moveClip", "resizeClip"]

TARGET_VALUES = sorted(
    ["drums", "bass", "chords", "lead", "master", "vocal", "mix", "kick", "snare", "clap", "hat", "hats", "perc", "tom"]
)
PAD_VALUES = sorted(["kick", "snare", "clap", "hat", "perc", "tom"])
EFFECT_TYPES = sorted(
    [
        "reverb",
        "delay",
        "saturation",
        "distortion",
        "chorus",
        "flanger",
        "phaser",
        "tremolo",
        "bitcrusher",
        "compressor",
        "pump",
        "eq",
    ]
)
DIRECTIONS = sorted(["down", "up", "set", "more", "less", "remove", "louder", "quieter"])
AMOUNTS = sorted(["subtle", "normal", "medium", "big", "huge", "full"])
TRANSPORT_ACTIONS = sorted(["play", "pause", "stop", "metronomeOn", "metronomeOff", "loopOn", "loopOff"])
EXACT_OPS = sorted(
    [
        "mute",
        "solo",
        "pan",
        "tempo",
        "key",
        "gainDb",
        "transpose",
        "patternLength",
        "addTrack",
        "removeTrack",
        "duplicateTrack",
        "renameTrack",
    ]
)
TRACK_KINDS = sorted(["drum", "instrument"])
INSTRUMENTS = sorted(["analog", "bass", "keys"])
TRACK_NAMES = sorted(["sub", "sub bass"])
EXPORT_FORMATS = sorted(["wav", "mp3"])
SELECT_TARGETS = sorted(["drums", "bass", "lead", "chords"])
REVISE_ATTRIBUTES = sorted(["energy", "density"])
REVISE_ROLES = sorted(["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro"])
PROD_CONCEPTS = sorted(
    [
        "deeper",
        "punchier",
        "warmer",
        "darker",
        "brighter",
        "wider",
        "grittier",
        "glue",
        "lofi",
        "wobbly",
        "robotic",
        "metallic",
        "telephone",
        "tape",
        "stutter",
    ]
)
# KEYS / semitones / steps are DERIVED from the corpus (build_head_specs) —
# new templates extend the closed sets automatically.


def tokenize(text: str) -> list[str]:
    lowered = unicodedata.normalize("NFD", text.lower())
    stripped = "".join(ch for ch in lowered if not unicodedata.combining(ch))
    cleaned = re.sub(r"[^a-z0-9%+]+", " ", stripped)
    return [token for token in cleaned.split() if token]


def features_of(text: str) -> list[str]:
    """Feature expansion (intent-features.v2) — MUST mirror TS
    expandIntentFeatures in src/intent/model-decoder.ts EXACTLY: word
    unigrams, adjacent-word bigrams (`w1_w2`), and fastText-style char
    3+4-grams over the `^word$`-padded form. Separators sit outside the word
    charset, so no collision with plain words. Any drift between the two
    implementations craters the validate gate."""
    words = tokenize(text)
    features = list(words)
    for i in range(len(words) - 1):
        features.append(f"{words[i]}_{words[i + 1]}")
    for word in words:
        padded = f"^{word}$"
        for i in range(len(padded) - 2):
            features.append(padded[i : i + 3])
        for i in range(len(padded) - 3):
            features.append(padded[i : i + 4])
    return features


def softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - values.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)


def numeric_field_values(rows: list[dict], field: str) -> list[str]:
    """Every distinct value of `field` anywhere in the corpus, stringified
    exactly like str() would (trainer and decoder must agree on the class
    spelling — JS Number(x) parses these back identically)."""
    values: set[str] = set()
    for row in rows:
        for value in extract_labels(row)["numeric"].get(field, []):
            values.add(str(value))
    return sorted(values, key=float)


def string_field_values(rows: list[dict], field: str) -> list[str]:
    values: set[str] = set()
    for row in rows:
        value = extract_labels(row).get(field)
        if value is not None and value != ABSENT:
            values.add(value)
    return sorted(values)


def payload_of(response: dict) -> dict:
    if "intent" in response:
        return response["intent"]
    if "parse" in response:
        return response["parse"]
    return response


def extract_labels(row: dict) -> dict:
    """Inverse of the TS decoder assembly: response JSON -> per-head labels.

    `numeric` collects stringified numbers per slot so the trainer can derive
    the closed value sets; the per-head label is that string (or ABSENT).
    """
    response = row["response"]
    kind = response["kind"]
    payload = payload_of(response)
    labels: dict = {"numeric": {}, "sigmoid": {}}

    def note(field: str, value) -> None:
        if value is None:
            return
        labels["numeric"].setdefault(field, []).append(value)

    def as_class(value) -> str:
        if value is None:
            return ABSENT
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        return str(value)

    in_scope = kind in KINDS
    if not in_scope:
        labels["kind"] = "abstain"
        return labels
    labels["kind"] = kind

    ops = response.get("ops")
    op = ops[0] if isinstance(ops, list) and len(ops) == 1 else None
    if kind == "exact" and op is None:
        # multi-op plans are out of the v1 scope — abstain, never guess
        labels["kind"] = "abstain"
        return labels

    labels["direction"] = as_class(payload.get("direction"))
    targets = payload.get("targets")
    labels["targets"] = [t for t in (targets or []) if isinstance(t, str)]
    labels["pads"] = [p for p in (payload.get("pads") or []) if isinstance(p, str)]
    labels["effectType"] = as_class(payload.get("effectType"))
    labels["amount"] = as_class(payload.get("amount"))
    note("percent", payload.get("percent"))
    labels["percent"] = as_class(payload.get("percent"))
    note("bpm", payload.get("bpm") if payload.get("bpm") is not None else (op or {}).get("bpm"))
    labels["bpm"] = as_class(payload.get("bpm") if payload.get("bpm") is not None else (op or {}).get("bpm"))
    note("targetDb", payload.get("targetDb"))
    labels["targetDb"] = as_class(payload.get("targetDb"))
    note("deltaDb", (op or {}).get("deltaDb"))
    labels["deltaDb"] = as_class((op or {}).get("deltaDb"))
    note("panValue", (op or {}).get("value") if (op or {}).get("kind") == "pan" else None)
    labels["panValue"] = as_class((op or {}).get("value") if (op or {}).get("kind") == "pan" else None)
    note("semitones", (op or {}).get("semitones"))
    note("semitones", (op or {}).get("semitones"))
    labels["semitones"] = as_class((op or {}).get("semitones"))
    note("steps", (op or {}).get("steps"))
    labels["steps"] = as_class((op or {}).get("steps"))
    labels["key"] = as_class((op or {}).get("key"))
    labels["exactOp"] = as_class((op or {}).get("kind"))
    labels["boolValue"] = as_class(
        (op or {}).get("value") if (op or {}).get("kind") in ("mute", "solo") else payload.get("arm")
        if kind == "record"
        else payload.get("bypassed")
        if kind == "bypassIntent"
        else None
    )
    labels["trackKind"] = as_class((op or {}).get("trackKind"))
    labels["instrument"] = as_class((op or {}).get("instrument"))
    labels["trackName"] = as_class((op or {}).get("name"))
    labels["transportAction"] = as_class(payload.get("action"))
    labels["exportFormat"] = as_class(payload.get("format"))
    labels["selectTarget"] = as_class(payload.get("target") if kind == "select" else None)
    labels["targets_one"] = as_class(
        payload.get("target")
        if kind in ("sendIntent", "bypassIntent", "preset")
        else (op or {}).get("target")
        if op
        else None
    )
    labels["reviseAttribute"] = as_class(payload.get("attribute"))
    labels["targetRole"] = as_class(payload.get("targetRole"))
    arrange_first = (ops or [{}])[0] if isinstance(ops, list) and ops else {}
    note("arrangeOp", arrange_first.get("op"))
    labels["arrangeOp"] = as_class(arrange_first.get("op"))
    note("arrangeRole", arrange_first.get("role"))
    labels["arrangeRole"] = as_class(arrange_first.get("role"))
    note("arrangeBars", arrange_first.get("bars"))
    labels["arrangeBars"] = as_class(arrange_first.get("bars"))
    clip = arrange_first if kind == "clips" else {}
    note("clipOp", clip.get("op"))
    labels["clipOp"] = as_class(clip.get("op"))
    note("clipToBar", clip.get("toBar"))
    labels["clipToBar"] = as_class(clip.get("toBar"))
    note("clipBars", clip.get("bars"))
    labels["clipBars"] = as_class(clip.get("bars"))
    # PRESET HEADS PARKED (failure-mining wave 5 gate artifact): the
    # content-derived presetId/presetName classes are OPEN VOCABULARY —
    # measured in retrain 8 at 0.0/0.07 head accuracy with trunk-wide
    # collapse (preset ids are factory strings a closed head cannot learn
    # from 16 rows). Parked so the gate artifact trains clean; restore these
    # two blocks together with the head specs below when the preset family
    # gets real coverage or the sequence student.
    if False and kind == "preset":
        # closed-class preset identity: the corpus's own preset set is the
        # class list (content-derived, like the numeric heads)
        preset_obj = payload.get("preset") or {}
        labels["presetId"] = as_class(preset_obj.get("id"))
        labels["presetName"] = as_class(preset_obj.get("name"))
    parts = response.get("parts") or []
    for index in (0, 1):
        part = parts[index] if index < len(parts) else {}
        bag = part.get("intent") if part.get("kind") == "fader" else {}
        prefix = f"part{index + 1}"
        note(f"{prefix}Direction", bag.get("direction"))
        labels[f"{prefix}Direction"] = as_class(bag.get("direction"))
        part_targets = [t for t in (bag.get("targets") or []) if isinstance(t, str)]
        labels[f"{prefix}Target"] = part_targets[0] if part_targets else ABSENT
        note(f"{prefix}Percent", bag.get("percent"))
        labels[f"{prefix}Percent"] = as_class(bag.get("percent"))
        labels[f"{prefix}Amount"] = as_class(bag.get("amount"))
        labels[f"{prefix}Pads"] = [p for p in (bag.get("pads") or []) if isinstance(p, str)]
    goals = payload.get("goals") or []
    goal = goals[0] if goals else {}
    labels["prodConcept"] = as_class(goal.get("concept"))
    note("prodAmount", goal.get("amount"))
    labels["prodAmount"] = as_class(goal.get("amount"))
    overrides = payload.get("overrides") or {}
    for slot in ("reverb", "tone", "punch", "pump"):
        labels[f"mix{slot.capitalize()}"] = as_class(overrides.get(slot))
    return labels


# ── Label tensors ────────────────────────────────────────────────────────────

def build_head_specs(rows: list[dict]) -> list[dict]:
    """Closed class lists: corpus-derived numeric sets + the schema enums."""
    percent = sorted({v for v in numeric_field_values(rows, "percent")}, key=float)
    bpm = sorted({v for v in numeric_field_values(rows, "bpm")}, key=float)
    target_db = sorted({v for v in numeric_field_values(rows, "targetDb")}, key=float)
    delta_db = sorted({v for v in numeric_field_values(rows, "deltaDb")}, key=float)
    pan = sorted({v for v in numeric_field_values(rows, "panValue")}, key=float)
    semitones = sorted({v for v in numeric_field_values(rows, "semitones")}, key=float)
    steps = sorted({v for v in numeric_field_values(rows, "steps")}, key=float)
    amounts = sorted({v for v in numeric_field_values(rows, "prodAmount")}, key=float)
    keys = string_field_values(rows, "key")
    bars = sorted({v for v in numeric_field_values(rows, "arrangeBars")}, key=float)
    clip_to_bar = sorted({v for v in numeric_field_values(rows, "clipToBar")}, key=float)
    clip_bars = sorted({v for v in numeric_field_values(rows, "clipBars")}, key=float)
    part_pcts = [
        sorted({v for v in numeric_field_values(rows, f"part{i}Percent")}, key=float) for i in (1, 2)
    ]
    heads = [
        {"name": "kind", "kind": "softmax", "classes": ["abstain"] + KINDS},
        {"name": "arrangeOp", "kind": "softmax", "classes": [ABSENT] + ARRANGE_OPS},
        {"name": "arrangeRole", "kind": "softmax", "classes": [ABSENT] + ARRANGE_ROLES},
        {"name": "arrangeBars", "kind": "softmax", "classes": [ABSENT] + bars},
        {"name": "clipOp", "kind": "softmax", "classes": [ABSENT] + CLIP_OPS},
        # PARKED with the preset labels above (see wave-5 note) — the decoder's
        # preset case guards on these heads and abstains while absent.
        # {"name": "presetId", "kind": "softmax", "classes": [ABSENT] + string_field_values(rows, "presetId")},
        # {"name": "presetName", "kind": "softmax", "classes": [ABSENT] + string_field_values(rows, "presetName")},
        {"name": "clipToBar", "kind": "softmax", "classes": [ABSENT] + clip_to_bar},
        {"name": "clipBars", "kind": "softmax", "classes": [ABSENT] + clip_bars},
        {"name": "part1Direction", "kind": "softmax", "classes": [ABSENT] + DIRECTIONS},
        {"name": "part1Target", "kind": "softmax", "classes": [ABSENT] + TARGET_VALUES},
        {"name": "part1Percent", "kind": "softmax", "classes": [ABSENT] + part_pcts[0]},
        {"name": "part1Amount", "kind": "softmax", "classes": [ABSENT] + AMOUNTS},
        {"name": "part1Pads", "kind": "sigmoid", "classes": PAD_VALUES},
        {"name": "part2Direction", "kind": "softmax", "classes": [ABSENT] + DIRECTIONS},
        {"name": "part2Target", "kind": "softmax", "classes": [ABSENT] + TARGET_VALUES},
        {"name": "part2Percent", "kind": "softmax", "classes": [ABSENT] + part_pcts[1]},
        {"name": "part2Amount", "kind": "softmax", "classes": [ABSENT] + AMOUNTS},
        {"name": "part2Pads", "kind": "sigmoid", "classes": PAD_VALUES},
        {"name": "direction", "kind": "softmax", "classes": [ABSENT] + DIRECTIONS},
        {"name": "targets", "kind": "sigmoid", "classes": TARGET_VALUES},
        {"name": "pads", "kind": "sigmoid", "classes": PAD_VALUES},
        {"name": "targets_one", "kind": "softmax", "classes": [ABSENT] + TARGET_VALUES},
        {"name": "effectType", "kind": "softmax", "classes": [ABSENT] + EFFECT_TYPES},
        {"name": "amount", "kind": "softmax", "classes": [ABSENT] + AMOUNTS},
        {"name": "percent", "kind": "softmax", "classes": [ABSENT] + percent},
        {"name": "bpm", "kind": "softmax", "classes": [ABSENT] + bpm},
        {"name": "targetDb", "kind": "softmax", "classes": [ABSENT] + target_db},
        {"name": "deltaDb", "kind": "softmax", "classes": [ABSENT] + delta_db},
        {"name": "panValue", "kind": "softmax", "classes": [ABSENT] + pan},
        {"name": "semitones", "kind": "softmax", "classes": [ABSENT] + semitones},
        {"name": "steps", "kind": "softmax", "classes": [ABSENT] + steps},
        {"name": "key", "kind": "softmax", "classes": [ABSENT] + keys},
        {"name": "exactOp", "kind": "softmax", "classes": [ABSENT] + EXACT_OPS},
        {"name": "boolValue", "kind": "softmax", "classes": [ABSENT, "true", "false"]},
        {"name": "trackKind", "kind": "softmax", "classes": [ABSENT] + TRACK_KINDS},
        {"name": "instrument", "kind": "softmax", "classes": [ABSENT] + INSTRUMENTS},
        {"name": "trackName", "kind": "softmax", "classes": [ABSENT] + TRACK_NAMES},
        {"name": "transportAction", "kind": "softmax", "classes": [ABSENT] + TRANSPORT_ACTIONS},
        {"name": "exportFormat", "kind": "softmax", "classes": [ABSENT] + EXPORT_FORMATS},
        {"name": "selectTarget", "kind": "softmax", "classes": [ABSENT] + SELECT_TARGETS},
        {"name": "reviseAttribute", "kind": "softmax", "classes": [ABSENT] + REVISE_ATTRIBUTES},
        {"name": "targetRole", "kind": "softmax", "classes": [ABSENT] + REVISE_ROLES},
        {"name": "prodConcept", "kind": "softmax", "classes": [ABSENT] + PROD_CONCEPTS},
        {"name": "prodAmount", "kind": "softmax", "classes": [ABSENT] + amounts},
        {"name": "mixReverb", "kind": "softmax", "classes": [ABSENT, "more", "less", "huge"]},
        {"name": "mixTone", "kind": "softmax", "classes": [ABSENT, "dark", "bright", "warm", "cold"]},
        {"name": "mixPunch", "kind": "softmax", "classes": [ABSENT, "more", "less"]},
        {"name": "mixPump", "kind": "softmax", "classes": [ABSENT, "on", "off"]},
    ]
    return heads


def label_index(head: dict, labels: dict) -> int | None:
    value = labels.get(head["name"])
    if value is None:
        return None
    try:
        return head["classes"].index(value)
    except ValueError:
        return None  # unseen class — reported, treated as absent


def sigmoid_targets(head: dict, labels: dict) -> np.ndarray:
    active = set(labels.get(head["name"]) or [])
    return np.array([1.0 if cls in active else 0.0 for cls in head["classes"]], dtype=np.float64)


# ── Model ────────────────────────────────────────────────────────────────────

class MultiHeadNet:
    def __init__(self, vocab_size: int, heads: list[dict], rng) -> None:
        self.sizes = [vocab_size] + TRUNK
        self.weights = []
        self.biases = []
        for index in range(1, len(self.sizes)):
            scale = np.sqrt(2.0 / self.sizes[index - 1])
            self.weights.append(rng.normal(0, scale, (self.sizes[index - 1], self.sizes[index])).astype(np.float64))
            self.biases.append(np.zeros(self.sizes[index], dtype=np.float64))
        self.head_weights = []
        self.head_biases = []
        for head in heads:
            scale = np.sqrt(2.0 / self.sizes[-1])
            self.head_weights.append(rng.normal(0, scale, (self.sizes[-1], len(head["classes"]))).astype(np.float64))
            self.head_biases.append(np.zeros(len(head["classes"]), dtype=np.float64))
        self.head_names = [head["name"] for head in heads]
        # Adam state in the canonical param order used by adam_update.
        all_params = self.weights + self.head_weights + self.biases + self.head_biases
        self.adam_m = [np.zeros_like(p) for p in all_params]
        self.adam_v = [np.zeros_like(p) for p in all_params]
        self.adam_step = 0

    def forward(self, x: np.ndarray):
        h1 = np.maximum(0.0, x @ self.weights[0] + self.biases[0])
        h2 = np.maximum(0.0, h1 @ self.weights[1] + self.biases[1])
        logits = [h2 @ w + b for w, b in zip(self.head_weights, self.head_biases)]
        return h1, h2, logits

    def train_step(self, x, batch_labels, heads, lr_scale=1.0):
        n = x.shape[0]
        h1, h2, logits = self.forward(x)
        dh2 = np.zeros_like(h2)
        loss = 0.0
        grads_w = [np.zeros_like(w) for w in self.weights]
        grads_b = [np.zeros_like(b) for b in self.biases]
        grads_hw = [np.zeros_like(w) for w in self.head_weights]
        grads_hb = [np.zeros_like(b) for b in self.head_biases]
        for index, head in enumerate(heads):
            logit = logits[index]
            if head["kind"] == "softmax":
                smooth = label_smoothing()
                target = np.full(logit.shape, smooth / len(head["classes"]), dtype=np.float64)
                counts: dict[int, int] = {}
                for row in range(n):
                    cls = label_index(head, batch_labels[row])
                    if cls is not None:
                        target[row, cls] += 1.0 - smooth
                        counts[cls] = counts.get(cls, 0) + 1
                probs = softmax(logit)
                truth = target.argmax(axis=1)
                if head["name"] in ("kind", "presetId", "presetName", "clipToBar"):
                    # Log-scaled class balance on the long-tailed heads
                    # (kind: exact 474 rows vs save 6; direction/percent:
                    # rare direction words and rare numeric classes). An
                    # unweighted CE teaches the head to vote for the majority
                    # class — the measured val confusions. sqrt-inverse
                    # frequency lifts rare classes without letting a
                    # 4-row class dominate.
                    row_weights = np.array(
                        [
                            (len(batch_labels) / (len(head["classes"]) * max(1, counts.get(c, 0)))) ** 0.5
                            for c in (label_index(head, batch_labels[row]) for row in range(n))
                        ],
                        dtype=np.float64,
                    )
                    row_weights /= row_weights.mean()
                else:
                    row_weights = np.ones(n, dtype=np.float64)
                loss += -KIND_LOSS_WEIGHT * np.mean(
                    row_weights * np.log(np.clip(probs[np.arange(n), truth], 1e-9, 1.0))
                )
                dlogits = (probs - target) * row_weights[:, None] * (KIND_LOSS_WEIGHT / n)
            else:
                target = np.stack([sigmoid_targets(head, batch_labels[row]) for row in range(n)])
                probs = 1.0 / (1.0 + np.exp(-np.clip(logit, -30, 30)))
                # Balanced positive weighting: the sigmoid heads (targets/pads)
                # are sparse multi-label — an unweighted BCE collapses to
                # all-False ("accurate" on paper, useless in decode: empty
                # targets on every fader). Weight each positive by its class
                # balance so rare targets compete with the ABSENT majority.
                pos = target.sum(axis=0)
                neg = n - pos
                pos_weight = np.where(pos > 0, (pos + neg) / np.maximum(pos, 1.0), 1.0)
                weights = np.where(target > 0.5, pos_weight, 1.0)
                loss += -np.mean(
                    weights
                    * (target * np.log(np.clip(probs, 1e-9, 1.0)) + (1 - target) * np.log(np.clip(1 - probs, 1e-9, 1.0)))
                )
                dlogits = (weights * (probs - target)) / n
            grads_hw[index] = h2.T @ dlogits + WEIGHT_DECAY * self.head_weights[index]
            grads_hb[index] = dlogits.sum(axis=0)
            dh2 += dlogits @ self.head_weights[index].T
        # trunk backprop
        dh2_active = dh2 * (h2 > 0)
        dh1 = dh2_active @ self.weights[1].T
        grads_w[1] = h1.T @ dh2_active + WEIGHT_DECAY * self.weights[1]
        grads_b[1] = dh2_active.sum(axis=0)
        dh1_active = dh1 * (h1 > 0)
        grads_w[0] = x.T @ dh1_active + WEIGHT_DECAY * self.weights[0]
        grads_b[0] = dh1_active.sum(axis=0)
        self.adam_update(grads_w + grads_hw + grads_b + grads_hb, lr_scale)
        return loss / len(heads)

    def adam_update(self, grads, lr_scale=1.0):
        # global-norm clip: 30 heads sum into the shared trunk — unclipped,
        # the effective trunk step oscillates and the loss diverges
        total_norm = float(np.sqrt(sum(float(np.sum(g * g)) for g in grads)))
        if total_norm > GRAD_CLIP_NORM:
            scale_factor = GRAD_CLIP_NORM / (total_norm + 1e-12)
            grads = [g * scale_factor for g in grads]
        self.adam_step += 1
        beta1, beta2, eps = 0.9, 0.999, 1e-8
        bias1 = 1 - beta1**self.adam_step
        bias2 = 1 - beta2**self.adam_step
        all_params = self.weights + self.head_weights + self.biases + self.head_biases
        for position, (param, grad) in enumerate(zip(all_params, grads)):
            self.adam_m[position] = beta1 * self.adam_m[position] + (1 - beta1) * grad
            self.adam_v[position] = beta2 * self.adam_v[position] + (1 - beta2) * grad * grad
            m_hat = self.adam_m[position] / bias1
            v_hat = self.adam_v[position] / bias2
            param -= lr_scale * LR * m_hat / (np.sqrt(v_hat) + eps)


def label_smoothing() -> float:
    return 0.02


def main() -> None:
    rng = np.random.default_rng(SEED)
    train_rows = [json.loads(line) for line in (SFT_DIR / "train.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    val_rows = [json.loads(line) for line in (SFT_DIR / "val.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    golden_rows = [json.loads(line) for line in (SFT_DIR / "golden.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]

    # vocabulary from TRAIN instructions only
    freq: Counter[str] = Counter()
    for row in train_rows:
        freq.update(features_of(row["instruction"]))
    tokens = [token for token, _ in sorted(freq.items(), key=lambda item: (-item[1], item[0]))][:VOCAB_CAP]
    token_index = {token: i for i, token in enumerate(tokens)}

    heads = build_head_specs(train_rows + val_rows)

    def featurize(rows: list[dict]) -> np.ndarray:
        x = np.zeros((len(rows), len(tokens)), dtype=np.float64)
        for row_index, row in enumerate(rows):
            for feature in features_of(row["instruction"]):
                column = token_index.get(feature)
                if column is not None:
                    x[row_index, column] = 1.0
        return x

    x_train = featurize(train_rows)
    labels_train = [extract_labels(row) for row in train_rows]
    x_val = featurize(val_rows)
    labels_val = [extract_labels(row) for row in val_rows]

    unseen: list[str] = []
    for labels in labels_train + labels_val:
        for head in heads:
            if head["kind"] != "softmax":
                continue
            value = labels.get(head["name"])
            if value is not None and value not in head["classes"]:
                unseen.append(f"{head['name']}={value}")
    if unseen:
        print(f"warning: {len(unseen)} unseen softmax labels: {sorted(set(unseen))[:8]}")

    net = MultiHeadNet(len(tokens), heads, rng)

    def snapshot():
        return [w.copy() for w in net.weights + net.head_weights + net.biases + net.head_biases]

    def restore(snapshot_bytes):
        all_params = net.weights + net.head_weights + net.biases + net.head_biases
        for param, value in zip(all_params, snapshot_bytes):
            param[...] = value

    def train_full_head_accuracy() -> float:
        """Checkpoint selection metric: fraction of (row, head) labels the
        net reproduces under the DECODER's rules (softmax argmax; sigmoid
        >= 0). Assembled quality, not a single head — kind alone let
        underfit sigmoid heads slip through."""
        _, _, logits = net.forward(x_train)
        hits = 0
        total = 0
        for index, head in enumerate(heads):
            scores = logits[index]
            for row_index, labels in enumerate(labels_train):
                value = labels.get(head["name"])
                if value is None:
                    continue
                total += 1
                if head["kind"] == "softmax":
                    predicted = head["classes"][int(scores[row_index].argmax())]
                else:
                    predicted = head["classes"][int(scores[row_index].argmax())] if scores[row_index].max() >= 0 else None
                if predicted == value:
                    hits += 1
        return hits / max(1, total)

    best_score = (-1.0, float("inf"))  # (full-head acc desc, loss asc)
    best_snapshot = snapshot()
    best_epoch = 0
    for epoch in range(EPOCHS):
        lr_scale = 0.5 * (1.0 + np.cos(np.pi * epoch / EPOCHS))
        loss = net.train_step(x_train, labels_train, heads, lr_scale)
        if epoch % 10 == 0 or epoch == EPOCHS - 1:
            score = (train_full_head_accuracy(), loss)
            if score[0] > best_score[0] or (score[0] == best_score[0] and score[1] < best_score[1]):
                best_score = score
                best_snapshot = snapshot()
                best_epoch = epoch
        if epoch % 200 == 0 or epoch == EPOCHS - 1:
            print(f"epoch {epoch:5d}  loss {loss:.4f}  best head-acc {best_score[0]:.4f} @ {best_epoch}")
    restore(best_snapshot)
    print(f"restored best snapshot from epoch {best_epoch} (train full-head acc {best_score[0]:.4f}, loss {best_score[1]:.4f})")

    def head_accuracy(x, labels) -> dict:
        _, _, logits = net.forward(x)
        result = {}
        for index, head in enumerate(heads):
            if head["kind"] == "softmax":
                predicted = logits[index].argmax(axis=1)
                truth = np.array([label_index(head, entry) if label_index(head, entry) is not None else 0 for entry in labels])
                result[head["name"]] = float((predicted == truth).mean())
        return result

    train_acc = head_accuracy(x_train, labels_train)
    val_acc = head_accuracy(x_val, labels_val)

    # ── ONNX export: one graph, per-head outputs ────────────────────────────
    initializers = []
    nodes = []
    current = "features"
    for index in range(len(net.weights)):
        weight_name, bias_name = f"W{index}", f"B{index}"
        initializers.append(numpy_helper.from_array(net.weights[index].astype(np.float32), weight_name))
        initializers.append(numpy_helper.from_array(net.biases[index].astype(np.float32), bias_name))
        nodes.append(
            helper.make_node(
                "Gemm",
                [current, weight_name, bias_name],
                [f"gemm{index}"],
                alpha=1.0,
                beta=1.0,
                transA=0,
                transB=0,
            )
        )
        current = f"gemm{index}"
        nodes.append(helper.make_node("Relu", [current], [f"relu{index}"]))
        current = f"relu{index}"
    outputs = []
    for index, head in enumerate(heads):
        name = head["name"]
        initializers.append(numpy_helper.from_array(net.head_weights[index].astype(np.float32), f"HW_{name}"))
        initializers.append(numpy_helper.from_array(net.head_biases[index].astype(np.float32), f"HB_{name}"))
        nodes.append(helper.make_node("Gemm", [current, f"HW_{name}", f"HB_{name}"], [f"logit_{name}"], alpha=1.0, beta=1.0, transA=0, transB=0))
        nodes.append(helper.make_node("Identity", [f"logit_{name}"], [f"head_{name}"], name=f"out_{name}"))
        outputs.append(helper.make_tensor_value_info(f"head_{name}", TensorProto.FLOAT, [None, len(head["classes"])]))

    graph = helper.make_graph(
        nodes,
        "intent-model-v1",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, len(tokens)])],
        outputs,
        initializer=initializers,
    )
    model = helper.make_model(graph, producer_name="pulse-forge-intent-trainer", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    checker.check_model(model)
    model_bytes = model.SerializeToString()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / "intent-model-v1.onnx").write_bytes(model_bytes)
    vocab_artifact = {
        "version": 1,
        "tokens": tokens,
        "trunk": TRUNK,
        "heads": heads,
        "tokenPattern": "lower, NFD-strip, [a-z0-9%+]+ words; features = unigrams + word bigrams + char 3-grams (^word$); binary presence",
    }
    (MODELS_DIR / "intent-model-v1.vocab.json").write_text(json.dumps(vocab_artifact, indent=2) + "\n", encoding="utf-8")

    report = {
        "modelVersion": "intent-model.v1",
        "architecture": "multi-head slot-filling MLP (BoW trunk + closed-class heads)",
        "vocabSize": len(tokens),
        "trunk": TRUNK,
        "headCount": len(heads),
        "trainRows": len(train_rows),
        "valRows": len(val_rows),
        "goldenRows": len(golden_rows),
        "epochs": EPOCHS,
        "seed": SEED,
        "trainHeadAccuracy": train_acc,
        "valHeadAccuracy": val_acc,
        "unseenLabels": unseen,
        "note": "assembled exact/kindOK gate lives in scripts/validate-intent-model.mts (TS decoder on real ORT outputs)",
    }
    (ROOT / "scripts" / "data" / "intent-model-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    # kind confusion on val (diagnostic)
    _, _, val_logits = net.forward(x_val)
    kind_head = next(head for head in heads if head["name"] == "kind")
    predicted = val_logits[[head["name"] for head in heads].index("kind")].argmax(axis=1)
    truth = np.array(
        [
            kind_head["classes"].index(entry["kind"]) if entry["kind"] in kind_head["classes"] else 0
            for entry in labels_val
        ]
    )
    confusion = {}
    for p, t in zip(predicted, truth):
        if p != t:
            pair = f"{kind_head['classes'][t]} -> {kind_head['classes'][p]}"
            confusion[pair] = confusion.get(pair, 0) + 1
    print("val kind confusions:", confusion or "none")

    weak = {name: acc for name, acc in val_acc.items() if acc < 0.95}
    print(f"model bytes: {len(model_bytes)}")
    print(f"vocab: {len(tokens)} tokens, {len(heads)} heads")
    print(f"val head accuracy: mean={sum(val_acc.values()) / len(val_acc):.4f}  weak(<0.95): {weak or 'none'}")


if __name__ == "__main__":
    main()
