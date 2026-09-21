"""Gemini TTS: 'current' (what server.ts does today) vs 'directed' (one chunk, full direction).

  python3 gemini_tts.py current              # per-scene calls, one-line prompt, Puck  (= /api/tts today)
  python3 gemini_tts.py directed Charon      # one call, Audio Profile + Scene + Director's Notes
"""
import re, sys, json, base64, time, urllib.request, urllib.error
from common import scenes, env_key, write_wav, silence, report, OUT

MODEL = "gemini-3.1-flash-tts-preview"
RATE = 24000
GAP = 0.30  # seconds between scenes, approximating the assembler's per-scene padding
URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"


def call(prompt: str, voice: str) -> bytes:
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    req = urllib.request.Request(
        URL.format(MODEL), data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": env_key("GEMINI_API_KEY")},
    )
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            if e.code == 429 and attempt == 1:
                quota = re.findall(r'"quotaId":\s*"([^"]+)"', raw)
                delay = re.search(r'retry in ([\d.]+)s|"retryDelay":\s*"(\d+)s"', raw)
                wait = float(next(g for g in delay.groups() if g)) + 2 if delay else 65
                print(f"  429 quota={quota or '?'}; " + ("PER-DAY, giving up" if any("Day" in q for q in quota) else f"waiting {wait:.0f}s"), flush=True)
                if any("Day" in q for q in quota):
                    raise SystemExit("  daily Gemini TTS quota is exhausted")
                time.sleep(wait)
                continue
            raise SystemExit(f"  Gemini HTTP {e.code}: {raw[:500]}")
    part = data["candidates"][0]["content"]["parts"][0]
    if "inlineData" not in part:
        raise SystemExit(f"  no audio returned: {json.dumps(data)[:300]}")
    return base64.b64decode(part["inlineData"]["data"])


def current():
    # Verbatim the prompt in server.ts:600, per scene, voice Puck.
    pcm, calls = b"", 0
    for i, text in enumerate(scenes(), 1):
        prompt = f"Speak in a punchy, engaging infotainment documentary narrator voice: {text}"
        pcm += call(prompt, "Puck") + silence(GAP, RATE)
        calls += 1
        print(f"  scene {i}/5 ok")
    path = OUT / "1-gemini-current-puck.wav"
    write_wav(path, pcm, RATE)
    report(path, pcm, RATE, calls)


DIRECTION = """# AUDIO PROFILE: The Analyst
## Narrator of a serious cybersecurity documentary

## THE SCENE: A quiet late-night studio
A single microphone, no music yet. The narrator is a veteran incident responder telling a story they have told before and still find unsettling. Calm, close to the microphone, unhurried.

### DIRECTOR'S NOTES
Style: Measured, dry and understated, like a long-form investigative documentary. Quiet authority, not a news anchor and not a trailer voice. Let the facts carry the tension. Never shout, never hype.
Pacing: Conversational, about 150 words per minute. Slow slightly on key numbers and names. Take a short, natural breath between sentences, and a slightly longer pause between paragraphs. Let the short sentences land.
Accent: Neutral, clear international English.
Read technical strings naturally: say "C-V-E" letter by letter, then the numbers in groups; say "S-S-H" letter by letter; "liblzma" as "lib-L-Z-M-A".

#### TRANSCRIPT
"""


def directed(voice: str):
    ss = scenes()
    text = "\n\n".join(ss)
    # Light, free-form inline tags on the two lines that carry the emotional turn.
    text = text.replace("Half a second. Most people", "[dry, understated] Half a second. Most people")
    text = text.replace("The lesson isn't that", "[quietly, gravely] The lesson isn't that")
    pcm = call(DIRECTION + text, voice)
    path = OUT / f"2-gemini-directed-{voice.lower()}.wav"
    write_wav(path, pcm, RATE)
    report(path, pcm, RATE, 1)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "current":
        current()
    elif mode == "directed":
        directed(sys.argv[2] if len(sys.argv) > 2 else "Charon")
    else:
        raise SystemExit(__doc__)
