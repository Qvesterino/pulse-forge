"""Quantize the v16 gated challenger (dynamic INT8) into a candidate dir.

Model wave, INT8 follow-up: the v16 artifact passes the original release
gate with wide margins (97.9% / 0 / 9.9%), so the 3.9x size reduction gets
its own gate run. Nothing is promoted here — the validator decides."""
from pathlib import Path
from shutil import copyfile

from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parent.parent
CHALL = ROOT / ".sft" / "intent-model-v16-challenger"
QUANT = ROOT / ".sft" / "intent-model-v16-quant"

QUANT.mkdir(parents=True, exist_ok=True)

src = CHALL / "intent-model-v1.onnx"
dst = QUANT / "intent-model-v1.onnx"

quantize_dynamic(
    model_input=str(src),
    model_output=str(dst),
    weight_type=QuantType.QInt8,
    per_channel=False,
    reduce_range=False,
)

for name in ("intent-model-v1.vocab.json", "intent-model-report.json"):
    if (CHALL / name).exists():
        copyfile(CHALL / name, QUANT / name)

print("float bytes:", src.stat().st_size)
print("int8 bytes :", dst.stat().st_size)
