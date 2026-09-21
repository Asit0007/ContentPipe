"""Objective checks on every clip in out/. Run with .venv-analyze.

What this CAN tell you: did it say the right words (incl. tags read aloud), how did it say the CVE id,
pace, pause structure, pitch movement. What it CANNOT tell you: whether it sounds human. Listen for that.
"""
import re, sys, json, pathlib
import numpy as np, librosa
from faster_whisper import WhisperModel
from common import scenes, OUT

REF = " ".join(scenes())
LEAK = ["dry", "understated", "quietly", "gravely", "director", "transcript", "profile", "analyst", "pacing"]
CVE_SPAN = re.compile(r"tracked as(.*?)was planted", re.I | re.S)


def words(t):
    return re.sub(r"[^a-z0-9' ]", " ", t.lower().replace("-", " ")).split()


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = np.zeros((len(r) + 1, len(h) + 1), dtype=int)
    d[:, 0], d[0, :] = range(len(r) + 1), range(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i-1, j] + 1, d[i, j-1] + 1, d[i-1, j-1] + (r[i-1] != h[j-1]))
    return d[len(r), len(h)] / max(1, len(r))


print("loading whisper small.en ...", flush=True)
model = WhisperModel("small.en", device="cpu", compute_type="int8")
rows = []
targets = sorted(OUT.glob("*.wav"))
if len(sys.argv) > 1:
    targets = [p for p in targets if any(a in p.name for a in sys.argv[1:])]
for p in targets:
    y, sr = librosa.load(p, sr=16000)
    dur = len(y) / sr
    segs, _ = model.transcribe(y, beam_size=5, language="en")
    hyp = " ".join(s.text.strip() for s in segs)
    cve_ref = CVE_SPAN.search(REF); cve_hyp = CVE_SPAN.search(hyp)
    ref_x = CVE_SPAN.sub("tracked as X was planted", REF)
    hyp_x = CVE_SPAN.sub("tracked as X was planted", hyp)
    iv = librosa.effects.split(y, top_db=35, frame_length=1024, hop_length=256)
    gaps = [(iv[i+1][0] - iv[i][1]) / sr for i in range(len(iv) - 1)]
    pauses = [g for g in gaps if g >= 0.25]
    speech = sum((b - a) for a, b in iv) / sr
    f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=400, sr=sr, frame_length=1024)
    f0v = f0[~np.isnan(f0)]
    st = 12 * np.log2(f0v / np.median(f0v))
    n = len(words(hyp))
    rows.append(dict(
        file=p.name, dur=round(dur, 1), wpm=round(n / dur * 60), artic_wpm=round(n / speech * 60),
        pauses=len(pauses), longest_pause=round(max(pauses, default=0), 2), pause_share=round(1 - speech / dur, 2),
        pitch_std_st=round(float(np.std(st)), 2), pitch_range_st=round(float(np.percentile(st, 95) - np.percentile(st, 5)), 1),
        wer_excl_cve=round(wer(ref_x, hyp_x), 3), leaked_tags=[w for w in LEAK if w in words(hyp)],
        cve_heard=(cve_hyp.group(1).strip() if cve_hyp else "(span not found)"), transcript=hyp,
    ))
    print(f"  done {p.name}", flush=True)
(OUT / "analysis.json").write_text(json.dumps(rows, indent=1))
print()
print(f"{'file':38} {'sec':>5} {'wpm':>4} {'art':>4} {'paus':>4} {'long':>5} {'pshare':>6} {'pStd':>5} {'pRng':>5} {'WER':>5}  leaks")
for r in rows:
    print(f"{r['file']:38} {r['dur']:5} {r['wpm']:4} {r['artic_wpm']:4} {r['pauses']:4} {r['longest_pause']:5} {r['pause_share']:6} "
          f"{r['pitch_std_st']:5} {r['pitch_range_st']:5} {r['wer_excl_cve']:5}  {r['leaked_tags'] or '-'}")
print("\nCVE id as heard by Whisper (reference: 'CVE-2024-3094'):")
for r in rows:
    print(f"  {r['file']:38} {r['cve_heard']!r}")
