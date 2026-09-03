## What it does

ProofRelay is an onchain evidence market for AI claims, live on 0G mainnet.

You post a claim and a bounty. Independent verifiers fetch the same snapshotted
sources, build a claim–evidence graph, and commit their answers before any of
them can see another's. 0G Storage holds the artifacts, 0G Compute runs the
verification, and a contract on 0G Chain settles it — paying on agreement and
withholding on conflict.

It does not claim to know the truth. It makes the basis of an answer
inspectable: which bytes were read, when they were read, which model read them,
what each verifier concluded, and exactly where they disagreed.

## The problem it solves

An AI answer arrives with no basis you can check. "Verified by AI" is a claim
about a claim: citations can be fabricated, and a source can change after it was
read. Trusting one model means trusting whoever ran it.

ProofRelay makes disagreement a first-class outcome rather than something a
single confident answer hides. Verifiers commit a hash before they can see each
other, so agreement means *independent* agreement, not the first answer copied.
The bounty pays out on agreement, is cut on conflict, and any party to a task
can post a bond to challenge a result into a second-pass adjudication. Every
artifact is content-addressed, so a report either rehashes to what the contract
recorded or it is not evidence.

## Challenges I ran into

**A constant that was really an assumption.** The adjudicator turns the
seven-day dispute window into a range of blocks, and sized that range from a
cadence hardcoded at two seconds. 0G mainnet lands a block about every second,
so the scan reached barely five of the seven days a dispute has to live in — one
opened early would expire unseen. The cadence now comes from the chain itself.

**The mainnet model could not be seeded.** The compute router's mainnet catalog
is larger, but every provider serving the model we defaulted to advertises
`temperature` and not `seed`. This pipeline sends a seed on every completion, so
the default would have failed on every task — or worse, quietly returned
non-reproducible answers. Reading `/v1/providers` before trusting a catalog is
now part of the setup.

**A key rotation that looked done and was not.** `.env.local` and `.env.<role>`
win over `.env`. New keys written to `.env` were shadowed by old copies: the
addresses changed, every service kept signing with the key it had, and an audit
reading `.env` reported a separation that never happened. The fix was to make
the audit read *every* dotenv file rather than only the one it loaded.

**Failures that lie about themselves.** Mainnet reports receipt lag as "no
matching receipts found: this may indicate potential data corruption". It is not
corruption, and the retry pattern did not recognise the wording — so a transfer
that had already succeeded looked like a crash.

## Technologies I used

0G Chain (mainnet, 16661), 0G Storage, and 0G Compute — the Router
and the direct SDK broker path. Solidity 0.8.24 with Foundry. TypeScript
throughout: viem for chain access, Fastify for the API, Postgres for the read
model, React with Vite and wagmi for the Evidence Ledger UI. Five processes: the API
with its chain indexer and keeper, two verifiers, an adjudicator, and the web
app.

## How we built it

Contract first, with 169 Foundry tests — unit, negative, fuzz, and invariants
that assert value is conserved and escrow always covers liabilities.

The integrity rule shaped everything else: the contract stores a hash and 0G
Storage stores the bytes. The pointer only helps retrieval and is never the
integrity mechanism, because a 0G root hash is a merkle root over sectors, not a
function you can check a JSON document against.

Everything network-shaped is derived from one `CHAIN_ID` — RPC, explorer,
storage indexer, compute router and model, block cadence. `npm run verify-abi`
proves the deployed runtime is byte-for-byte the code this source compiles to,
not merely an interface that resembles it. `npm run doctor` checks the chain,
the contract, every role wallet, the verifier allow-list, storage, compute and
the database, and names the command that fixes each problem. The deploy script
refuses the wrong chain, refuses an unfunded deployer, runs the full contract
suite before broadcasting, and asks for a typed confirmation on mainnet.

## What we learned

**Measured beats estimated.** Our own cost figures were three times off until we
read them off real receipts. Deploying costs 0.018764 0G; one artifact into 0G
Storage costs 0.001182 0G. Guesses were budgeting real money.

**Availability roles still have economics.** The keeper looks optional because
the system survives without it — but if it runs dry, tasks fall to permissionless
expiry, which pays verifiers half the bounty and closes the dispute window for
good. A verifier that did the work gets half, with no remedy.

**A guard that cannot say why it fired is a bug.** Our mainnet confirmation
prompt aborted silently without a terminal, after a two-minute test run. Correct
behaviour, useless message.

**Separation is a property of the chain, not the config file.** Granting a role
without revoking the old one leaves two keys that both still work.

## What's next for ProofRelay

Both verifiers already run on 0G Compute; the next step is recording each
provider's TEE attestation in the published report, so a reader can check which
machine produced it. Then: the admin key moves to a multisig,
verifier diversity grows
past two with real staking and slashing rather than the parameters-only stubs
the MVP ships, and `prepare` stops writing artifacts on the operator's own
storage key — today every task's bytes are subsidised by whoever runs the API.
Longer term the adjudicator should be a panel, not one key: the honest limit
of the current design, and the one worth fixing next.


---

<!-- The blocks below are separate form fields, each with its own
     character limit. Copy one section at a time; do not paste this
     file as a single blob. -->

## Updates in this Wave

ProofRelay is live on 0G mainnet and has completed full verification cycles
there with real value at stake — not a recorded demo.

**See it yourself**
- App: https://proofrelay.nectiq.xyz
- API: https://api-proofrelay.nectiq.xyz/health
- Contract: `0xD3101C19175b50fD47C9e0B14A2dc63485f527D1` (chain 16661, block
  43394193) — https://chainscan.0g.ai/address/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1

**Which 0G infrastructure carries what**
- **0G Chain** holds ProofRelay.sol: it escrows the bounty, records each
  verifier's commitment hash, opens the reveal round, settles consensus, runs
  the dispute and adjudication windows, and allocates payouts. It stores the
  hash of every artifact and never the bytes.
- **0G Storage** holds those bytes — six content-addressed artifact types:
  source snapshots, task manifests, verifier reports, consensus results,
  challenge evidence and adjudication reports. 22 nodes, 0.001182 0G per
  object. The flow contract is read from the storage node's own status, so no
  address is hardcoded per network.
- **0G Compute** runs verifier inference, and both paths are built: the Router,
  which names the serving provider and can attest its TEE per request, and the
  direct SDK broker, where a verifier funds its own onchain ledger and signs
  its own billing headers. Both verifiers run on the Router today,
  against a seedable model whose TEE the router confirms per request.

**A full cycle, on mainnet.** Three tasks posted, three reached consensus:
artifacts into 0G Storage, `createTask`, two verifiers committing hashes before
either could see the other, revealing, keeper finalising. Escrow reconciles
exactly: 0.007 0G held against 0.007 0G owed, all three visible above.

**Provable, not just deployed.** `npm run verify-abi` shows the live runtime is
byte-for-byte the code this source compiles to: 19,775 bytes, 45 selectors
and 17 event topics read from real logs. Behind it: 169 Foundry tests including
invariants that value is conserved and escrow always covers liabilities, and
456 TypeScript tests.

**Built to be operated.** Admin, keeper, adjudicator and the storage payer hold
four distinct keys, granted at construction, so no key can pause the contract,
settle a task and pay itself. `npm run roles` audits who holds what
onchain and can revoke — revocation did not exist before, so a deployment begun
on one key had no way off it.

**Found by running, not planning.** The adjudicator sized its dispute scan
from a hardcoded block cadence and reached five of seven days; it now reads the
chain. Every provider serving our default compute model accepts `temperature`
but not `seed`, so the default moved to a seedable, TEE-attested one —
reproducibility is the product, and a silent fallback is worse than a failure.

Costs are read off receipts: createTask 0.000999 0G, commit 0.000604, reveal
0.000733.

## Milestone — 4th Wave

**Deepen 0G Compute.** Both verifiers now run on the Router with their own
credentials. Next: record the TEE attestation inside every published report so
a reader can check which machine produced a verdict, and move a verifier onto
the direct SDK broker so it pays for its own inference from its own onchain
ledger — a verifier is already an onchain identity, so its compute spend
should be too.

**Harden the operator.** Move the admin key to a multisig, and grant a second
pauser so an incident can be stopped without reaching for admin.

**Prove the contested path.** Post a task, challenge it with a bond, and drive
it through adjudication on mainnet — publishing the transactions, so the
dispute half of the protocol is demonstrated rather than described.

## Milestone — 5th Wave

**Open the verifier set.** Registration is self-service today but a task only
reaches an admin-approved verifier, and the slashing parameters ship at zero.
Replace the allow-list with real staking and slashing so a verifier's stake,
not an operator's approval, is what earns it work.

**A panel, not a key.** One adjudicator resolving disputes is the honest limit
of the current design. Move to a panel whose members are drawn per dispute and
paid from the forfeited bond.

**Stop subsidising storage.** `prepare` writes every artifact on the operator's
own key, so the operator funds each task's bytes. Make the creator pay for the
storage its own task consumes.

