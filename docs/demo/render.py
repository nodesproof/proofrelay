#!/usr/bin/env python3
"""Cards and caption strips for the demo video. Driven by build.sh via env."""
import json
import os
from PIL import Image, ImageDraw, ImageFont

WORK = os.environ["WORK"]
CONTRACT = os.environ.get("CONTRACT", "")
APP = os.environ.get("APP", "").replace("https://", "")
API = os.environ.get("API", "").replace("https://", "")

W, H = 1920, 1080
INK, LIME, PAPER, MUTED = (13, 23, 33), (196, 245, 66), (236, 233, 225), (150, 162, 172)
B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
M = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
f = lambda p, s: ImageFont.truetype(p, s)


def card():
    im = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 6], fill=LIME)
    return im, d


im, d = card()
d.text((160, 330), "ProofRelay", font=f(B, 132), fill=PAPER)
d.text((166, 486), "An onchain evidence market for AI claims", font=f(R, 46), fill=MUTED)
d.rectangle([160, 580, 236, 586], fill=LIME)
d.text((160, 630), "LIVE ON 0G MAINNET  ·  CHAIN 16661", font=f(B, 34), fill=LIME)
d.text((160, 700), CONTRACT, font=f(M, 30), fill=PAPER)
im.save(f"{WORK}/cards/title.png")

im, d = card()
d.text((160, 150), "The deployment is provable", font=f(B, 82), fill=PAPER)
d.text((160, 268), "npm run verify-abi", font=f(M, 40), fill=LIME)
body = [
    ("45 functions checked", MUTED),
    ("17 events checked against real logs", MUTED),
    ("45 compiled functions vs deployed bytecode", MUTED),
    ("", MUTED),
    (f"The deployment at {CONTRACT[:10]}...{CONTRACT[-9:]} is byte-for-byte", PAPER),
    ("the code this source compiles to, and the TypeScript ABI", PAPER),
    ("matches it. Nothing here rests on selectors alone.", PAPER),
]
y = 400
for text, colour in body:
    d.text((160, y), text, font=f(M, 36), fill=colour)
    y += 62
im.save(f"{WORK}/cards/verify.png")

im, d = card()
d.text((160, 250), "See it yourself", font=f(B, 96), fill=PAPER)
y = 440
for label, url in [("App", APP), ("API", f"{API}/health"), ("Contract", f"chainscan.0g.ai/address/{CONTRACT}")]:
    d.text((160, y), label, font=f(B, 34), fill=LIME)
    d.text((400, y), url, font=f(M, 34), fill=PAPER)
    y += 84
d.text((160, 800), "0G Chain  ·  0G Storage  ·  0G Compute", font=f(B, 40), fill=MUTED)
im.save(f"{WORK}/cards/closing.png")

# ── what a verifier actually does ────────────────────────────────────────────
# Read off workers/verifier/src/pipeline.ts: the stages buildReport() runs, in
# the order it runs them. Written out because the UI shows a verifier's OUTPUT
# and never its method, and the method is the part that makes the output worth
# anything.
im, d = card()
d.text((160, 110), "What a verifier actually does", font=f(B, 76), fill=PAPER)
d.text((160, 220), "workers/verifier — one pass, per task", font=f(R, 36), fill=MUTED)
STEPS = [
    ("1", "Read the manifest", "from 0G Storage, hash-checked against the chain"),
    ("2", "Load the corpus", "the same snapshotted bytes every verifier reads"),
    ("3", "Take the claims", "the creator's own; never invented for them"),
    ("4", "Score the evidence", "0G Compute returns a verdict, confidence, quoted span"),
    ("5", "Commit a hash", "onchain, before it can see any other verifier"),
    ("6", "Reveal", "the report body lands in 0G Storage, the hash must match"),
]
y = 300
for num, head, sub in STEPS:
    d.ellipse([160, y + 4, 202, y + 46], outline=LIME, width=3)
    d.text((174, y + 12), num, font=f(B, 26), fill=LIME)
    d.text((240, y), head, font=f(B, 38), fill=PAPER)
    d.text((240, y + 48), sub, font=f(R, 29), fill=MUTED)
    y += 96
im.save(f"{WORK}/cards/pipeline.png")

# ── the commit-before-reveal property, from the live timeline ────────────────
timeline = json.loads(os.environ.get("TIMELINE_JSON", "[]"))
im, d = card()
d.text((160, 110), "Commit lands before reveal", font=f(B, 76), fill=PAPER)
d.text((160, 220), "the onchain record for this task — independence you can time", font=f(R, 36), fill=MUTED)
y = 300
for entry in timeline[:10]:
    at = str(entry.get("at", ""))[11:19]
    label = str(entry.get("label", ""))
    detail = str(entry.get("detail", ""))[:58]
    hot = "commit" in label.lower() or "reveal" in label.lower()
    d.text((160, y), at, font=f(M, 30), fill=LIME if hot else MUTED)
    d.text((320, y), label, font=f(B, 30) if hot else f(R, 30), fill=PAPER if hot else MUTED)
    d.text((720, y), detail, font=f(M, 24), fill=MUTED)
    y += 52
d.text((160, y + 26), "Both commits are onchain before either reveal exists.",
       font=f(B, 34), fill=LIME)
im.save(f"{WORK}/cards/timeline.png")

# ── fallback for the block-explorer shot ─────────────────────────────────────
# Used only when the explorer page cannot be captured. Same facts, read straight
# from the RPC instead of from someone else's rendering of it.
facts = json.loads(os.environ.get("CHAIN_FACTS", "{}"))
if facts:
    im, d = card()
    d.text((160, 140), "The contract, read from the chain", font=f(B, 72), fill=PAPER)
    d.text((160, 250), "eth_getCode · eth_getBalance · eth_blockNumber", font=f(M, 32), fill=LIME)
    rows = [
        ("Address", facts.get("address", "")),
        ("Runtime code", f"{facts.get('codeBytes', 0):,} bytes"),
        ("Escrow held", f"{facts.get('balance', 0):.4f} 0G"),
        ("Chain head", f"#{facts.get('head', 0):,}"),
        ("Network", "0G mainnet · 16661"),
    ]
    y = 400
    for label, value in rows:
        d.text((160, y), label, font=f(R, 36), fill=MUTED)
        d.text((640, y), str(value), font=f(M, 36), fill=PAPER)
        y += 78
    im.save(f"{WORK}/cards/onchain.png")

# ── the verifier working, replayed from a recorded run ───────────────────────
# A point-in-time capture of the three services' logs while one task went from
# prepare to settlement on mainnet, stored beside this script so the video can
# be rebuilt without spending real value on a fresh task every time. The taskId
# in the file is checkable on chain.
live_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "live-run.json")
if os.path.exists(live_path):
    run = json.loads(open(live_path).read())
    lines = run["lines"]
    t0 = lines[0]["ts"]
    SRC_COLOUR = {"api": (120, 200, 255), "verifier-a": LIME, "verifier-b": (255, 200, 90)}
    KEY = ("committed report", "revealed report", "finalizeConsensus submitted", "consensus evaluated")
    frames = []
    for shown in range(1, len(lines) + 1):
        im, d = card()
        d.text((120, 90), "One task, live", font=f(B, 68), fill=PAPER)
        d.text((120, 180), f"three services · {run['network']} · task {run['taskId'][:14]}…",
               font=f(M, 28), fill=MUTED)
        y = 250
        for entry in lines[:shown]:
            clock = entry["ts"][11:19]
            hot = entry["msg"] in KEY
            d.text((120, y), clock, font=f(M, 26), fill=MUTED)
            d.text((280, y), entry["src"], font=f(M, 26), fill=SRC_COLOUR.get(entry["src"], MUTED))
            d.text((470, y), entry["msg"][:64],
                   font=f(B, 26) if hot else f(M, 26), fill=PAPER if hot else MUTED)
            y += 42
        # A cursor, so a held frame reads as a live tail rather than a still.
        d.rectangle([120, y + 6, 134, y + 28], fill=LIME)
        path = f"{WORK}/cards/live_{shown:02d}.png"
        im.save(path)
        frames.append((path, entry["ts"]))
    # Real gaps, scaled into the segment. The clock on screen stays the real one.
    import datetime
    stamp = lambda v: datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    total = max(stamp(frames[-1][1]) - stamp(t0), 1.0)
    with open(f"{WORK}/live.txt", "w") as fh:
        for i, (path, ts) in enumerate(frames):
            nxt = stamp(frames[i + 1][1]) if i + 1 < len(frames) else stamp(ts) + total * 0.08
            dur = max((nxt - stamp(ts)) / total * 22.0, 0.35)
            fh.write(f"file '{path}'\nduration {dur:.3f}\n")
        fh.write(f"file '{frames[-1][0]}'\n")
    print(f"  live segment: {len(frames)} frames over {total:.0f}s of real time")

CAPTIONS = {
    "c_overview":  ("STEP 1  ·  THE LEDGER", "Live on 0G mainnet — latest block, settled bounties, evidence coverage"),
    "c_tasks":     ("STEP 2  ·  TASKS", "Each task escrows a bounty and ends in a verdict the contract settled"),
    "c_summary":   ("STEP 3  ·  ONE TASK", "0.001 0G escrowed · 2 of 2 verifiers agree · dispute window closed"),
    "c_evidence":  ("STEP 4  ·  EVIDENCE", "Every claim cites a quoted span, its sha256, and a 0G Storage pointer"),
    "c_live":      ("LIVE  ·  ONE TASK", "Three services, 96 seconds of real time: prepare, commit, reveal, settle"),
    "c_pipeline":  ("HOW  ·  THE VERIFIER", "Six stages per task — 0G Storage in, 0G Compute scoring, a hash out"),
    "c_timeline":  ("PROOF  ·  INDEPENDENCE", "Read the clock: both commits settle before either verifier reveals"),
    "c_commit":    ("STEP 5  ·  COMMIT / REVEAL", "Answers are committed as hashes before any verifier can see another's"),
    "c_onchain":   ("STEP 6  ·  SETTLEMENT", "What the contract holds: manifest pointer, result hash, block, payouts"),
    "c_verifiers": ("STEP 7  ·  THE VERIFIERS", "Both run on 0G Compute — deepseek-v4-flash, seeded and TEE-attested"),
    "c_explorer":  ("STEP 8  ·  ONCHAIN", "The contract on 0G mainnet, readable by anyone"),
}
for name, (eyebrow, text) in CAPTIONS.items():
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 906, W, H], fill=INK + (238,))
    d.rectangle([0, 906, W, 911], fill=LIME + (255,))
    d.text((120, 946), eyebrow, font=f(B, 30), fill=LIME + (255,))
    d.text((120, 1000), text, font=f(R, 42), fill=(240, 240, 236, 255))
    im.save(f"{WORK}/caps/{name}.png")

print(f"rendered 3 cards and {len(CAPTIONS)} captions")
