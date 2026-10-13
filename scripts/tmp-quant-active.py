"""Quantize the ACTIVE intent model (dynamic INT8) into a candidate dir.

Hum-to-Beat campaign / model wave, Track A: the SHIPPED float model is the
teacher-gated artifact — quantizing IT keeps every gate property of the
active model while shrinking the download. The challenger (new corpus) is
Track B and iterates separately.
"""
from pathlib import Path
from shutil import copyfile

from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "models"
DST = ROOT / ".sft" / "intent-model-quant"

DST.mkdir(parents=True, exist_ok=True)

src_onnx = SRC / "intent-model-v1.onnx"
dst_onnx = DST / "intent-model-v1.onnx"

quantize_dynamic(
    model_input=str(src_onnx),
    model_output=str(dst_onnx),
    weight_type=QuantType.QInt8,
    per_channel=False,
    reduce_range=False,
)

# vocab + current manifest ride along so the validator/browser verifier can
# run the directory as-is (the manifest hash gets rewritten for the quantized
# model by write-intent-model-manifest.mts --model-dir).
copyfile(SRC / "intent-model-v1.vocab.json", DST / "intent-model-v1.vocab.json")
copyfile(SRC / "intent-model-v1.manifest.json", DST / "intent-model-v1.manifest.json")

print("float bytes:", src_onnx.stat().st_size)
print("int8 bytes :", dst_onnx.stat().st_size)
