#!/usr/bin/env python3
"""ContentPipe script JSON -> a $0 production pack: which stills to make (within an image budget),
which scenes become AI clips and with which tool, clip lengths snapped to each tool's limits,
one-camera-move image-to-video prompts, timeline-ordered filenames for DaVinci Resolve, and a
credit/day estimate. Stdlib only; deterministic; calls nothing.

  python3 shotlist.py script.json [--images 30] [--out DIR] [--tools tools.json]
                      [--allow-noncommercial] [--clip-share 0.25]
"""
import argparse, json, math, os, re, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
GRAPHIC_TYPES = {"terminal", "diagram", "headline"}
CAMERA_RE = re.compile(r"\b(whip[- ]pan|pan|pans|panning|tilt|tilts|zoom|zooms|dolly|dollies|push(?:es)?[- ]in|pull(?:s)?[- ](?:out|back)|"
                       r"truck|orbit|orbits|crane|tracking|track(?:s)? (?:left|right)|whip|arc(?:s)?)\b", re.I)
ACTION_RE = re.compile(r"\b(run|runs|running|chase|chases|explod\w*|crash\w*|fight\w*|sprint\w*|slam\w*|shatter\w*|"
                       r"burst\w*|collaps\w*|fast|rapid\w*|whip[- ]pan|handheld|speeding|races?|racing|falls?|jumps?)\b", re.I)
STILL_MOVES = re.compile(r"^\s*(static|locked[- ]off|slow (push[- ]in|pull[- ](out|back)|zoom( in| out)?|pan( left| right)?)|"
                         r"push[- ]in|pull[- ](out|back)|zoom( in| out)?|ken burns|none)\s*$", re.I)
NO_CHAR = "no characters in frame"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def image_prompt(scene):
    v = scene.get("visual") or {}
    if not v:
        return clean(scene.get("visualPrompt")), ""
    parts = [v.get("character"), v.get("background"), v.get("scene"), v.get("styleAnchor")]
    parts = [clean(p) for p in parts if clean(p) and clean(p).lower().rstrip(".") != NO_CHAR]
    return ". ".join(p.rstrip(".") for p in parts) + ".", clean(v.get("negative"))


def classify(scene):
    """-> (route, reason). route in graphic | kenburns | action | long | motion."""
    if (scene.get("visualType") or "").lower() in GRAPHIC_TYPES:
        return "graphic", f"visualType {scene.get('visualType')}"
    m = scene.get("motion") or {}
    blob = " ".join(str(m.get(k, "")) for k in ("subjectMotion", "motionPrompt", "cameraMove", "shotType"))
    blob += " " + str(scene.get("cinematography", ""))
    if ACTION_RE.search(blob):
        return "action", f"action words: {ACTION_RE.search(blob).group(0)!r}"
    subject = clean(m.get("subjectMotion")).lower()
    subject_still = subject in ("", "none", "static", "still", "no movement") or subject.startswith("none")
    if subject_still and (not m.get("cameraMove") or STILL_MOVES.match(m.get("cameraMove", ""))):
        return "kenburns", "no subject motion; camera move a still can fake"
    if float(scene.get("durationEst") or 0) > 10:
        return "long", "moving subject, >10 s"
    return "motion", "moving subject"


def i2v_prompt(scene):
    m = scene.get("motion") or {}
    mp = clean(m.get("motionPrompt"))
    moves = CAMERA_RE.findall(mp)
    note = ""
    if mp and len(moves) <= 1:
        return mp, note
    cam = clean(m.get("cameraMove")) or "Static camera"
    first_move = CAMERA_RE.findall(cam)
    if len(first_move) > 1:
        cam, note = "Static camera", "camera field had several moves; forced static"
    else:
        note = f"motionPrompt had {len(moves)} camera moves; rebuilt with one" if mp else "no motionPrompt; built from fields"
    subj = clean(m.get("subjectMotion")) or "Subtle ambient movement"
    return f"{subj.rstrip('.')}. {cam.rstrip('.')[:1].upper() + cam.rstrip('.')[1:]}.", note


HOLD_SEC = 3  # a remainder this short is covered by holding/slowing the last clip in the edit, not a new clip


def split_duration(total, durations):
    """Cover `total` seconds with allowed clip lengths; trim the last one in the edit.
    Returns (clips, held): `held` seconds are covered by a hold/slow-down instead of buying another clip."""
    clips, rem = [], max(total, 0.1)
    durations = sorted(durations)
    while rem > 0.05:
        if clips and rem <= HOLD_SEC:
            return clips, rem
        under = [d for d in durations if d <= rem]
        if under and rem - under[-1] <= HOLD_SEC:
            d = under[-1]  # a shorter clip plus a short hold beats buying a longer clip and trimming it
        else:
            fit = [d for d in durations if d >= rem]
            d = fit[0] if fit else durations[-1]
        clips.append(d)
        rem -= d
    return clips, 0


def pick_tool(route, cfg, allow_nc):
    for name in cfg["routes"].get(route, []):
        t = cfg["tools"][name]
        if t["commercialOk"] is False and not allow_nc:
            continue
        return name
    return "kenburns"


def priority(scene, idx, prev_phase):
    score = 0
    if idx == 0:
        score += 100
    if scene.get("actPhase") and scene.get("actPhase") != prev_phase:
        score += 40
    route = scene["_route"]
    score += {"action": 30, "long": 20, "motion": 15, "kenburns": 5}.get(route, 0)
    if scene.get("charactersInFrame"):
        score += 10
    score += min(float(scene.get("durationEst") or 0), 20)
    return score


def build(script, cfg, budget, allow_nc, clip_share):
    scenes = sorted(script.get("scenes") or [], key=lambda s: s.get("sceneNumber", 0))
    if script.get("isQuotaFallback"):
        print("warning: isQuotaFallback is true — this is canned sample content, not a real script", file=sys.stderr)
    total = sum(float(s.get("durationEst") or 0) for s in scenes)
    for s in scenes:
        s["_route"], s["_why"] = classify(s)

    # 1. Stills within budget: graphics need none; the rest ranked by priority.
    prev = None
    for i, s in enumerate(scenes):
        s["_prio"] = priority(s, i, prev)
        prev = s.get("actPhase")
    need = [s for s in scenes if s["_route"] != "graphic"]
    ranked = sorted(need, key=lambda s: -s["_prio"])
    own = {s["sceneNumber"] for s in ranked[:budget]}
    images, img_of = [], {}
    for s in scenes:
        if s["sceneNumber"] in own:
            n = len(images) + 1
            img_of[s["sceneNumber"]] = n
            p, neg = image_prompt(s)
            images.append({"n": n, "scene": s, "prompt": p, "negative": neg})
    for s in scenes:  # scenes over budget reuse a still of the same place, else none
        if s["_route"] == "graphic" or s["sceneNumber"] in img_of:
            continue
        same = [o for o in scenes if o["sceneNumber"] in own and o.get("locationId") and o.get("locationId") == s.get("locationId")]
        if same:
            src = min(same, key=lambda o: abs(o["sceneNumber"] - s["sceneNumber"]))
            s["_reuse"] = img_of[src["sceneNumber"]]
        else:
            s["_reuse"] = None

    # 2. AI clips: only for the top share of moving scenes by priority; the rest Ken Burns.
    moving = sorted([s for s in scenes if s["_route"] in ("action", "long", "motion")], key=lambda s: -s["_prio"])
    clip_budget_sec, used = clip_share * total, 0.0
    for s in moving:
        d = float(s.get("durationEst") or 0)
        if used + d <= clip_budget_sec or used == 0:
            s["_ai"] = True
            used += d
        else:
            s["_ai"] = False
            s["_why"] += "; over AI-clip share, Ken Burns instead"

    shots, credits, day_caps = [], Counter(), Counter()
    order = 0
    for s in scenes:
        sn, d = s["sceneNumber"], float(s.get("durationEst") or 0)
        img = img_of.get(sn) or s.get("_reuse")
        if s["_route"] == "graphic":
            tool, lens = "graphic", [d]
        elif s.get("_ai") and img:
            tool = pick_tool(s["_route"], cfg, allow_nc)
            durs = cfg["tools"][tool]["durations"]
            lens, held = split_duration(d, durs) if durs else ([d], 0)
            if held:
                s["_why"] += f"; last {held:g} s: hold or slow the final clip in the edit"
        else:
            tool, lens = "kenburns", [d]
        prompt, note = i2v_prompt(s) if tool not in ("graphic", "kenburns") else ("", "")
        for k, L in enumerate(lens, 1):
            order += 10
            t = cfg["tools"][tool]
            ext = "png" if tool in ("graphic", "kenburns") else "mp4"
            fname = f"{order:04d}_s{sn:02d}_c{k}_{tool}_{int(L)}s.{ext}"
            start = (f"img{img:02d}" if k == 1 else "last frame of previous clip") if img else "—"
            if t.get("creditsPerSec"):
                credits[tool] += t["creditsPerSec"] * L
            if t.get("dailyClipCap"):
                day_caps[tool] += 1
            shots.append({"file": fname, "scene": sn, "clip": k, "tool": tool, "sec": L, "start": start,
                          "prompt": prompt if k == 1 else f"Continue the motion. {prompt}".strip(), "note": note})
    return scenes, images, shots, credits, day_caps, total


def days_needed(credits, day_caps, cfg):
    out = {}
    for tool, c in credits.items():
        daily = cfg["tools"][tool].get("dailyFreeCredits")
        out[tool] = math.ceil(c / daily) if daily else None
    for tool, n in day_caps.items():
        out[tool] = math.ceil(n / cfg["tools"][tool]["dailyClipCap"])
    return out


def render_md(script, cfg, scenes, images, shots, credits, day_caps, total, args):
    ar = script.get("aspectRatio") or "16:9"
    L = [f"# Shot list — {script.get('title', 'untitled')}", ""]
    L.append(f"Runtime {total:.0f} s, {len(scenes)} scenes, aspect {ar}. Image budget {args.images}; "
             f"AI clips capped at {args.clip_share:.0%} of runtime. Generated by `shotlist.py`; prompts only, nothing was called.")
    if script.get("isQuotaFallback"):
        L += ["", "> **WARNING: `isQuotaFallback` is true — canned sample content. Do not produce this.**"]
    by_tool = Counter()
    for s in shots:
        by_tool[s["tool"]] += s["sec"]
    L += ["", "## Summary", "", "| Tool | Clips | Seconds | Credits (est.) | Free days needed | Monetisable free output |", "|---|---|---|---|---|---|"]
    dn = days_needed(credits, day_caps, cfg)
    for tool, sec in by_tool.most_common():
        t = cfg["tools"][tool]
        n = sum(1 for s in shots if s["tool"] == tool)
        c = f"{credits[tool]:.0f}" if credits.get(tool) else ("0" if t.get("creditsPerSec") == 0 else "unknown")
        L.append(f"| {t['label']} | {n} | {sec:.0f} | {c} | {dn.get(tool) if dn.get(tool) is not None else '—'} | { {True: 'yes', False: 'NO'}.get(t['commercialOk'], t['commercialOk']) } |")
    need = sum(1 for s in scenes if s["_route"] != "graphic")
    L.append("")
    L.append(f"Stills: {len(images)} to generate for {need} scenes that need one"
             + (f"; {need - len(images)} reuse a still of the same place or have none (see table)." if need > len(images) else "."))
    if any(cfg["tools"][s["tool"]]["commercialOk"] is False for s in shots):
        L.append("\n> **Non-commercial tool in use (`--allow-noncommercial`).** Its free output may not go on a monetised channel. Drafts only.")

    L += ["", "## Stills", "", "Generate in order. Same seed and the same character reference for every still of one character. "
          f"Midjourney: append `--ar {ar}` and `--no <negative>`. Flux / Nano Banana: paste as is; negative into the negative field if there is one.", ""]
    for im in images:
        s = im["scene"]
        L.append(f"### img{im['n']:02d} — scene {s['sceneNumber']}: {s.get('title', '')}")
        L.append(f"Place `{s.get('locationId') or '—'}`, characters {', '.join(s.get('charactersInFrame') or []) or 'none'}.")
        L += ["```text", im["prompt"], "```"]
        if im["negative"]:
            L.append(f"Negative: `{im['negative']}`")
        L.append("")

    L += ["## Timeline", "", "Filenames are in timeline order: save each download under exactly this name and Resolve's sorted bin is the edit.", "",
          "| # | File | Scene | Tool | Sec | Start image | Why |", "|---|---|---|---|---|---|---|"]
    why = {s["sceneNumber"]: s["_why"] for s in scenes}
    reuse = {s["sceneNumber"]: s.get("_reuse", "own") for s in scenes}
    for i, s in enumerate(shots, 1):
        st = s["start"]
        if st == "—" and s["tool"] == "kenburns":
            st = "**no still (over budget) — make a graphic or raise --images**"
        elif s["clip"] == 1 and reuse.get(s["scene"]) not in ("own", None) and s["tool"] != "graphic":
            st += " (reused: vary crop/motion)"
        L.append(f"| {i} | `{s['file']}` | {s['scene']} | {s['tool']} | {s['sec']:g} | {st} | {why[s['scene']]} |")

    L += ["", "## Image-to-video prompts", "", "One camera move each. Test at the cheapest quality and 5 s first; generate the keeper only when the motion is right. "
          "For clip 2+ of a scene, start from the previous clip's last frame: `ffmpeg -sseof -0.1 -i prev.mp4 -frames:v 1 last.png`.", ""]
    for s in shots:
        if not s["prompt"]:
            continue
        L.append(f"**`{s['file']}`** — {cfg['tools'][s['tool']]['label']}, {s['sec']:g} s, start: {s['start']}"
                 + (f" _( {s['note']} )_" if s["note"] else ""))
        L += ["```text", s["prompt"], "```", ""]

    L += ["## Graphic scenes", ""]
    g = [s for s in scenes if s["_route"] == "graphic"]
    for s in g:
        L.append(f"- **Scene {s['sceneNumber']}** ({s.get('visualType')}, {float(s.get('durationEst') or 0):g} s): "
                 f"on-screen text `{clean(s.get('onScreenText')) or '—'}`" + (" — has an infographic spec in the brief" if s.get("infographic") else ""))
    if not g:
        L.append("None.")

    L += ["", "## Assemble in DaVinci Resolve (free)", "",
          "1. Media pool: import narration, `stills/`, `clips/`, `graphics/`, and the `.en.srt` from the assembler if you rendered one.",
          "2. Sort the clips bin by name → select all → *Create New Timeline Using Selected Clips*.",
          "3. Ken Burns rows: drop the still, set its length to the Sec column, turn on *Dynamic Zoom* in the Inspector.",
          "4. Trim AI clips to the Sec column (clips were generated at the next allowed length up).",
          "5. Deliver: H.264, and normalise audio to −14 LUFS (*Normalize Audio Levels*)."]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script")
    ap.add_argument("--images", type=int, default=30, help="max stills to generate (default 30)")
    ap.add_argument("--out", default=None, help="output dir (default: next to the script)")
    ap.add_argument("--tools", default=os.path.join(HERE, "tools.json"))
    ap.add_argument("--allow-noncommercial", action="store_true", help="allow tools whose free output is non-commercial (drafts)")
    ap.add_argument("--clip-share", type=float, default=0.25, help="max share of runtime as AI clips (default 0.25)")
    args = ap.parse_args()
    script, cfg = load(args.script), load(args.tools)
    if not script.get("scenes"):
        sys.exit("no scenes in this JSON — is it the /api/script response?")
    scenes, images, shots, credits, day_caps, total = build(script, cfg, args.images, args.allow_noncommercial, args.clip_share)
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.script)), "production")
    for sub in ("stills", "clips", "graphics", "audio"):
        os.makedirs(os.path.join(out, sub), exist_ok=True)
    with open(os.path.join(out, "shotlist.md"), "w", encoding="utf-8") as f:
        f.write(render_md(script, cfg, scenes, images, shots, credits, day_caps, total, args))
    with open(os.path.join(out, "shots.json"), "w", encoding="utf-8") as f:
        json.dump({"images": [{k: v for k, v in i.items() if k != "scene"} | {"scene": i["scene"]["sceneNumber"]} for i in images],
                   "shots": shots}, f, indent=2)
    print(f"{len(images)} stills, {sum(1 for s in shots if s['tool'] not in ('kenburns', 'graphic'))} AI clips, "
          f"{sum(1 for s in shots if s['tool'] == 'kenburns')} Ken Burns, {sum(1 for s in shots if s['tool'] == 'graphic')} graphics -> {out}/shotlist.md")


if __name__ == "__main__":
    main()
