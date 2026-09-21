"""Kokoro-82M via kokoro-onnx (local, CPU, Apache-2.0). Run with .venv-kokoro."""
import sys, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
from common import scenes, OUT

k = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
text = "\n\n".join(scenes())
for voice in (sys.argv[1:] or ["af_heart", "am_michael", "bm_george"]):
    samples, rate = k.create(text, voice=voice, speed=1.0, lang="en-us")
    path = OUT / f"3-kokoro-{voice}.wav"
    sf.write(path, samples, rate, subtype="PCM_16")
    print(f"  wrote {path.name}: {len(samples)/rate:.1f}s, 1 model call, rate {rate}")
