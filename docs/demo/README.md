# Demo video — the workflow, end to end

`proofrelay-workflow.mp4` — 3:00, 1920×1080, H.264, silent, 15 MB.

Every frame is a capture of the **live mainnet deployment**, taken with headless
Chrome against `https://proofrelay.nectiq.xyz` and `chainscan.0g.ai` while the
services were running. Nothing in it is a mockup, a wireframe, or a staged
fixture: the block heights, hashes, balances and verdicts on screen are the ones
the chain held at capture time.

## What it shows, in order

| From | For | Step |
|---|---|---|
| 0:00 | 8s | Title — contract address and chain 16661 |
| 0:08 | 12s | **The ledger.** Latest block, settled bounties, evidence coverage |
| 0:20 | 12s | **Tasks.** Each escrows a bounty and ends in a settled verdict |
| 0:32 | 14s | **One task.** 0.001 0G escrowed, 2 of 2 agree, dispute window closed |
| 0:46 | 16s | **How a verifier works.** The six stages of one pass |
| 1:02 | 22s | **One task, live.** Three services' logs, prepare → commit → reveal → settle |
| 1:24 | 18s | **Evidence.** Quoted spans with sha256 and 0G Storage pointers |
| 1:42 | 16s | **Independence, timed.** Both commits precede either reveal |
| 1:58 | 14s | **Commit / reveal.** The two reports, their hashes, and the model |
| 2:12 | 12s | **Settlement.** Manifest pointer, result hash, block, payouts |
| 2:24 | 12s | **The verifiers.** Both on 0G Compute — `deepseek-v4-flash` |
| 2:36 | 10s | **Onchain.** The contract on 0G mainnet |
| 2:46 | 10s | **Provable.** `verify-abi`: byte-for-byte equal to this source |
| 2:56 | 4s | Closing — the three links a judge can open |

Three of those are not screenshots, because the UI shows a verifier's *output*
and never its method:

- **0:46** is read off `workers/verifier/src/pipeline.ts` — the stages
  `buildReport()` runs, in the order it runs them.
- **1:02** replays `assets/live-run.json`: the API, verifier-a and verifier-b
  logs recorded while one real task went from prepare to settlement on mainnet.
  The gaps between lines are the real gaps, scaled into 22 seconds; the clock on
  screen is the real clock. The taskId in that file is checkable on chain.
- **1:42** is rendered from the task's own `timeline` in the API, so it states
  what the chain recorded rather than what someone typed onto a slide.

The order is the protocol's own order. A viewer who watches it straight through
has followed one claim from bounty to settlement without a narrator asserting
anything the screen does not already show.

## Rebuilding it

The capture and assembly are scripted, so a later run reflects a later state of
the chain rather than this one:

```bash
bash docs/demo/build.sh          # captures, renders and encodes into this folder
```

It needs `google-chrome`, `ffmpeg` with libx264, and Python with Pillow. Screens
come from the public URLs, so it can be run from any machine — it reads the
deployment, it does not need to be the deployment.

Two guards are in it because both failures happened during the first build and
neither announced itself:

- **Every capture has a hard timeout and one retry.** A third-party page that
  never stops issuing requests outlasts `--virtual-time-budget` and holds the
  whole build open. The block explorer is optional: if it will not settle, the
  video falls back to a card built from `eth_getCode` / `eth_getBalance`.
- **Every segment that asks to move is checked that it moved.** A crop offset
  that clamps against the image height renders, encodes and plays perfectly —
  as a frozen frame for its whole duration. The build compares the first and
  last frame of each panning segment and refuses to finish if one is still.

## Notes

There is no audio track. The captions carry the narration, which keeps the file
small and makes it legible when a portal autoplays muted. Add a voiceover with
`ffmpeg -i proofrelay-workflow.mp4 -i voice.m4a -c:v copy -shortest out.mp4` if a
submission form wants one.
