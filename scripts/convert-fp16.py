"""Optional: halve the Style-BERT-VITS2 acoustic model (265 MB -> 142 MB) with almost identical output.

    pip install onnx onnxruntime
    python3 scripts/convert-fp16.py models/sbv2-tsukuyomi/model.onnx models/sbv2-tsukuyomi/model-fp16.onnx
"""
import sys

import onnx
from onnxruntime.transformers.float16 import convert_float_to_float16

src, dst = sys.argv[1], sys.argv[2]
model = onnx.load(src)
onnx.save(convert_float_to_float16(model, keep_io_types=True, disable_shape_infer=False), dst)
print(f"wrote {dst}")
