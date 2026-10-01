"""LOCAL INTENT MODEL — SFT FINE-TUNE (pipeline step [C] artifact).

Fine-tunes LiquidAI/LFM2-1.2B on the engine-generated SFT corpus
(scripts/data/intent-sft/train.jsonl, teacher = the deterministic intent
layer) so the model emits canonical KYX action JSON WITHOUT few-shot
guessing. Desktop training profile: RTX 3060 6 GB, plain bf16 LoRA (the
1.2B model fits without quantization — no bitsandbytes dependency).

Contract with the runtime (tests/intent-model-sft-prompt.test.ts pins this):
  - the system prompt is scripts/data/intent-sft/prompt.txt, byte-identical
    to the Ollama provider's ollamaSystemPrompt();
  - the completion target is the corpus response JSON exactly as the
    resolver bridge expects it (validateModelAction-compatible);
  - eval during training greedy-generates VAL rows and scores canonical
    exact/kindOK against the teacher — the same yardstick as
    scripts/validate-intent-model.mts uses for the ONNX student.

Output (default D:/pulse-forge/.sft/work — gitignored, disk-heavy):
  adapter/     LoRA adapter (peft)
  merged/      merged bf16 model for GGUF conversion
Report: scripts/data/intent-sft/sft-report.json

Setup (one-time, Python 3.12 venv on D: — C: is too full):
  py -3.12 -m venv D:/pulse-forge/.sft/venv
  D:/pulse-forge/.sft/venv/Scripts/python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu124
  D:/pulse-forge/.sft/venv/Scripts/python.exe -m pip install transformers peft accelerate gguf huggingface_hub
Run:
  D:/pulse-forge/.sft/venv/Scripts/python.exe scripts/train-intent-sft.py
"""
from __future__ import annotations

import argparse
import json
import random
import re
import unicodedata
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
SFT_DIR = ROOT / "scripts" / "data" / "intent-sft"
DEFAULT_OUT = Path("D:/pulse-forge/.sft/work")
DEFAULT_BASE = "LiquidAI/LFM2-1.2B"

SEED = 0x5EED
MAX_LEN = 1024
STRIP_KEYS = {"detected", "sourceText", "matchedBy"}
WRAPPER_KEYS = ("intent", "preset", "parse")


def flatten_action(action: dict) -> dict:
    """The runtime contract is FLAT: Ollama's JSON schema (toJsonObjectSchema)
    and the resolver adapters read root-level slots, and the SFT prompt's
    few-shot examples are flat. The corpus stores the canonical teacher form
    (nested {kind, intent}) — flatten here so the model TRAINES on the shape
    it must EMIT (tests/intent-model-resolver.test.ts pins flat fakes)."""
    if not isinstance(action, dict):
        return action
    for key in WRAPPER_KEYS:
        nested = action.get(key)
        if isinstance(nested, dict):
            return {"kind": action.get("kind"), **nested}
    return action


def canonical(value):
    """Mirror of src/intent/model-decoder.ts canonicalModelJson: strip
    engine-filled keys, sort arrays, sort object keys."""
    if isinstance(value, list):
        items = sorted(canonical(item) for item in value)
        return "[" + ",".join(items) + "]"
    if isinstance(value, dict):
        keys = sorted(k for k in value.keys() if k not in STRIP_KEYS)
        return "{" + ",".join(json.dumps(k) + ":" + canonical(value[k]) for k in keys) + "}"
    return json.dumps(value)


def load_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def build_example(tokenizer, system: str, instruction: str, completion: str):
    """Prompt = chat template over system+user; loss on the assistant JSON + eos only."""
    prompt_messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": instruction},
    ]
    prompt_text = tokenizer.apply_chat_template(prompt_messages, add_generation_prompt=True, tokenize=False)
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False).input_ids
    completion_ids = tokenizer.encode(completion, add_special_tokens=False) + [tokenizer.eos_token_id]
    input_ids = list(prompt_ids) + completion_ids
    if len(input_ids) > MAX_LEN:
        return None
    labels = [-100] * len(prompt_ids) + completion_ids
    return {"input_ids": input_ids, "labels": labels}


def collate(batch, pad_id: int):
    length = max(len(item["input_ids"]) for item in batch)
    input_ids, labels, attention = [], [], []
    for item in batch:
        pad = length - len(item["input_ids"])
        input_ids.append(item["input_ids"] + [pad_id] * pad)
        labels.append(item["labels"] + [-100] * pad)
        attention.append([1] * len(item["input_ids"]) + [0] * pad)
    return (
        torch.tensor(input_ids, dtype=torch.long),
        torch.tensor(labels, dtype=torch.long),
        torch.tensor(attention, dtype=torch.long),
    )


@torch.no_grad()
def val_exact(model, tokenizer, system: str, rows: list[dict], limit: int = 60) -> dict:
    """Greedy-generate VAL rows and score against the teacher."""
    model.eval()
    exact = kind_ok = total = 0
    for row in rows[:limit]:
        prompt_text = tokenizer.apply_chat_template(
            [{"role": "system", "content": system}, {"role": "user", "content": row["instruction"]}],
            add_generation_prompt=True,
            tokenize=False,
        )
        prompt_ids = list(tokenizer(prompt_text, add_special_tokens=False).input_ids)
        ids = torch.tensor([prompt_ids], device=model.device)
        out = model.generate(ids, max_new_tokens=224, do_sample=False, pad_token_id=tokenizer.eos_token_id)
        text = tokenizer.decode(out[0][len(prompt_ids):], skip_special_tokens=True).strip()
        total += 1
        try:
            parsed = json.loads(re.sub(r"^[^[{]*", "", text))
        except Exception:
            continue
        truth = flatten_action(row["response"])
        if parsed.get("kind") == truth.get("kind"):
            kind_ok += 1
        if canonical(parsed) == canonical(truth):
            exact += 1
    model.train()
    return {"rows": total, "exact": exact, "kindOK": kind_ok}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", default=DEFAULT_BASE)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--accum", type=int, default=4)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank (recipe wave: 32)")
    parser.add_argument("--lora-alpha", type=int, default=32, help="LoRA alpha (recipe wave: 64 = 2×r)")
    parser.add_argument("--val-limit", type=int, default=60)
    parser.add_argument("--sft-dir", default=str(SFT_DIR), help="corpus dir (train.jsonl/val.jsonl/prompt.txt)")
    args = parser.parse_args()

    random.seed(SEED)
    torch.manual_seed(SEED)

    sft_dir = Path(args.sft_dir)
    system = (sft_dir / "prompt.txt").read_text(encoding="utf8")
    if not system.strip():
        raise SystemExit("prompt.txt is empty — run scripts/write-intent-sft-prompt.mts first")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model, torch_dtype=torch.bfloat16, attn_implementation="sdpa"
    ).to("cuda")
    model.config.use_cache = False
    model.gradient_checkpointing_enable()

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, peft_config)
    model.print_trainable_parameters()

    train_rows = load_rows(sft_dir / "train.jsonl")
    val_rows = load_rows(sft_dir / "val.jsonl")
    examples = []
    for row in train_rows:
        target = flatten_action(row["response"])
        example = build_example(tokenizer, system, row["instruction"], json.dumps(target, ensure_ascii=False))
        if example is not None:
            examples.append(example)
    print(f"train examples: {len(examples)}/{len(train_rows)} (skipped over {MAX_LEN} tokens)")

    pad_id = tokenizer.pad_token_id or tokenizer.eos_token_id
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01, betas=(0.9, 0.95))
    steps_per_epoch = max(1, len(examples) // (args.batch * args.accum))
    total_steps = steps_per_epoch * args.epochs
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=total_steps, pct_start=0.05
    )

    report = {
        "baseModel": args.base_model,
        "trainExamples": len(examples),
        "epochs": args.epochs,
        "loraR": args.lora_r,
        "loraAlpha": args.lora_alpha,
        "lr": args.lr,
    }
    step = 0
    for epoch in range(args.epochs):
        random.shuffle(examples)
        model.train()
        running = 0.0
        for batch_start in range(0, len(examples) - args.batch + 1, args.batch):
            input_ids, labels, attention = collate(examples[batch_start : batch_start + args.batch], pad_id)
            input_ids, labels, attention = input_ids.to("cuda"), labels.to("cuda"), attention.to("cuda")
            loss = model(input_ids=input_ids, labels=labels, attention_mask=attention).loss / args.accum
            loss.backward()
            running += float(loss.detach()) * args.accum
            if (batch_start // args.batch + 1) % args.accum == 0:
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
                if step % 20 == 0:
                    print(f"epoch {epoch + 1} step {step}/{total_steps} loss {running / (20 * args.accum):.4f}")
                    running = 0.0
        metrics = val_exact(model, tokenizer, system, val_rows, args.val_limit)
        metrics.update({"epoch": epoch + 1, "trainLoss": running})
        print(f"== epoch {epoch + 1} val: {metrics}")
        report.setdefault("valHistory", []).append(metrics)

    report["valFinal"] = report["valHistory"][-1]

    adapter_dir = out_dir / "adapter"
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))

    merged = model.merge_and_unload()
    merged_dir = out_dir / "merged"
    merged.save_pretrained(str(merged_dir))
    tokenizer.save_pretrained(str(merged_dir))

    (SFT_DIR / "sft-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(f"adapter: {adapter_dir}")
    print(f"merged:  {merged_dir}  (next: convert_hf_to_gguf → ollama create)")


if __name__ == "__main__":
    main()
