#!/usr/bin/env bash
# Rebuild the demo video from the LIVE deployment.
#
# Every frame is captured from the public URLs, so this reads the deployment
# rather than needing to be it — the block heights and hashes that end up on
# screen are whatever the chain holds when it runs.
#
# Needs: google-chrome, ffmpeg with libx264, python3 with Pillow.
set -euo pipefail

APP=${APP_URL:-https://proofrelay.nectiq.xyz}
API=${API_URL:-https://api-proofrelay.nectiq.xyz}
CONTRACT=${CONTRACT:-0xD3101C19175b50fD47C9e0B14A2dc63485f527D1}
OUT="$(cd "$(dirname "$0")" && pwd)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"/{shots,cards,caps,segs}

for tool in google-chrome ffmpeg python3; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

# ── 1. capture the live app ──────────────────────────────────────────────────
# The detail page is whichever task the API lists first, so the video always
# shows a real settled task rather than a hardcoded id that may be pruned.
TASK=$(curl -fsS --max-time 20 "$API/v1/tasks?limit=1" \
  | python3 -c "import json,sys; print((json.load(sys.stdin).get('items') or [{}])[0].get('taskId',''))")
[ -n "$TASK" ] || { echo "the API listed no tasks; nothing to film" >&2; exit 1; }
echo "filming task $TASK"

# A page that never stops issuing requests outlasts --virtual-time-budget and
# holds the whole build open; the block explorer does exactly that on a bad day.
# Every capture gets a hard timeout and one retry before the build gives up.
shot() { # url name height
  local attempt
  for attempt in 1 2; do
    timeout 75 google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
      --window-size=1920,"$3" --virtual-time-budget=12000 \
      --screenshot="$WORK/shots/$2.png" "$1" >/dev/null 2>&1 || true
    [ -s "$WORK/shots/$2.png" ] && { echo "  captured $2"; return 0; }
    echo "  capture $2 timed out (attempt $attempt)" >&2
  done
  echo "  capture failed after two attempts: $2" >&2
  return 1
}

# Anything the video cannot do without.
require() { shot "$@" || { echo "required capture failed: $2" >&2; exit 1; }; }
require "$APP/"                  overview   1080
require "$APP/verification-tasks" tasks     1400
require "$APP/verifier-network"  verifiers  1200
require "$APP/task/$TASK"        taskdetail 3200
if ! shot "https://chainscan.0g.ai/address/$CONTRACT" explorer 1080; then
  echo "  explorer capture unavailable — falling back to live RPC figures" >&2
fi

# ── 2. cards and captions ────────────────────────────────────────────────────
# The timeline card is rendered from the task's own onchain events, so it states
# what the chain recorded rather than what someone typed into a slide.
CHAIN_FACTS=$(python3 - "$CONTRACT" <<'EOF'
import json, sys, urllib.request
addr = sys.argv[1]
def rpc(method, params):
    req = urllib.request.Request("https://evmrpc.0g.ai",
        data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
        headers={"content-type":"application/json"})
    return json.load(urllib.request.urlopen(req, timeout=20))["result"]
print(json.dumps({
    "address": addr,
    "codeBytes": (len(rpc("eth_getCode", [addr, "latest"])) - 2) // 2,
    "balance": int(rpc("eth_getBalance", [addr, "latest"]), 16) / 1e18,
    "head": int(rpc("eth_blockNumber", []), 16),
}))
EOF
)
TIMELINE_JSON=$(curl -fsS --max-time 20 "$API/v1/tasks/$TASK" \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('timeline', [])))")
CONTRACT="$CONTRACT" APP="$APP" API="$API" WORK="$WORK" TIMELINE_JSON="$TIMELINE_JSON" \
  CHAIN_FACTS="$CHAIN_FACTS" \
  python3 "$OUT/render.py"

# ── 3. segments ──────────────────────────────────────────────────────────────
cd "$WORK"
seg() { # name image dur filter [caption]
  local n=$1 img=$2 dur=$3 vf=$4 cap=${5:-} out
  out=$(python3 -c "print($dur-0.5)")
  if [ -n "$cap" ]; then
    ffmpeg -y -loglevel error -loop 1 -t "$dur" -i "$img" -loop 1 -t "$dur" -i "$cap" \
      -filter_complex "[0:v]$vf[b];[b][1:v]overlay=0:0[o];[o]fade=t=in:st=0:d=0.5,fade=t=out:st=$out:d=0.5,format=yuv420p[v]" \
      -map "[v]" -r 30 -c:v libx264 -preset medium -crf 18 "segs/$n.mp4"
  else
    ffmpeg -y -loglevel error -loop 1 -t "$dur" -i "$img" \
      -vf "$vf,fade=t=in:st=0:d=0.5,fade=t=out:st=$out:d=0.5,format=yuv420p" \
      -r 30 -c:v libx264 -preset medium -crf 18 "segs/$n.mp4"
  fi
}
# A centred crop of an upscaled still is not a zoom — it is a frozen frame that
# merely looks deliberate. Scale up, then pan through the extra height over the
# segment's own duration, so the shot actually moves. pan <dur>
# The recorded run: stills whose durations are the real gaps between log lines,
# scaled into the segment. Concat cannot take a filter chain, so it is decoded
# first and the caption laid over the result.
live_seg() { # name dur caption
  ffmpeg -y -loglevel error -f concat -safe 0 -i live.txt -loop 1 -t "$2" -i "$3" \
    -filter_complex "[0:v]fps=30,scale=1920:1080,trim=duration=$2,setpts=PTS-STARTPTS[b];[b][1:v]overlay=0:0[o];[o]fade=t=in:st=0:d=0.5,fade=t=out:st=$(python3 -c "print($2-0.5)"):d=0.5,format=yuv420p[v]" \
    -map "[v]" -r 30 -c:v libx264 -preset medium -crf 18 "segs/$1.mp4"
}

pan() { echo "scale=2400:-1,crop=1920:1080:240:'270*t/$1'"; }
scroll() { echo "crop=1920:1080:0:'min(max(0\,$1+($2-$1)*t/$3)\,ih-1080)'"; }

seg 01_title    cards/title.png       8  "scale=1920:1080"
seg 02_overview shots/overview.png   12  "$(pan 12)"                caps/c_overview.png
seg 03_tasks    shots/tasks.png      12  "$(scroll 0 320 12)"       caps/c_tasks.png
seg 04_summary  shots/taskdetail.png 14  "$(scroll 0 560 14)"       caps/c_summary.png
seg 05_pipeline cards/pipeline.png   16  "scale=1920:1080"          caps/c_pipeline.png
live_seg 06_live 22 caps/c_live.png
seg 07_evidence shots/taskdetail.png 18  "$(scroll 620 1300 18)"    caps/c_evidence.png
seg 08_timeline cards/timeline.png   16  "scale=1920:1080"          caps/c_timeline.png
seg 09_commit   shots/taskdetail.png 14  "$(scroll 1400 1750 14)"   caps/c_commit.png
seg 10_onchain  shots/taskdetail.png 12  "crop=960:540:960:850,scale=1920:1080" caps/c_onchain.png
seg 11_verif    shots/verifiers.png  12  "$(scroll 0 120 12)"       caps/c_verifiers.png
if [ -s shots/explorer.png ]; then
  seg 12_explorer shots/explorer.png 10 "$(pan 10)" caps/c_explorer.png
else
  seg 12_explorer cards/onchain.png  10 "scale=1920:1080" caps/c_explorer.png
fi
seg 13_verify   cards/verify.png     10  "scale=1920:1080"
seg 14_closing  cards/closing.png     4  "scale=1920:1080"

# ── 4. assemble ──────────────────────────────────────────────────────────────
ls segs/*.mp4 | sort | sed "s|^|file '|;s|$|'|" > concat.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i concat.txt -c copy "$OUT/proofrelay-workflow.mp4"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/proofrelay-workflow.mp4")

# A crop offset that clamps against the image height produces a segment that is
# a frozen frame for its whole duration — it encodes cleanly and looks like a
# bug nobody notices. Every segment that asked to move must actually move.
for f in segs/0[2-4]*.mp4 segs/07*.mp4 segs/09*.mp4 segs/1[12]*.mp4; do
  ffmpeg -v error -y -ss 1 -i "$f" -frames:v 1 a.png
  ffmpeg -v error -y -sseof -1.5 -i "$f" -frames:v 1 b.png
  python3 - "$f" <<'EOF'
import sys
from PIL import Image, ImageChops, ImageStat
delta = ImageStat.Stat(ImageChops.difference(
    Image.open("a.png").convert("L"), Image.open("b.png").convert("L"))).mean[0]
if delta < 3:
    sys.exit(f"{sys.argv[1]} never moves (delta {delta:.2f}) — the crop clamped")
print(f"  motion ok  {sys.argv[1]}  delta {delta:.1f}")
EOF
done

echo "wrote $OUT/proofrelay-workflow.mp4  (${DUR}s)"
