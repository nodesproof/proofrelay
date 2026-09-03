> **Provenance.** The runs recorded below were executed during development, in
> early September 2026, against 0G's test network — the transaction hashes and
> explorer links belong to that chain and are left exactly as they were produced.
> Rewriting them to read as mainnet would make them unverifiable.
>
> The mainnet deployment they led to is `0xD3101C19175b50fD47C9e0B14A2dc63485f527D1` on chain 16661, deployed at block
> 43394193. `npm run verify-abi` re-runs the bytecode-equality proof against it,
> and `docs/demo/assets/live-run.json` records one full task there from prepare
> to settlement.

Every claim below was executed against 0G's test network (chain 16602) or against the
artifacts already on 0G Storage. Each has a command you can re-run.

## The rebuilt contract matches the one that is deployed

The contract at `0xc1E353cb44eA09729143f06Af97E51FB952b33D7` predates this
rebuild; its source was lost. The ABI was recovered from the deployed runtime
bytecode and from real transactions, and the rebuilt Solidity compiles to a
matching ABI.

```bash
npm run verify-abi
```

```
TypeScript ABI vs deployed bytecode
  45 functions checked
TypeScript ABI vs real event logs
  14 events checked
Solidity source vs deployed bytecode
  45 compiled functions checked
Custom errors (informational)
  12/34 compiled error selectors also appear in the deployment

All three agree. The deployed contract at 0xc1E353cb44eA09729143f06Af97E51FB952b33D7 is usable as is.
```

Two encodings are pinned against the chain rather than against ourselves. The
four live tasks' ids reproduce from `keccak256(abi.encode(chainId, contract,
creator, nonce))`, and the six live commitments reproduce from the report hash
and salt their own reveal transactions carried:

```bash
npx vitest run packages/chain-client
```

## The integrity chain closes, on live data

The contract stores a hash; 0G Storage stores the bytes; the pointer only helps
retrieval. This fetches a live task's manifest from 0G Storage by the pointer
the contract holds, canonicalises it, hashes it, and compares:

```bash
npm run check:artifact
```

```
task         0xf5b3b3ea97fc38ce0520df37f52c5326f09b132af610e65ed39b14523f3b2db2
manifestHash 0x96829c0299bbeddf0f8ea819850aa8b8343488742e6dff8aef42e99cb1ef2f6e
pointer      0g://0x4f0803230b82dad372b217fb7f78458c82b59431d4aa8edaf1aa490348d23912
bytes        1800 source: storage
recomputed   0x96829c0299bbeddf0f8ea819850aa8b8343488742e6dff8aef42e99cb1ef2f6e
MATCH        yes
canonical rt byte-identical
schema       valid — "acme-widgets v1.4.0 release claims", 3 claims, 2 sources
report       0xeFf4313AD00b3aD7f3Be18c75Bc862CaA3d1e8FA hash OK 8850B
report       0xE51DB46739F04cb4f80Ed99e5FC0Fc438f117Cca hash OK 9052B
```

The canonicaliser is pinned the same way: all 42 artifacts already in
`.proofrelay/storage/` re-serialise byte-for-byte and reproduce their own
content-addressed filenames (`npx vitest run packages/schemas`).

## A settled task replays to the same settlement

The PRD's reproducibility criterion, executed. This pulls a finalised task's
reports from 0G Storage, re-runs the consensus engine over them, and compares
with what the keeper actually submitted:

```bash
npm run check:replay
```

```
replayed outcome   CONSENSUS   agreement 10000 bps
  claim-001  AGREED  SUPPORTED
    0xe51d=SUPPORTED@0.93  0xeff4=SUPPORTED@0.97
  claim-002  AGREED  CONTRADICTED
    0xe51d=CONTRADICTED@0.728  0xeff4=CONTRADICTED@0.7346
  claim-003  AGREED  INSUFFICIENT_EVIDENCE
    0xe51d=INSUFFICIENT_EVIDENCE@0.3103  0xeff4=INSUFFICIENT_EVIDENCE@0.3103

onchain outcome    CONSENSUS
MATCH — replaying the stored snapshots reproduces the settlement the chain recorded.
```

## 0G Storage round-trips

```bash
npm run check:storage
```

Uploads a canonical artifact, gets back a real root hash and flow transaction,
downloads it from the storage nodes, and confirms the bytes hash to the same
value. Typical: 11.6 s up, 2.5 s down, ~0.0017 0G gas plus a storage fee of
about 6e-8 0G for a 500-byte object. A second upload of identical bytes is
deduplicated and costs nothing.

## A whole task, end to end, on the live chain

```bash
node scripts/checks/full-cycle.mjs
```

Run on 2026-09-02 against Galileo. Two verifiers with deliberately different
pipeline configurations read the same snapshots and **disagreed** on one claim —
which is the point of the product, so the outcome is worth reading in full:

```
[2] create the task and escrow the bounty
    taskId             0x832adc447e78b103ea7b5f98e4b6b3e892f0596d5e9752ce4b9b8fd897509ada
    bounty             0.001 0G
    tx                 https://chainscan-galileo.0g.ai/tx/0xa21a52144abe20b8d24747787af56d2af5f6ed594d1aadfdc8495b498b2f14b0

[3] two independent verifiers build reports from the same snapshots
    committed          2/2

[4] reveal — no report pointer was readable until every commitment landed
    revealed           2/2

[5] evaluate consensus over the revealed reports
    verifier-a  local-entailment/2-0.55  [hash OK]
    verifier-b  local-entailment/3-0.5   [hash OK]
    claim-001          SPLIT   INSUFFICIENT_EVIDENCE
    claim-002          AGREED  CONTRADICTED
    claim-003          AGREED  INSUFFICIENT_EVIDENCE
    outcome            CONFLICT  6667 bps

[6] keeper finalizes; every amount is derived by the contract
    tx                 https://chainscan-galileo.0g.ai/tx/0x00a1431f50d665fca0403a52e1a28be0ed63785fe861d83e954eb6d07a319441
    outcome            CONFLICT
    0xeFf4313AD00b3aD7f3Be18c75Bc862CaA3d1e8FA allocated 0.00025 0G
    0xE51DB46739F04cb4f80Ed99e5FC0Fc438f117Cca allocated 0.00025 0G

[7] claim after the dispute window
    dispute window     closes in 234s — claiming would revert, as designed
```

The keeper sent an **empty** beneficiary list and `rewardBps = 0`; the contract
derived the conflict rate itself and paid each revealer 0.00025 0G — half of
`conflictRateBps = 5000` applied to the bounty — returning the rest to the
creator. The keeper never chose an amount.

Then, after the window really closed:

```bash
node scripts/checks/full-cycle.mjs --claim 0x832adc44…
node scripts/checks/withdraw.mjs
```

```
verifier-b 0xE51DB46739F04cb4f80Ed99e5FC0Fc438f117Cca
  withdrew 0.00225 0G   https://chainscan-galileo.0g.ai/tx/0x02e6c85a45c64618d425a859d2481154c42c78e056c5853ec9a90453c0645d2a
  balance  0.003791791989135636 -> 0.005848991988798236 0G
```

The solvency invariant holds on the live contract: balance
`0.00555 0G` equals `totalLiabilities()` `0.00555 0G` exactly.

## The deployed system settles a task on its own

The cycle above drove the workers in-process. This one did not: the API, both
verifier workers and the keeper were already running, and a single task was
posted through the API's own `POST /v1/tasks/prepare` and the creator's wallet.
Nothing else was touched.

```bash
node apps/api/dist/server.js &
VERIFIER_PROFILE=a node workers/verifier/dist/main.js &
VERIFIER_PROFILE=b node workers/verifier/dist/main.js &
node scripts/checks/post-task.mjs
```

Four minutes later, with no further input:

```
00:21:56  verifier-b  committed report   0x4f3fd56f…
00:22:01  verifier-a  committed report   0x7693fdca…
00:22:08  verifier-b  revealed  report   0x1fc4d8f0…
00:22:14  verifier-a  revealed  report   0x4c73860c…
00:24:08  CONSENSUS_EVALUATION  DONE
          FINALIZATION          DONE

PR-1006  CONSENSUS  2/2 agree  agreementBps 10000
  rewarded  0xe51db467…  0xeff4313a…
  allocated 0.0005 0G each — the whole bounty, split
  result    0g://0xc8c6d96dc8d7c7dcf629bdfda9406a9cc2521cb6578db5907706fe2dd284ea17
```

Two minutes later the dispute window closed and the keeper's permissionless
`finalizeTask` ran on its own, sweeping both allocations into
`pendingWithdrawals`; each verifier then withdrew and its balance moved:

```
verifier-a 0xeFf4313AD00b3aD7f3Be18c75Bc862CaA3d1e8FA
  withdrew 0.00075 0G   https://chainscan-galileo.0g.ai/tx/0xadc79c3ed4c8d643d56698d28960ff11d04767f01cf9e8a2b639ea4a62fcec37
  balance  0.007647859985646255 -> 0.008205059985308855 0G
```

Contrast with the conflicted task above, where each revealer got 0.00025 0G —
half of `conflictRateBps` — and the rest went back to the creator. Agreement
pays the whole bounty; disagreement does not.

Settling at the **consensus** rate rather than the conflict rate is the point.
Until the reveal projector was wired to enqueue `CONSENSUS_EVALUATION`, nothing
in the system produced that job — so `FINALIZATION` was unreachable and every
task, including one everybody agreed on, could only settle later through
`expireTask`, which pays the reduced conflict rate. Agreement would have been
silently unrewardable. That path is now covered by three tests in
`apps/api/src/indexer/indexer.test.ts`.

## The branches the happy path never reaches

`full-cycle.mjs` proves a task everyone agrees on settles and pays. It says
nothing about a creator who changes their mind, a result somebody challenges, or
a task nobody shows up for — and those are the paths that move money in unusual
directions.

```bash
npm run check:lifecycle          # every branch it can run now
```

### Cancel and refund

```
[A2] somebody who is not the creator tries to cancel it
    ✓ a non-creator cannot cancel — reverted
[A3] the creator cancels
    status               CANCELLED
    outcome              CANCELLED (5)
    allocationOf         0 0G
    pending              0 -> 0.0001 0G
    ✓ a cancellation allocates nothing — it credits the withdrawable balance
    ✓ the whole bounty became withdrawable, to the wei
[A4] the creator takes the refund
    contract paid out    0.0001 0G
    ✓ refundCreator pushed the creator's whole pending balance, not this task's share
    ✓ a second refund reverts
    ✓ withdraw with an empty balance reverts
    solvency             balance 0.001 0G  liabilities 0.001 0G
```

Executing this is what found the recon gap described below. Every assertion in
`[A3]` and `[A4]` would have passed against the design the rebuild assumed, and
every one of them was wrong.

### Challenge and adjudication

Run against Galileo on 2026-09-02. The task was posted by this script, verified
by the two **running** verifier workers and settled by the **running**
orchestrator — the script only challenged it and adjudicated.

```
[B2] the bond is priced by the chain, and a wrong one is refused
    bond                 0.0001 0G  (1000 bps of the bounty)
    ✓ a bond one wei short is refused
[B3] ✓ only the creator or a committed verifier may challenge
[B4] the creator prepares challenge evidence through the API and opens the challenge
    ✓ the API quoted the same bond the contract demands
    ✓ the bond is escrowed, to the wei
    ✓ the evidence hash onchain is the one the API stored
    ✓ a second challenge on the same task is refused
[B5] the adjudicator runs an independent third pass and resolves
    upheld               true
    decision             Challenge upheld. An independent second pass disagreed on 1
                         disputed verdict(s): claim-001: verifier-a said …
    ✓ the stored adjudication report hashes to what the chain recorded
[B6] who ends up with the money
    0xE51DB467…          +0.0009 0G
    0x33D2b4aA…          +0.0002 0G
    pool                 bounty 0.001 + bond 0.0001 = 0.0011 0G
    ✓ the challenger got its bond back plus 1000 bps of the bounty
    ✓ the pool is conserved
[B7] everybody collects
    verifier-b           withdrew 0.0009 0G
```

The adjudicator is a third pipeline configuration — evidence depth 4, support
threshold 0.45 — reading the same snapshotted bytes neither verifier's
configuration agreed on. It disagreed with one verifier on one claim, upheld the
challenge, and the contract reallocated the whole pool accordingly: the
challenger recovered its bond plus `challengerRewardBps`, and the verifier the
second pass agreed with took the rest. `0.0009 0G` really landed in
`0xE51DB467…`'s wallet.

### Expiry

A task nobody verifies has to be recoverable. When nothing is stranded on chain
the check strands something: a task with the shortest windows the contract
accepts, 30 s to commit and 30 s to reveal, and then whatever the deadline finds.
On a run where the verifiers did not finish in 60 s, that is an expiry:

```
[C1] nothing is stranded, so strand something
    windows              30s commit, 30s reveal — the contract minimum
    waiting              until 2026-09-02T05:02:04.000Z
    ...                  52s to the reveal deadline

    0xd8104dbd1a63e9385904d6f1153911344b17be20378db7e612c549e9c1caf7c0
    status               OPEN  revealed 0/2
    revealDeadline       1788325324  (2026-09-02T05:02:04.000Z)
    expireTask           legal — 0.0h since the reveal deadline
    status               EXPIRED
    outcome              EXPIRED (4)
    ✓ the task is Expired
    ✓ a task nobody revealed on expires as Expired
    creator holds        0.0001 0G  (allocated + withdrawable)
    ✓ at least the unspent bounty came back to the creator
```

Whether an expiry is due is asked of the contract — one `eth_call` — rather than
computed from parameters this repo decoded. That distinction is not academic:
the arithmetic said the call was illegal for another 31 hours and the contract
allowed it, which is how the missing grace period below was found.

On a run where they did finish, the same check asserts the other side of the
same rule — the contract refusing an expiry that is not due:

```
    0xb3b2577e23f31ce27c4b7bea194bbbe79c423def6ccf46cd4a0887e2b75866c0
    status               REVEALING  revealed 2/2
    expireTask           refused — The contract function "expireTask" reverted.
    ✓ the contract refuses an expiry that is not due yet
```

Which branch runs is not fixed, so both are asserted rather than one being
engineered. A full `npm run check:lifecycle` is 31 assertions across the three
branches.

`expireDispute` is still unexecuted. It needs an unresolved dispute past its
`adjudicationWindow`, and every dispute raised here was resolved by the
adjudicator within seconds.

## What executing those paths found

Three things, none of which any amount of reading would have surfaced.

**The deployed `cancelTask` and `refundCreator` do not work the way the rebuild
assumed.** Cancelling credits `pendingWithdrawals` directly — `allocationOf`
reads zero for the whole life of a cancelled task — and `refundCreator` pays the
creator's *entire* pending balance, not this task's share of it. That was proven
by cancelling two tasks and refunding one: the contract paid out both bounties.
Two events the ABI did not have, `TaskCancelled` and `RefundClaimed`, carry the
money; `getLogs` filters on known topics, so the indexer was not merely
mis-projecting them, it never fetched them. `Outcome` also runs past
`NoQuorum`: a cancelled task stores **5**. Details in
[docs/recon/RECOVERED_ABI.md](recon/RECOVERED_ABI.md); `npm run verify-abi` now
checks 14 events against real logs instead of 12.

**One task could starve the verifier of every other.** A task cancelled while
its report was being built makes `commitReport` revert, and `tick()` had no
per-task boundary, so the exception escaped and every task behind it in the
batch was skipped — silently, once per poll, for as long as the doomed task
stayed live. Seen live at 04:24:08 as `verifier tick failed: commitReport would
revert`. Fixed, and pinned by `workers/verifier/src/worker.test.ts`, which fails
without the fix.

**`expireTask` has no grace period, and the rebuild had invented one.** The
rebuilt contract required `revealDeadline + keeperGracePeriod`, three days on the
live parameters. The deployment requires only `block.timestamp > revealDeadline`.
Found by a probe that expected a revert, got a settled task instead, and then
bisected the transition against historical state: block 52360353, timestamp
exactly the reveal deadline, refused with `DeadlineNotPassed()` — a selector the
ABI did not have — and the next block, one second later, allowed it.

**The keeper waited out a grace period that does not exist.** Its rescue sweep
subtracted `params.keeperGracePeriod` before considering a stuck task, so a
bounty nobody verified sat stranded for three days the chain would have released
immediately. Same root cause as the item above, one layer up: a parameter this
repo decoded, trusted over the contract. Fixed, and pinned by three tests in
`apps/api/src/orchestrator/keeper.test.ts` that fail against the old arithmetic.

**A negative test that sends is not a probe.** The helper behind every "✓ …
reverts" line called the function and caught the throw, so on the one call that
did *not* revert it expired a live task it was only asking about. `ChainClient`
now has `simulate()`, which asks the node and sends nothing, and the checks use
it.

**`fund.mjs` did not survive Galileo's receipt lag.** It used a bare
`waitForTransactionReceipt`, so a run that funded every wallet correctly still
exited non-zero on a receipt that was not queryable yet. It now retries the way
`ChainClient.waitForReceipt` does.

## The indexer rebuilds the read model from the chain

```bash
npm run migrate && node scripts/checks/index-live.mjs
```

From an empty database, starting at the deployment block:

```
    19  tasks          62  artifacts        3  verifiers
    28  reports       173  chain events    11  consensus results     5  disputes

  PR-1002  status 7 outcome 2  manifest verified  acme-widgets maintenance release claim
  PR-1003  status 8 outcome 4  manifest verified  acme-widgets runtime requirement
  PR-1007  status 9 outcome 5  manifest verified  lifecycle — cancelled before any commitment
  PR-1013  status 7 outcome 3  manifest verified  lifecycle — challenged after settlement
  PR-1015  status 8 outcome 4  manifest verified  lifecycle — abandoned to the reveal deadline
  PR-1017  status 7 outcome 2  manifest verified  lifecycle — challenged after settlement
```

Every title came from a manifest fetched from 0G Storage and hash-checked
against the chain before it was stored. Nothing in that table was typed in.

This rebuild is also where the recovered events earn their place: outcomes 4 and
5 appear, and the six cancelled tasks carry their refunds. Before
`TaskCancelled` was in the ABI, `getLogs` filtered it out and a cancelled task
rebuilt as a task that refunded nobody.

## Test suites

| Suite | Count | Command |
|---|---:|---|
| Solidity | 148 | `forge test --root contracts` |
| TypeScript | 397 | `npx vitest run` |

The Solidity suite includes 10 fuzz properties and 5 stateful invariants
(solvency, value conservation, per-task allocation bounds, settled-task
completeness, and a reachability test so the other four are never asserted about
an empty contract).

## What is not verified

**0G Compute has not run a real inference.** `COMPUTE_DRIVER=local` and the
deterministic engine produced every report above. The router and broker drivers
are written and tested, and `/health` probes the router's live model catalog,
but a real call needs `COMPUTE_API_KEY`, which can only be created by connecting
a wallet at <https://pc.testnet.0g.ai>. Until that is set, PRD FR-08 is
unsatisfied and this document should not claim otherwise.

**`expireDispute` has not been executed against the deployment.** It needs a
dispute left unresolved past its `adjudicationWindow` — seven days on the live
parameters — and the adjudicator resolves every dispute this system raises
within seconds. It is covered by the Foundry suite, which can warp time.

**An expiry with a partial reveal set has not been observed.** A task nobody
revealed on stores `Outcome.Expired`; whether one with some reveals stores
`Conflict` is what the rebuilt source says and what the Foundry suite asserts,
not something the deployment has been asked.

**The frontend's write paths have not been driven end to end.** `createTask`,
`openChallenge`, `claimReward` and `withdraw` are wired through wagmi and
typecheck against the same ABI the backend verifies, and every server side of
those flows is exercised above — but signing from a browser wallet needs a human
at a browser, so the button-to-transaction path is untested.
