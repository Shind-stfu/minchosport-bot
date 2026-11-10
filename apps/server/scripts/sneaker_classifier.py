#!/usr/bin/env python3
"""Classify one image locally. Image bytes arrive via stdin; stdout is JSON only."""
import json
import os
import sys
from io import BytesIO

os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

try:
    from PIL import Image, ImageOps
    import torch
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    model_id = 'dima806/popular_sneakers_detection'
    revision = 'c978c26b9ba3c779c34f04a8498f0af80e2148da'
    processor = AutoImageProcessor.from_pretrained(model_id, revision=revision)
    model = AutoModelForImageClassification.from_pretrained(model_id, revision=revision)
    model.eval()
    image = ImageOps.exif_transpose(Image.open(BytesIO(sys.stdin.buffer.read()))).convert('RGB')
    with torch.inference_mode():
        probabilities = model(**processor(images=image, return_tensors='pt')).logits.softmax(dim=-1)[0]
    print(json.dumps([{'label': model.config.id2label[i], 'score': float(score)} for i, score in enumerate(probabilities)]))
except Exception as exc:
    print(str(exc)[:300], file=sys.stderr)
    sys.exit(1)
