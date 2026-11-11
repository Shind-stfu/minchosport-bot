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
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    def predict(on_device):
        model.to(on_device)
        inputs = processor(images=image, return_tensors='pt').to(on_device)
        with torch.inference_mode():
            return model(**inputs).logits.softmax(dim=-1)[0].cpu()

    try:
        probabilities = predict(device)
        device_name = str(device)
    except RuntimeError:
        if device.type != 'cuda':
            raise
        torch.cuda.empty_cache()
        probabilities = predict(torch.device('cpu'))
        device_name = 'cpu (respaldo tras error CUDA)'

    print(json.dumps({
        'device': device_name,
        'results': [{'label': model.config.id2label[i], 'score': float(score)} for i, score in enumerate(probabilities)],
    }))
except Exception as exc:
    print(str(exc)[:300], file=sys.stderr)
    sys.exit(1)
