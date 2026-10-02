"""Paired, local-only base-versus-LoRA evaluation on one creative-task split."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
TRAINER_PATH = ROOT / "scripts" / "train-creative-task-sft.py"
SPEC = importlib.util.spec_from_file_location("creative_task_sft_trainer", TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not import creative SFT trainer: {TRAINER_PATH}")
TRAINER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAINER)
MIN_FREE_VRAM_GIB = 4.0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_report(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise SystemExit(f"Cannot read training report {path}: {error}") from error
    if len(raw) > 1024 * 1024:
        raise SystemExit("Training report exceeds 1 MiB.")
    try:
        report = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Training report is not valid UTF-8 JSON: {error}") from error
    if not isinstance(report, dict):
        raise SystemExit("Training report must be a JSON object.")
    return report


def preflight(training_report_path: Path, adapter_dir: Path, corpus_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    report = read_report(training_report_path)
    required = {
        "task": "creative-task-v1",
        "modelDownloadAllowed": False,
        "syntheticOnly": True,
        "humanReviewed": False,
        "eligibleForModelPromotion": False,
    }
    for field, expected in required.items():
        if report.get(field) != expected:
            raise SystemExit(f"Refusing comparison: training report {field} must be {expected!r}.")
    base_model = report.get("baseModel")
    revision = report.get("baseModelResolvedRevision")
    adapter_hash = report.get("adapterModelSha256")
    if not isinstance(base_model, str) or not base_model or not isinstance(revision, str) or len(revision) != 40:
        raise SystemExit("Training report must pin a local base-model ID and 40-character resolved revision.")
    if not isinstance(adapter_hash, str) or len(adapter_hash) != 64:
        raise SystemExit("Training report must pin the adapter model SHA-256.")

    manifest_path = corpus_dir / "manifest.json"
    manifest_hash = sha256_file(manifest_path)
    train_rows, validation_rows, system_prompt, _manifest = TRAINER.validate_corpus(corpus_dir)
    if manifest_hash != report.get("corpusManifestSha256"):
        raise SystemExit("Corpus manifest differs from the one used by the training report.")
    if sha256_file(corpus_dir / "train.jsonl") != report.get("trainJsonlSha256"):
        raise SystemExit("Training split differs from the one used by the training report.")
    if sha256_file(corpus_dir / "validation.jsonl") != report.get("validationJsonlSha256"):
        raise SystemExit("Validation split differs from the one used by the training report.")
    if hashlib.sha256(system_prompt.encode("utf-8")).hexdigest() != report.get("systemPromptSha256"):
        raise SystemExit("Creative-task system prompt differs from the training report.")
    if len(train_rows) != report.get("trainRows") or len(validation_rows) != report.get("validationRows"):
        raise SystemExit("Training report row counts differ from the validated corpus.")

    adapter_path = adapter_dir / "adapter_model.safetensors"
    if not adapter_path.is_file() or sha256_file(adapter_path) != adapter_hash:
        raise SystemExit("Adapter file is missing or its SHA-256 differs from the training report.")
    if not (adapter_dir / "adapter_config.json").is_file():
        raise SystemExit("Adapter configuration is missing.")

    try:
        config = AutoConfig.from_pretrained(base_model, revision=revision, local_files_only=True)
    except Exception as error:
        raise SystemExit(f"Pinned base-model config is not available locally: {error}") from error
    if getattr(config, "_commit_hash", None) != revision:
        raise SystemExit("Locally resolved base model does not match the training report revision.")

    checks = {
        "trainingReport": sha256_file(training_report_path),
        "corpusManifest": manifest_hash,
        "trainRows": len(train_rows),
        "validationRows": len(validation_rows),
        "systemPromptSha256": report["systemPromptSha256"],
        "baseModel": base_model,
        "baseModelRevision": revision,
        "adapterModelSha256": adapter_hash,
        "syntheticOnly": True,
        "modelDownloadAllowed": False,
    }
    return checks, validation_rows, system_prompt


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare the exact base LFM and its creative-task LoRA on the same split.")
    parser.add_argument("--training-report", required=True, help="Pinned report.json from creative-task SFT training.")
    parser.add_argument("--adapter-dir", required=True, help="Local adapter directory from that training run.")
    parser.add_argument("--corpus-dir", default=str(TRAINER.DEFAULT_CORPUS))
    parser.add_argument("--report-out", help="Optional JSON report path; existing files are never overwritten.")
    parser.add_argument("--limit", type=int, default=0, help="Optional partial smoke; 0 evaluates the complete held-out split.")
    parser.add_argument("--preflight-only", action="store_true", help="Verify all pins without loading weights or using the GPU.")
    args = parser.parse_args()
    if args.limit < 0:
        raise SystemExit("--limit must be zero or a positive integer.")

    training_report_path = Path(args.training_report).resolve()
    adapter_dir = Path(args.adapter_dir).resolve()
    corpus_dir = Path(args.corpus_dir).resolve()
    report_out = Path(args.report_out).resolve() if args.report_out else None
    if report_out is not None and report_out.exists():
        raise SystemExit(f"Report output already exists; refusing to overwrite user data: {report_out}")
    checks, validation_rows, system_prompt = preflight(training_report_path, adapter_dir, corpus_dir)
    if args.preflight_only:
        print(json.dumps({"comparisonVersion": 1, "preflight": checks, "inferenceStarted": False}, indent=2))
        return

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required; no CPU fallback is attempted for paired model inference.")
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    free_gib = free_bytes / (1024**3)
    if free_gib < MIN_FREE_VRAM_GIB:
        raise SystemExit(
            f"Need at least {MIN_FREE_VRAM_GIB:.1f} GiB free VRAM; found {free_gib:.2f}/{total_bytes / (1024**3):.2f} GiB. "
            "Refusing to compete with an active GPU model."
        )

    training_report = read_report(training_report_path)
    revision = training_report["baseModelResolvedRevision"]
    tokenizer = AutoTokenizer.from_pretrained(
        training_report["baseModel"], revision=revision, local_files_only=True
    )
    dtype = torch.bfloat16 if training_report.get("dtype") == "torch.bfloat16" else torch.float16
    base_model = AutoModelForCausalLM.from_pretrained(
        training_report["baseModel"],
        revision=revision,
        torch_dtype=dtype,
        attn_implementation="sdpa",
        local_files_only=True,
    ).to("cuda")
    base_model.eval()
    evaluation_limit = args.limit
    print(f"base model inference: {evaluation_limit or len(validation_rows)} validation cases", flush=True)
    base_metrics = TRAINER.evaluate(base_model, tokenizer, system_prompt, validation_rows, evaluation_limit)

    tuned_model = PeftModel.from_pretrained(base_model, str(adapter_dir), is_trainable=False, local_files_only=True)
    tuned_model.eval()
    print(f"LoRA inference: {evaluation_limit or len(validation_rows)} validation cases", flush=True)
    tuned_metrics = TRAINER.evaluate(tuned_model, tokenizer, system_prompt, validation_rows, evaluation_limit)

    result = {
        "comparisonVersion": 1,
        "task": "creative-task-v1",
        "taskBoundary": "synthetic creative-brief interpretation only; not musical-quality evaluation",
        "preflight": checks,
        "evaluation": {
            "requestedCases": evaluation_limit or len(validation_rows),
            "totalValidationCases": len(validation_rows),
            "completeRun": evaluation_limit == 0 or evaluation_limit >= len(validation_rows),
            "maxNewTokens": TRAINER.MAX_GENERATION_TOKENS,
            "base": base_metrics,
            "creativeSft": tuned_metrics,
            "delta": {
                "schemaAndSafetyValid": tuned_metrics["schemaAndSafetyValid"] - base_metrics["schemaAndSafetyValid"],
                "exact": tuned_metrics["exact"] - base_metrics["exact"],
                "statusCorrect": tuned_metrics["statusCorrect"] - base_metrics["statusCorrect"],
                "roleSafetyFailures": tuned_metrics["roleSafetyFailures"] - base_metrics["roleSafetyFailures"],
            },
        },
        "eligibleForModelPromotion": False,
    }
    serialized = json.dumps(result, indent=2) + "\n"
    if report_out is None:
        print(serialized, end="")
    else:
        report_out.parent.mkdir(parents=True, exist_ok=True)
        report_out.write_text(serialized, encoding="utf-8")
        print(f"paired comparison report: {report_out}")


if __name__ == "__main__":
    main()
