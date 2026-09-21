"""Google Cloud TTS Chirp 3 HD. Needs the Cloud Text-to-Speech API enabled + billing on the key's project."""
import sys, json, base64, urllib.request, urllib.error
from common import scenes, env_key, write_wav, report, OUT

voice = sys.argv[1] if len(sys.argv) > 1 else "Charon"
body = {
    "input": {"text": "\n\n".join(scenes())},
    "voice": {"languageCode": "en-US", "name": f"en-US-Chirp3-HD-{voice}"},
    "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
}
req = urllib.request.Request(
    "https://texttospeech.googleapis.com/v1/text:synthesize", data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json", "x-goog-api-key": env_key("GEMINI_API_KEY")},
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        audio = base64.b64decode(json.load(r)["audioContent"])
except urllib.error.HTTPError as e:
    err = json.loads(e.read().decode()).get("error", {})
    raise SystemExit(f"  Chirp 3 HD unavailable: HTTP {e.code} {err.get('status')}: {err.get('message','')[:300]}")
pcm = audio[44:]  # strip the WAV header the API returns
path = OUT / f"5-chirp3hd-{voice.lower()}.wav"
write_wav(path, pcm, 24000)
report(path, pcm, 24000, 1)
