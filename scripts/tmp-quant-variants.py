"""Quant variants for the gated challenger: per-channel and QUInt8 weight
types. Each lands in its own dir so the validator can gate them separately."""
from pathlib import Path
from shutil import copyfile

from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parent.parent
CHALL = ROOT / ".sft" / "intent-model-challenger"

VARIANTS = [
    ("perchannel", dict(weight_type=QuantType.QInt8, per_channel=True, reduce_range=False)),
    ("quint8", dict(weight_type=QuantType.QUInt8, per_channel=False, reduce_range=False)),
]

for name, kwargs in VARIANTS:
    out = ROOT / ".sft" / f"intent-model-quant-{name}"
    out.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(CHALL / "intent-model-v1.onnx"),
        model_output=str(out / "intent-model-v1.onnx"),
        **kwargs,
    )
    for name_ in ("intent-model-v1.vocab.json", "intent-model-report.json"):
        if (CHALL / name_).exists():
            copyfile(CHALL / name_, out / name_)
    print(name, "bytes:", (out / "intent-model-v1.onnx").stat().st_size)
