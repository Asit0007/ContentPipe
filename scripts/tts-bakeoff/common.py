"""Shared helpers for the TTS bake-off. Stdlib only."""
import json, wave, struct, pathlib

HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)


def scenes():
    return json.loads((HERE / "passage.json").read_text())["scenes"]


def env_key(name, env_file=HERE.parent.parent / ".env"):
    """Read one key from ContentPipe/.env without ever printing it."""
    for line in env_file.read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{name} not found in {env_file}")


def write_wav(path, pcm16: bytes, rate: int):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16)


def silence(seconds: float, rate: int) -> bytes:
    return b"\x00\x00" * int(seconds * rate)


def report(path, pcm16: bytes, rate: int, calls: int):
    secs = len(pcm16) / 2 / rate
    print(f"  wrote {path.name}: {secs:.1f}s, {calls} API/model call(s)")
