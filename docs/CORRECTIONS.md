# Reporting a verdict you think is wrong

A ProofRelay verdict is written by language models reading snapshotted text, with
no human review. It can be wrong, and this page says what to do about it.

It exists because of a specific obligation. Each settled task publishes
structured data naming `proofrelay.nectiq.xyz` as the author of its ratings, so
a verdict can be read by tools outside this site. Claiming that authorship
without somewhere to send a complaint would be claiming an accountability that
cannot be discharged.

## What cannot happen

**The verdict cannot be deleted or edited.** The report artifacts are
content-addressed on 0G Storage and their hashes are committed on 0G Chain. That
is the point of the design, and it applies to a wrong answer exactly as it
applies to a right one. Nothing on this page will make a published verdict
disappear.

## The route that carries weight

**Open a challenge, if you are a party to the task.** `openChallenge` is bonded
and adjudicated onchain, and it is the only mechanism that changes a settlement.
The contract restricts it to the task's creator and to verifiers that committed
on it, so it is not open to a reader who merely found the result.

**Post the claim as a new task.** Anyone can. A fresh task snapshots the sources
again, asks a different set of verifiers, and settles publicly. If the original
was wrong for a reason that still holds, this is what demonstrates it — and the
result is as citable as the one it contradicts. It costs a bounty, which is the
honest price of a second opinion in a market that pays its verifiers.

## The route for everyone else

Open an issue at
<https://github.com/nodesproof/proofrelay/issues> with the task id and what you
believe the sources actually say.

What happens to it:

1. **The claim is re-checked against the snapshot**, not against the live page.
   The snapshot is what the verifiers read; its hash is in the manifest and you
   can fetch it yourself. A verdict faithful to a snapshot that no longer matches
   the source is a different finding from a verdict that misread it.
2. **If the pipeline is at fault, the fault is fixed and named.** Retrieval that
   never surfaced the relevant paragraph, a prompt that taught a token the parser
   refuses, a model returning a confidence that voids its own vote — all three
   have happened, and all three are in the commit history under the task that
   exposed them.
3. **The issue stays open and public either way.** A verdict that cannot be
   retracted should at least be searchable next to the argument against it.

There is no private channel and no correction that is not visible.

## What is not a correction

The system publishing `INSUFFICIENT_EVIDENCE`, or settling `CONFLICT`, is not an
error. Those are answers. A market that can only return an opinion is not
measuring anything, and refusing to assert a claim the sources do not settle is
the behaviour this design exists to produce.

Nor is disagreement with a verdict's *scope*. A verdict is an entailment
judgement about the retrieved spans, not a finding of fact about the world — see
[How a verdict is produced](VERIFICATION.md#how-a-verdict-is-produced). If the
retrieved spans were the wrong ones, that is a retrieval fault and worth
reporting under (1). If they were the right ones and the claim is still
misleading in a wider context, the system did what it says it does, and the
answer is a better-posed claim.
