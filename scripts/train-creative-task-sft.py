"""Experimental LoRA SFT for KYX creative-task interpretation only.

This is intentionally separate from train-intent-sft.py: creative proposals
are not executable DAW actions and have their own output contract, corpus,
metrics and promotion gates. The checked-in v1 corpus is a synthetic bootstrap
set. Training it requires an explicit acknowledgement and never promotes or
registers the resulting adapter.

Example (after a representative, reviewed corpus replaces the bootstrap set):
  .sft/venv/Scripts/python.exe scripts/train-creative-task-sft.py \
    --base-model <explicit-hf-model-id-or-local-path> \
    --out-dir D:/pulse-forge/.sft/creative/experiment-01 \
    --allow-synthetic-bootstrap
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS = ROOT / "scripts" / "data" / "creative-task-sft"
GOLDEN_PATH = ROOT / "scripts" / "data" / "creative-task-v1-golden.jsonl"
ROLE_ORDER = ("drums", "bass", "chords", "lead")
GENRES = {
    "house", "techno", "trap", "ambient", "drill", "phonk", "jersey", "dnb", "hyperpop", "ukg",
    "boombap", "amapiano", "trance", "detroit", "postrock", "chiptune", "eurodance", "latin", "drone",
}
ROOT_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
SCALE_LABELS = (
    "Major", "Natural Minor", "Harmonic Minor", "Melodic Minor", "Dorian", "Phrygian", "Mixolydian",
    "Pentatonic Major", "Pentatonic Minor",
)
MUSICAL_KEYS = {f"{root} {scale}" for root in ROOT_NAMES for scale in SCALE_LABELS}
CREATIVE_FIELDS = {
    "genre", "style", "mood", "bpmRange", "key", "length", "energy", "density", "complexity", "variation",
    "roles", "preserve", "prohibitedRoles",
}
SUGGESTION_FIELDS = {
    "genre", "style", "mood", "bpmRange", "key", "lengthSteps", "energy", "density", "complexity",
    "variation", "targetRoles", "preserveRoles", "prohibitedRoles",
}
SOURCE_PATHS = (
    "scripts/generate-creative-task-sft.mts",
    "scripts/run-creative-task-sft.mjs",
    "scripts/train-creative-task-sft.py",
    "src/ai/types.ts",
    "src/intent/creative-task-contract.ts",
    "src/intent/creative-task-ollama.ts",
    "src/intent/brief-contract.ts",
    "src/intent/text-parser.ts",
    "src/project-model/types.ts",
)
MAX_CORPUS_BYTES = 8 * 1024 * 1024
MAX_SEQUENCE_LENGTH = 1_024
MAX_GENERATION_TOKENS = 160
SEED = 0xC7EA71
HUMAN_SOURCE_PATHS = (
    "scripts/creative-task-human-corpus.ts",
    "scripts/compile-creative-task-human-corpus.mts",
    "scripts/train-creative-task-sft.py",
    "src/intent/brief-contract.ts",
    "src/intent/creative-task-contract.ts",
    "src/intent/creative-task-ollama.ts",
    "src/intent/text-parser.ts",
)
CASE_ID_PATTERN = re.compile(r"^case-[0-9a-f]{32}$")
FAMILY_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){1,7}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def one_cycle_warmup_fraction(total_steps: int) -> float:
    """Keep OneCycleLR's warm-up and decay phases non-zero on tiny corpora."""
    if type(total_steps) is not int or total_steps < 1:
        raise ValueError("total_steps must be a positive integer")
    return min(0.9, max(0.3, 2.0 / total_steps))


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Cannot read valid JSON from {path}: {error}") from error


def read_jsonl(path: Path) -> tuple[list[dict[str, Any]], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise SystemExit(f"Cannot read {path}: {error}") from error
    if len(raw) > MAX_CORPUS_BYTES:
        raise SystemExit(f"Refusing corpus over {MAX_CORPUS_BYTES} bytes: {path}")
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Invalid JSON at {path}:{line_number}: {error.msg}") from error
        if not isinstance(value, dict):
            raise SystemExit(f"Expected an object at {path}:{line_number}")
        rows.append(value)
    return rows, raw


def validate_output(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) - {"version", "status", "suggestions", "unknownFields", "question"}:
        return False
    if type(value.get("version")) is not int or value.get("version") != 1 or value.get("status") not in ("proposal", "clarify", "abstain"):
        return False
    suggestions = value.get("suggestions")
    unknown = value.get("unknownFields")
    if not isinstance(suggestions, dict) or set(suggestions) - SUGGESTION_FIELDS:
        return False
    if not isinstance(unknown, list) or len(unknown) > len(CREATIVE_FIELDS) or any(not isinstance(x, str) for x in unknown):
        return False
    if len(set(unknown)) != len(unknown) or any(x not in CREATIVE_FIELDS for x in unknown):
        return False
    if "question" in value and (value["status"] != "clarify" or not isinstance(value["question"], str) or not value["question"].strip()):
        return False
    if "question" in value and (len(value["question"]) > 240 or any(ord(char) < 32 or ord(char) == 127 for char in value["question"])):
        return False

    if "genre" in suggestions and (not isinstance(suggestions["genre"], str) or suggestions["genre"] not in GENRES):
        return False
    for field in ("style", "mood"):
        if field in suggestions and (
            not isinstance(suggestions[field], str)
            or not 0 < len(suggestions[field].strip()) <= 80
            or any(ord(char) < 32 or ord(char) == 127 for char in suggestions[field])
        ):
            return False
    if "bpmRange" in suggestions:
        bpm = suggestions["bpmRange"]
        if not isinstance(bpm, list) or len(bpm) != 2 or any(type(x) is not int or not 40 <= x <= 240 for x in bpm) or bpm[0] > bpm[1]:
            return False
    if "key" in suggestions and (not isinstance(suggestions["key"], str) or suggestions["key"] not in MUSICAL_KEYS):
        return False
    if "lengthSteps" in suggestions:
        steps = suggestions["lengthSteps"]
        if type(steps) is not int or not 16 <= steps <= 256 or steps % 16:
            return False
    for field in ("energy", "density", "complexity", "variation"):
        if field in suggestions and (type(suggestions[field]) not in {int, float} or not math.isfinite(suggestions[field]) or not 0 <= suggestions[field] <= 1):
            return False
    for field in ("targetRoles", "preserveRoles", "prohibitedRoles"):
        if field in suggestions:
            roles = suggestions[field]
            if not isinstance(roles, list) or not roles or any(not isinstance(role, str) for role in roles):
                return False
            if len(set(roles)) != len(roles) or any(role not in ROLE_ORDER for role in roles):
                return False

    targets = set(suggestions.get("targetRoles", []))
    preserved = set(suggestions.get("preserveRoles", []))
    prohibited = set(suggestions.get("prohibitedRoles", []))
    if targets & (preserved | prohibited) or preserved & prohibited:
        return False
    if value["status"] == "proposal" and not suggestions:
        return False
    if value["status"] == "clarify" and (not isinstance(value.get("question"), str) or not value["question"].strip()):
        return False
    if value["status"] == "abstain" and (suggestions or "question" in value):
        return False
    return True


def validate_corpus(corpus_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str, dict[str, Any]]:
    manifest_path = corpus_dir / "manifest.json"
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict) or manifest.get("formatVersion") != 1 or manifest.get("task") != "creative-task-v1":
        raise SystemExit("Unsupported creative SFT manifest; expected formatVersion=1, task=creative-task-v1.")
    if manifest.get("synthetic") is not True or manifest.get("humanReviewed") is not False:
        raise SystemExit("This trainer only accepts the explicitly-marked synthetic bootstrap corpus.")
    if manifest.get("eligibleForModelPromotion") is not False:
        raise SystemExit("The bootstrap corpus must not claim model-promotion eligibility.")

    prompt_bytes = (corpus_dir / "prompt.txt").read_bytes()
    if sha256_bytes(prompt_bytes) != manifest.get("prompt", {}).get("sha256"):
        raise SystemExit("Creative SFT system prompt hash does not match the pinned manifest.")
    current_sources = manifest.get("sourceHashes", {})
    for relative_path in SOURCE_PATHS:
        actual = sha256_bytes((ROOT / relative_path).read_bytes())
        if current_sources.get(relative_path) != actual:
            raise SystemExit(f"Creative SFT source changed since corpus generation: {relative_path}; regenerate and revalidate.")

    splits: dict[str, list[dict[str, Any]]] = {}
    for split in ("train", "validation"):
        entry = manifest.get("splits", {}).get(split)
        if not isinstance(entry, dict) or entry.get("path") not in {"train.jsonl", "validation.jsonl"}:
            raise SystemExit(f"Invalid {split} split entry in creative SFT manifest.")
        rows, raw = read_jsonl(corpus_dir / entry["path"])
        if len(rows) != entry.get("rows") or sha256_bytes(raw) != entry.get("sha256"):
            raise SystemExit(f"Creative SFT {split} split count/hash mismatch; regenerate and validate the corpus.")
        splits[split] = rows

    all_rows = splits["train"] + splits["validation"]
    ids: set[str] = set()
    prompts: set[str] = set()
    families: dict[str, set[str]] = {"train": set(), "validation": set()}
    for split, rows in splits.items():
        for row in rows:
            required = {"version", "id", "family", "split", "language", "source", "operation", "prompt", "instruction", "response"}
            if set(row) != required or row.get("version") != 1 or row.get("split") != split:
                raise SystemExit(f"Creative SFT row has an invalid shape/split in {split}.")
            if not all(isinstance(row.get(key), str) and row[key] for key in ("id", "family", "prompt", "instruction")):
                raise SystemExit(f"Creative SFT row has empty identity/text fields: {row.get('id')}")
            if row.get("source") != "synthetic-author-authored-v1" or row.get("language") not in {"en", "sk"}:
                raise SystemExit(f"Creative SFT row has unexpected provenance/language: {row.get('id')}")
            if row.get("operation") not in {"generate", "revise"} or not validate_output(row.get("response")):
                raise SystemExit(f"Creative SFT target violates creative-task-v1: {row.get('id')}")
            try:
                request = json.loads(row["instruction"])
            except json.JSONDecodeError as error:
                raise SystemExit(f"Invalid request JSON in creative SFT row {row['id']}: {error.msg}") from error
            if not isinstance(request, dict) or request.get("version") != 1 or request.get("operation") != row["operation"] or request.get("prompt") != row["prompt"]:
                raise SystemExit(f"Creative SFT request/prompt/operation mismatch: {row['id']}")
            normalized = " ".join(unicodedata.normalize("NFKC", row["prompt"]).casefold().split())
            if row["id"] in ids or normalized in prompts:
                raise SystemExit(f"Duplicate creative SFT id or normalized prompt: {row['id']}")
            ids.add(row["id"])
            prompts.add(normalized)
            families[split].add(row["family"])

    overlap = families["train"] & families["validation"]
    if overlap:
        raise SystemExit(f"Train/validation family leakage: {sorted(overlap)}")
    for split in ("train", "validation"):
        declared = manifest["splits"][split].get("families")
        if declared != sorted(families[split]):
            raise SystemExit(f"Creative SFT {split} family list does not match the manifest.")
    golden_rows, golden_bytes = read_jsonl(GOLDEN_PATH)
    golden_entry = manifest.get("heldOutGolden", {})
    if sha256_bytes(golden_bytes) != golden_entry.get("sha256") or len(golden_rows) != golden_entry.get("rows"):
        raise SystemExit("Creative held-out golden changed since corpus generation; regenerate and verify the corpus.")
    golden_ids = {row.get("id") for row in golden_rows}
    golden_families = {row.get("family") for row in golden_rows}
    golden_prompts = {
        " ".join(unicodedata.normalize("NFKC", str(row.get("prompt", ""))).casefold().split())
        for row in golden_rows
    }
    if ids & golden_ids or (families["train"] | families["validation"]) & golden_families or prompts & golden_prompts:
        raise SystemExit("Creative SFT corpus leaks held-out golden IDs, families, or exact prompts.")
    if manifest.get("heldOutGolden", {}).get("familyOverlap") != [] or manifest.get("heldOutGolden", {}).get("exactPromptOverlap") is not False:
        raise SystemExit("Creative SFT manifest reports a held-out leakage condition.")

    if not all_rows:
        raise SystemExit("Creative SFT corpus is empty.")
    return splits["train"], splits["validation"], prompt_bytes.decode("utf-8"), manifest


def validate_human_reviewed_corpus(
    corpus_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str, dict[str, Any]]:
    """Validate a private human-reviewed corpus compiled by the TypeScript gate."""
    manifest = read_json(corpus_dir / "manifest.json")
    if (
        not isinstance(manifest, dict)
        or manifest.get("formatVersion") != 1
        or manifest.get("task") != "creative-task-v1"
        or manifest.get("synthetic") is not False
        or manifest.get("humanReviewed") is not True
        or manifest.get("eligibleForModelPromotion") is not False
    ):
        raise SystemExit("Unsupported human-reviewed corpus manifest; promotion eligibility must remain false.")
    if not isinstance(manifest.get("sourceCorpusSha256"), str) or not SHA256_PATTERN.fullmatch(manifest["sourceCorpusSha256"]):
        raise SystemExit("Human-reviewed corpus is missing its source corpus hash.")
    if type(manifest.get("sourceRows")) is not int or type(manifest.get("heldOutRowsExcluded")) is not int:
        raise SystemExit("Human-reviewed corpus row provenance is malformed.")
    if manifest["sourceRows"] < 1 or not 0 <= manifest["heldOutRowsExcluded"] < manifest["sourceRows"]:
        raise SystemExit("Human-reviewed corpus has invalid source/held-out counts.")

    source_hashes = manifest.get("sourceHashes")
    if not isinstance(source_hashes, dict) or set(source_hashes) != set(HUMAN_SOURCE_PATHS):
        raise SystemExit("Human-reviewed corpus source hash allowlist is incomplete or unexpected.")
    for relative_path in HUMAN_SOURCE_PATHS:
        try:
            actual = sha256_bytes((ROOT / relative_path).read_bytes())
        except OSError as error:
            raise SystemExit(f"Cannot verify human-corpus source: {relative_path}") from error
        if source_hashes.get(relative_path) != actual:
            raise SystemExit(f"Human-reviewed corpus is stale for source: {relative_path}; recompile it.")

    prompt_bytes = (corpus_dir / "prompt.txt").read_bytes()
    prompt_entry = manifest.get("prompt")
    if (
        not isinstance(prompt_entry, dict)
        or prompt_entry.get("path") != "prompt.txt"
        or prompt_entry.get("sha256") != sha256_bytes(prompt_bytes)
    ):
        raise SystemExit("Human-reviewed system prompt hash mismatch.")

    splits: dict[str, list[dict[str, Any]]] = {}
    ids: set[str] = set()
    prompts: set[str] = set()
    family_by_split: dict[str, set[str]] = {"train": set(), "validation": set()}
    expected_keys = {
        "version", "id", "family", "split", "language", "source", "operation", "prompt", "instruction",
        "response", "consentPurpose", "consentReceiptSha256", "consentRecordedAt",
    }
    split_manifest = manifest.get("splits")
    if not isinstance(split_manifest, dict) or set(split_manifest) != {"train", "validation"}:
        raise SystemExit("Human-reviewed corpus must contain train and validation metadata only; held-out is excluded.")

    for split in ("train", "validation"):
        entry = split_manifest.get(split)
        expected_path = f"{split}.jsonl"
        if not isinstance(entry, dict) or entry.get("path") != expected_path:
            raise SystemExit(f"Invalid human-reviewed {split} split path.")
        rows, raw = read_jsonl(corpus_dir / expected_path)
        if len(rows) != entry.get("rows") or sha256_bytes(raw) != entry.get("sha256"):
            raise SystemExit(f"Human-reviewed {split} split count/hash mismatch; recompile the private corpus.")
        splits[split] = rows
        for row in rows:
            if set(row) != expected_keys or row.get("version") != 1 or row.get("split") != split:
                raise SystemExit(f"Human-reviewed row has an invalid shape/split in {split}.")
            if (
                not isinstance(row.get("id"), str)
                or not CASE_ID_PATTERN.fullmatch(row["id"])
                or not isinstance(row.get("family"), str)
                or not FAMILY_ID_PATTERN.fullmatch(row["family"])
            ):
                raise SystemExit("Human-reviewed row has invalid pseudonymous identity metadata.")
            if row.get("source") != "consented-human-adjudicated-v1" or row.get("language") not in {"en", "sk"}:
                raise SystemExit(f"Human-reviewed row has unexpected source/language metadata: {row['id']}")
            expected_purpose = "model-training" if split == "train" else "evaluation"
            if row.get("consentPurpose") != expected_purpose:
                raise SystemExit(f"Human-reviewed row has consent purpose inconsistent with {split}: {row['id']}")
            if not isinstance(row.get("consentReceiptSha256"), str) or not SHA256_PATTERN.fullmatch(row["consentReceiptSha256"]):
                raise SystemExit(f"Human-reviewed row is missing its consent receipt hash: {row['id']}")
            recorded_at = row.get("consentRecordedAt")
            if not isinstance(recorded_at, str):
                raise SystemExit(f"Human-reviewed row has invalid consent timestamp: {row['id']}")
            try:
                parsed_timestamp = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
            except ValueError as error:
                raise SystemExit(f"Human-reviewed row has invalid consent timestamp: {row['id']}") from error
            if parsed_timestamp.tzinfo is None:
                raise SystemExit(f"Human-reviewed consent timestamp must include a timezone: {row['id']}")
            if (
                not isinstance(row.get("prompt"), str)
                or not row["prompt"].strip()
                or len(row["prompt"]) > 2_048
                or not isinstance(row.get("instruction"), str)
                or row.get("operation") not in {"generate", "revise"}
                or not validate_output(row.get("response"))
            ):
                raise SystemExit(f"Human-reviewed example is malformed: {row['id']}")
            try:
                request = json.loads(row["instruction"])
            except json.JSONDecodeError as error:
                raise SystemExit(f"Human-reviewed request JSON is invalid: {row['id']}") from error
            if (
                not isinstance(request, dict)
                or request.get("version") != 1
                or request.get("operation") != row["operation"]
                or request.get("prompt") != row["prompt"]
                or not valid_for_request(row["response"], request)
            ):
                raise SystemExit(f"Human-reviewed target violates its pinned request context: {row['id']}")
            normalized = " ".join(unicodedata.normalize("NFKC", row["prompt"]).casefold().split())
            if row["id"] in ids or normalized in prompts:
                raise SystemExit("Duplicate human-reviewed case ID or normalized prompt across splits.")
            ids.add(row["id"])
            prompts.add(normalized)
            family_by_split[split].add(row["family"])

        if entry.get("caseIds") != sorted(row["id"] for row in rows):
            raise SystemExit(f"Human-reviewed {split} case ID provenance mismatch.")
        if entry.get("families") != sorted(family_by_split[split]):
            raise SystemExit(f"Human-reviewed {split} family provenance mismatch.")

    if family_by_split["train"] & family_by_split["validation"]:
        raise SystemExit("Human-reviewed train/validation family leakage.")
    if len(ids) + manifest["heldOutRowsExcluded"] != manifest["sourceRows"]:
        raise SystemExit("Human-reviewed source counts do not reconcile with exported splits and excluded held-out rows.")
    if not splits["train"] or not splits["validation"]:
        raise SystemExit("Human-reviewed training requires non-empty train and validation splits.")
    return splits["train"], splits["validation"], prompt_bytes.decode("utf-8"), manifest


def canonical(value: Any, field: str | None = None) -> Any:
    if isinstance(value, dict):
        return {key: canonical(value[key], key) for key in sorted(value)}
    if isinstance(value, list):
        values = [canonical(item) for item in value]
        if field in {"unknownFields", "targetRoles", "preserveRoles", "prohibitedRoles"}:
            return sorted(values)
        return values
    return value


def valid_for_request(prediction: Any, request: dict[str, Any]) -> bool:
    if not validate_output(prediction):
        return False
    if prediction["status"] == "proposal" and request.get("conflicts"):
        return False

    suggestions = prediction["suggestions"]
    if prediction["status"] != "proposal":
        return True

    requirements = request.get("requirements", {})
    preferences = request.get("preferences", {})
    for field, known in (
        ("bpmRange", requirements.get("bpmRange")),
        ("key", requirements.get("key")),
        ("lengthSteps", requirements.get("lengthSteps")),
        ("genre", preferences.get("genre")),
        ("style", preferences.get("style")),
        ("mood", preferences.get("mood")),
        ("energy", preferences.get("energy")),
        ("density", preferences.get("density")),
        ("complexity", preferences.get("complexity")),
        ("variation", preferences.get("variation")),
    ):
        if known is not None and field in suggestions and suggestions[field] != known:
            return False

    ordered_roles = lambda roles: [role for role in ROLE_ORDER if role in roles]
    targets = ordered_roles(suggestions.get("targetRoles", []))
    requested_targets = ordered_roles(requirements.get("targetRoles", []))
    request_preserved = set(request.get("preserveRoles", []))
    request_prohibited = set(request.get("prohibitedRoles", []))
    suggested_preserved = set(suggestions.get("preserveRoles", []))
    suggested_prohibited = set(suggestions.get("prohibitedRoles", []))
    if set(targets) & (request_preserved | request_prohibited | suggested_preserved | suggested_prohibited):
        return False
    if suggested_preserved & (request_prohibited | suggested_prohibited):
        return False
    if suggested_prohibited & request_preserved:
        return False
    if "targetRoles" in suggestions and requested_targets and targets != requested_targets:
        return False

    available_roles = ordered_roles(request.get("projectContext", {}).get("availableRoles", []))
    if available_roles and any(role not in available_roles for role in targets):
        return False
    return True


def collate(batch: list[dict[str, list[int]]], pad_id: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    width = max(len(item["input_ids"]) for item in batch)
    input_ids: list[list[int]] = []
    labels: list[list[int]] = []
    attention: list[list[int]] = []
    for item in batch:
        pad = width - len(item["input_ids"])
        input_ids.append(item["input_ids"] + [pad_id] * pad)
        labels.append(item["labels"] + [-100] * pad)
        attention.append([1] * len(item["input_ids"]) + [0] * pad)
    return (
        torch.tensor(input_ids, dtype=torch.long),
        torch.tensor(labels, dtype=torch.long),
        torch.tensor(attention, dtype=torch.long),
    )


def build_example(tokenizer: Any, system: str, row: dict[str, Any]) -> dict[str, list[int]] | None:
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": row["instruction"]},
    ]
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
    prompt_ids = tokenizer(prompt, add_special_tokens=False).input_ids
    target = json.dumps(row["response"], ensure_ascii=False, separators=(",", ":"))
    target_ids = tokenizer.encode(target, add_special_tokens=False) + [tokenizer.eos_token_id]
    combined = list(prompt_ids) + target_ids
    if len(combined) > MAX_SEQUENCE_LENGTH:
        return None
    return {"input_ids": combined, "labels": [-100] * len(prompt_ids) + target_ids}


@torch.no_grad()
def evaluate(
    model: Any,
    tokenizer: Any,
    system: str,
    rows: list[dict[str, Any]],
    eval_limit: int,
    human_reviewed: bool = False,
) -> dict[str, Any]:
    model.eval()
    selected = rows if eval_limit == 0 else rows[:eval_limit]
    valid = exact = status_correct = role_safety_failures = 0
    by_language: dict[str, dict[str, int]] = {}
    for index, row in enumerate(selected, start=1):
        if index % 8 == 1 or index == len(selected):
            print(f"validation inference {index}/{len(selected)}", flush=True)
        language_metrics = by_language.setdefault(row["language"], {"rows": 0, "valid": 0, "exact": 0, "statusCorrect": 0})
        language_metrics["rows"] += 1
        prompt = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": row["instruction"]},
            ],
            add_generation_prompt=True,
            tokenize=False,
        )
        prompt_ids = tokenizer(prompt, add_special_tokens=False).input_ids
        inputs = torch.tensor([prompt_ids], dtype=torch.long, device=model.device)
        generated = model.generate(
            inputs,
            max_new_tokens=MAX_GENERATION_TOKENS,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
        text = tokenizer.decode(generated[0][len(prompt_ids):], skip_special_tokens=True).strip()
        if len(text) > 16_384:
            continue
        try:
            prediction = json.loads(text)
        except json.JSONDecodeError:
            continue
        request = json.loads(row["instruction"])
        if not valid_for_request(prediction, request):
            if isinstance(prediction, dict) and isinstance(prediction.get("suggestions"), dict):
                targets = set(prediction["suggestions"].get("targetRoles", []))
                protected = set(request.get("preserveRoles", [])) | set(request.get("prohibitedRoles", []))
                if targets & protected:
                    role_safety_failures += 1
            continue
        valid += 1
        language_metrics["valid"] += 1
        if prediction.get("status") == row["response"].get("status"):
            status_correct += 1
            language_metrics["statusCorrect"] += 1
        if canonical(prediction) == canonical(row["response"]):
            exact += 1
            language_metrics["exact"] += 1
    model.train()
    total = len(selected)
    return {
        "rows": total,
        "schemaAndSafetyValid": valid,
        "validRate": valid / total if total else 0.0,
        "exact": exact,
        "exactRate": exact / total if total else 0.0,
        "statusCorrect": status_correct,
        "statusAccuracy": status_correct / total if total else 0.0,
        "roleSafetyFailures": role_safety_failures,
        "byLanguage": {
            language: {
                **metrics,
                "validRate": metrics["valid"] / metrics["rows"] if metrics["rows"] else 0.0,
                "exactRate": metrics["exact"] / metrics["rows"] if metrics["rows"] else 0.0,
            }
            for language, metrics in sorted(by_language.items())
        },
        "syntheticOnly": not human_reviewed,
        "humanReviewed": human_reviewed,
    }


def require_path_within(path: Path, root: Path, label: str) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as error:
        raise SystemExit(f"{label} must remain inside the ignored private human-review directory.") from error
    if resolved == root.resolve():
        raise SystemExit(f"{label} must be a file/directory below the private human-review directory.")
    return resolved


def main() -> None:
    parser = argparse.ArgumentParser(description="Train an experimental, isolated creative-task LoRA adapter.")
    parser.add_argument("--base-model", help="Explicit Hugging Face model ID or local model path; never inferred from the action model.")
    parser.add_argument("--base-revision", help="Pinned model revision/commit (use 'local' for an immutable local snapshot).")
    parser.add_argument("--out-dir", help="Adapter output directory; choose a location with enough free disk.")
    parser.add_argument("--report-out", help="Optional additional path for a pinned JSON report; existing files are never overwritten.")
    parser.add_argument("--corpus-dir", help="Synthetic bootstrap corpus directory; the default is the checked-in synthetic corpus.")
    parser.add_argument("--human-reviewed-corpus-dir", help="Compiled private, consented human corpus directory from the human-training compiler.")
    parser.add_argument("--allow-synthetic-bootstrap", action="store_true", help="Acknowledge the current corpus is synthetic and not promotion-ready.")
    parser.add_argument("--allow-human-reviewed-training", action="store_true", help="Explicitly acknowledge training on consented private human-reviewed examples.")
    parser.add_argument("--validate-only", action="store_true", help="Verify corpus, prompt/source pins and leakage without loading a model or using the GPU.")
    parser.add_argument("--allow-model-download", action="store_true", help="Explicitly permit Transformers to download missing model/tokenizer files; off by default.")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--accum", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--eval-limit", type=int, default=0, help="0 evaluates the entire validation split.")
    parser.add_argument("--dtype", choices=("auto", "bf16", "fp16"), default="auto")
    args = parser.parse_args()
    human_reviewed = bool(args.human_reviewed_corpus_dir)
    if args.human_reviewed_corpus_dir and args.corpus_dir:
        raise SystemExit("Choose either --corpus-dir or --human-reviewed-corpus-dir, not both.")
    if human_reviewed:
        if args.allow_synthetic_bootstrap:
            raise SystemExit("--allow-synthetic-bootstrap cannot be used with a human-reviewed corpus.")
        if not args.allow_human_reviewed_training and not args.validate_only:
            raise SystemExit("Refusing human-reviewed training without --allow-human-reviewed-training.")
    else:
        if args.allow_human_reviewed_training:
            raise SystemExit("--allow-human-reviewed-training requires --human-reviewed-corpus-dir.")
        if not args.allow_synthetic_bootstrap and not args.validate_only:
            raise SystemExit("Refusing to train synthetic-only labels without --allow-synthetic-bootstrap.")
    if not args.validate_only and (not args.base_model or not args.base_model.strip() or not args.base_revision or not args.base_revision.strip()):
        raise SystemExit("Training requires both --base-model and --base-revision; neither is inferred from the action model.")
    if not args.validate_only and (not args.out_dir or not args.out_dir.strip()):
        raise SystemExit("Training requires an explicit --out-dir.")
    if args.epochs < 1 or args.batch < 1 or args.accum < 1 or args.lora_r < 1 or args.lora_alpha < 1 or args.eval_limit < 0:
        raise SystemExit("Invalid training arguments.")
    if not math.isfinite(args.lr) or not 0 < args.lr <= 1e-2:
        raise SystemExit("--lr must be finite and in (0, 0.01].")

    private_review_root = (ROOT / ".sft" / "creative-human-review").resolve()
    private_derived_root = private_review_root / "derived"
    corpus_dir = Path(args.human_reviewed_corpus_dir or args.corpus_dir or DEFAULT_CORPUS).resolve()
    if human_reviewed:
        corpus_dir = require_path_within(corpus_dir, private_derived_root, "Human-reviewed corpus input")
        train_rows, validation_rows, system, _manifest = validate_human_reviewed_corpus(corpus_dir)
    else:
        train_rows, validation_rows, system, _manifest = validate_corpus(corpus_dir)
    if args.validate_only:
        kind = "consented human-reviewed" if human_reviewed else "synthetic bootstrap"
        held_out_note = f"; held-out rows excluded={_manifest['heldOutRowsExcluded']}" if human_reviewed else "; held-out leakage checks passed"
        print(
            f"Creative SFT trainer validation passed ({kind}): train={len(train_rows)} rows/"
            f"{len(_manifest['splits']['train']['families'])} families, validation={len(validation_rows)} rows/"
            f"{len(_manifest['splits']['validation']['families'])} families; prompt/source pins"
            f"{held_out_note}; no model/GPU loaded."
        )
        return
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for this explicit LoRA recipe; no CPU fallback is attempted.")
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    free_gib = free_bytes / (1024**3)
    print(f"GPU: {torch.cuda.get_device_name(0)}; free VRAM {free_gib:.2f}/{total_bytes / (1024**3):.2f} GiB")
    if free_gib < 4.0:
        raise SystemExit("Need at least 4 GiB free VRAM; refusing to compete with or evict another active GPU workload.")

    random.seed(SEED)
    torch.manual_seed(SEED)
    output_dir = Path(args.out_dir).resolve()
    if human_reviewed:
        output_dir = require_path_within(output_dir, private_derived_root, "Human-reviewed adapter output")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise SystemExit(f"Output directory is not empty; refusing to overwrite user data: {output_dir}")
    report_out = Path(args.report_out).resolve() if args.report_out else None
    if human_reviewed and report_out is not None:
        report_out = require_path_within(report_out, private_derived_root, "Human-reviewed report output")
    if report_out is not None and report_out.exists():
        raise SystemExit(f"Report output already exists; refusing to overwrite user data: {report_out}")
    output_dir.mkdir(parents=True, exist_ok=True)
    dtype = torch.bfloat16 if args.dtype == "bf16" or (args.dtype == "auto" and torch.cuda.is_bf16_supported()) else torch.float16
    tokenizer = AutoTokenizer.from_pretrained(
        args.base_model,
        revision=None if args.base_revision == "local" else args.base_revision,
        local_files_only=not args.allow_model_download,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        revision=None if args.base_revision == "local" else args.base_revision,
        torch_dtype=dtype,
        attn_implementation="sdpa",
        local_files_only=not args.allow_model_download,
    ).to("cuda")
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()
    model = get_peft_model(
        model,
        LoraConfig(
            r=args.lora_r,
            lora_alpha=args.lora_alpha,
            lora_dropout=0.05,
            target_modules="all-linear",
            task_type="CAUSAL_LM",
        ),
    )
    model.print_trainable_parameters()

    examples = [example for row in train_rows if (example := build_example(tokenizer, system, row)) is not None]
    validation_examples = [row for row in validation_rows if build_example(tokenizer, system, row) is not None]
    if len(examples) < 8 or len(validation_examples) < 4:
        raise SystemExit("Too few examples fit the model context; increase data quality or sequence budget before training.")
    print(
        f"{('human-reviewed' if human_reviewed else 'synthetic')} examples: "
        f"train={len(examples)}/{len(train_rows)}, validation={len(validation_examples)}/{len(validation_rows)}; "
        f"validation max_new_tokens={MAX_GENERATION_TOKENS}",
        flush=True,
    )

    pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
    trainable = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=args.lr, weight_decay=0.01, betas=(0.9, 0.95))
    effective_batch = args.batch * args.accum
    steps_per_epoch = math.ceil(len(examples) / effective_batch)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer,
        max_lr=args.lr,
        total_steps=steps_per_epoch * args.epochs,
        pct_start=one_cycle_warmup_fraction(steps_per_epoch * args.epochs),
    )
    report: dict[str, Any] = {
        "reportVersion": 3,
        "datasetKind": "consented-human-reviewed" if human_reviewed else "synthetic-bootstrap",
        "task": "creative-task-v1",
        "baseModel": args.base_model,
        "baseRevision": args.base_revision,
        "baseModelResolvedRevision": getattr(model.config, "_commit_hash", None),
        "modelDownloadAllowed": args.allow_model_download,
        "corpusManifestSha256": sha256_bytes((corpus_dir / "manifest.json").read_bytes()),
        "trainJsonlSha256": _manifest["splits"]["train"]["sha256"],
        "validationJsonlSha256": _manifest["splits"]["validation"]["sha256"],
        "systemPromptSha256": _manifest["prompt"]["sha256"],
        "dtype": str(dtype),
        "validationMaxNewTokens": MAX_GENERATION_TOKENS,
        "syntheticOnly": not human_reviewed,
        "humanReviewed": human_reviewed,
        "eligibleForModelPromotion": False,
        "trainRows": len(train_rows),
        "validationRows": len(validation_rows),
        "trainExamples": len(examples),
        "epochs": args.epochs,
        "loraR": args.lora_r,
        "loraAlpha": args.lora_alpha,
        "learningRate": args.lr,
        "trainingHistory": [],
    }
    if human_reviewed:
        report.update(
            {
                "sourceCorpusSha256": _manifest["sourceCorpusSha256"],
                "heldOutRowsExcluded": _manifest["heldOutRowsExcluded"],
                "trainCaseIds": sorted(row["id"] for row in train_rows),
                "validationCaseIds": sorted(row["id"] for row in validation_rows),
                "trainingConsentPurpose": "model-training",
                "validationConsentPurpose": "evaluation",
                "heldOutUsed": False,
                "rawPromptsLogged": False,
            }
        )

    for epoch in range(args.epochs):
        random.shuffle(examples)
        model.train()
        total_loss = 0.0
        batches = 0
        for step_index, group_start in enumerate(range(0, len(examples), effective_batch), start=1):
            group = examples[group_start : group_start + effective_batch]
            micro_batches = [group[start : start + args.batch] for start in range(0, len(group), args.batch)]
            optimizer.zero_grad(set_to_none=True)
            group_size = len(group)
            for micro_batch in micro_batches:
                input_ids, labels, attention = collate(micro_batch, pad_id)
                input_ids = input_ids.to("cuda")
                labels = labels.to("cuda")
                attention = attention.to("cuda")
                loss = model(input_ids=input_ids, labels=labels, attention_mask=attention).loss
                (loss * (len(micro_batch) / group_size)).backward()
                total_loss += float(loss.detach())
                batches += 1
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            optimizer.step()
            scheduler.step()
            print(f"epoch {epoch + 1}/{args.epochs} train step {step_index}/{steps_per_epoch}", flush=True)

        epoch_result = {"epoch": epoch + 1, "meanTrainLoss": total_loss / max(1, batches)}
        report["trainingHistory"].append(epoch_result)
        print(f"epoch {epoch_result['epoch']}/{args.epochs}: {json.dumps(epoch_result, sort_keys=True)}", flush=True)

    validation = evaluate(model, tokenizer, system, validation_rows, args.eval_limit, human_reviewed=human_reviewed)
    validation["afterEpoch"] = args.epochs
    report["validationFinal"] = validation
    if human_reviewed:
        report["notes"] = [
            "Human-reviewed validation interpretation scores do not measure musical quality or prove production usefulness.",
            "The held-out split was not exported to this training corpus; validation rows are evaluation-only and never optimized as targets.",
            "No action resolver/UI registration, model promotion, or merged model export is performed; release still requires held-out human evaluation and blind listening.",
        ]
    else:
        report["notes"] = [
            "Synthetic bootstrap validation is not evidence of real-producer understanding or musical quality.",
            "No action resolver/UI registration, model promotion, or merged model export is performed.",
            "Promotion requires a consented human-reviewed held-out set, blind listening, and separate release gates.",
        ]
    adapter_dir = output_dir / "adapter"
    model.save_pretrained(str(adapter_dir), save_embedding_layers=False)
    tokenizer.save_pretrained(str(adapter_dir))
    report["adapterModelSha256"] = sha256_bytes((adapter_dir / "adapter_model.safetensors").read_bytes())
    report_path = output_dir / "report.json"
    serialized_report = json.dumps(report, indent=2) + "\n"
    report_path.write_text(serialized_report, encoding="utf-8")
    if report_out is not None:
        report_out.parent.mkdir(parents=True, exist_ok=True)
        report_out.write_text(serialized_report, encoding="utf-8")
    print(f"adapter: {adapter_dir}")
    print(f"report: {report_path}")
    if report_out is not None:
        print(f"pinned report: {report_out}")
    print("This experiment is not promotion-eligible.")


if __name__ == "__main__":
    main()
