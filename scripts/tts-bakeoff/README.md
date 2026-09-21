# TTS bake-off

Compares narration engines on one 5-scene documentary passage (`passage.json` — voice-test text, **not for publication**).
Nothing here touches `server.ts` or the pipeline. `.gitignore` keeps out venvs, models, audio, logs, the blind set and its key,
and **`passage.json` itself**: it is marked not for publication, so it is not committed. The scripts read it (`common.scenes()`),
so to re-run anything, put a 5-scene `{"scenes": [...]}` file of your own at that path.

**Outcome (blind test, 2026-09-21):** the owner kept **Kokoro `af_heart`** (narrator) and **Gemini `Charon`** (the "directed" clip, analyst).
Dropped: Puck (what `/api/tts` does today), Sadaltager, Kokoro `am_michael` / `bm_george`, Chatterbox. Caveat: the Charon clip is ONE call for the
whole passage; the pipeline calls per scene, which is untested. Whisper also heard "liblzma" as "Libelsma" in every Kokoro clip.

| # | Clip | How |
|---|---|---|
| 1 | `1-gemini-current-puck.wav` | What `/api/tts` does today: per-scene calls, one-line prompt, Puck (`server.ts:600`) |
| 2 | `2-gemini-directed-<voice>.wav` | One call: Audio Profile + Scene + Director's Notes + light inline tags |
| 3 | `3-kokoro-<voice>.wav` | Kokoro-82M, local CPU, Apache-2.0 |
| 4 | `4-chatterbox-<tag>.wav` | Chatterbox, local (MPS), MIT. `default` voice, or `me` = clone of `ref/me.wav` |

Chirp 3 HD was not run: Cloud TTS rejects plain API keys (needs OAuth via `gcloud` + billing).

## Re-run
```bash
python3 gemini_tts.py current                 # 5 calls
python3 gemini_tts.py directed Charon         # 1 call  (free tier ≈ 3 req/min; the script waits and retries once)
.venv-kokoro/bin/python kokoro_tts.py af_heart am_michael bm_george
.venv-chatterbox/bin/python chatterbox_tts.py                 # default voice
.venv-chatterbox/bin/python chatterbox_tts.py ref/me.wav me   # your voice: record 10-20 s of clean speech, no music
.venv-analyze/bin/python analyze.py           # Whisper transcript diff, pace, pauses, pitch movement -> out/analysis.json
```
Analysis measures *correctness and flatness*, not whether it sounds human. Listen for that.

## Blind listening set
```bash
python3 make_blind.py            # out/*.wav + anything in extra/ -> blind/clip-NN.wav, shuffled; key in blind-key.json
python3 make_blind.py --force    # rebuild with a new shuffle (ratings on the old set stop matching)
python3 make_blind.py --reveal   # print which clip is which -- AFTER you have rated
```
Every clip is loudness-matched (two-pass EBU R128, -16 LUFS; a single pass left the pause-heavy clips ~2 dB quieter, which biases a
listener), downmixed to mono, stripped of metadata and renamed. Clip length still gives an engine away. `extra/` takes clips made
elsewhere (e.g. a hand-made Suno clip); `blind/` has a `SCORECARD.md`.

## Rebuild the environments
`python3.11 -m venv .venv-kokoro && .venv-kokoro/bin/pip install kokoro-onnx soundfile numpy` (models: `kokoro-v1.0.onnx`,
`voices-v1.0.bin` from the `thewh1teagle/kokoro-onnx` `model-files-v1.0` release into `models/`);
`.venv-chatterbox`: `pip install chatterbox-tts`; `.venv-analyze`: `pip install faster-whisper librosa soundfile numpy`.
