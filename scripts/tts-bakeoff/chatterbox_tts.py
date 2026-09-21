"""Chatterbox (Resemble AI, MIT, local). Run with .venv-chatterbox.

  python chatterbox_tts.py                 # built-in default voice
  python chatterbox_tts.py ref/me.wav me   # zero-shot clone of a ~10-20 s reference clip
"""
import sys, pathlib, torch, torchaudio as ta
from common import scenes, OUT

device = "mps" if torch.backends.mps.is_available() else "cpu"
_load = torch.load  # checkpoints were saved on CUDA; remap for Apple silicon / CPU
torch.load = lambda *a, **kw: _load(*a, **{**kw, "map_location": torch.device(device)})

from chatterbox.tts import ChatterboxTTS  # noqa: E402

ref = sys.argv[1] if len(sys.argv) > 1 else None
tag = sys.argv[2] if len(sys.argv) > 2 else "default"
if ref and not pathlib.Path(ref).exists():
    raise SystemExit(f"reference clip {ref} not found")

print(f"  loading Chatterbox on {device} ...")
model = ChatterboxTTS.from_pretrained(device=device)
torch.manual_seed(0)
gap = torch.zeros(1, int(0.30 * model.sr))
parts = []
for i, text in enumerate(scenes(), 1):
    wav = model.generate(text, audio_prompt_path=ref, exaggeration=0.45, cfg_weight=0.5)
    parts += [wav.cpu(), gap]
    print(f"  scene {i}/5 ok")
out = torch.cat(parts, dim=1)
path = OUT / f"4-chatterbox-{tag}.wav"
ta.save(str(path), out, model.sr)
print(f"  wrote {path.name}: {out.shape[1]/model.sr:.1f}s, 5 model calls, rate {model.sr}")
