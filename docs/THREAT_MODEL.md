# ProofRelay threat model

Expands architecture doc §20 with what is actually implemented and what is
explicitly deferred.

## Trust assumptions

| Component | Trusted? | Why it does not matter |
|---|---|---|
| Browser / wallet | No | Every state transition is validated by the contract |
| API | No | It holds no user funds and can only submit transactions the contract already permits |
| Keeper key | Partially | Chooses a classification, never an amount or a non-revealer beneficiary |
| Adjudicator key | Yes, scoped | Can reallocate a *disputed* task's reward, bounded by the bounty, with a stored reason hash |
| Verifier worker | No | Output is untrusted input: hash-checked, schema-validated, and discarded if either fails |
| Postgres | No | An index; rebuildable from chain events |
| 0G Storage | For availability only | Integrity comes from the content hash stored onchain, not from the pointer |

## Attacks and mitigations

### A verifier submits a fabricated report

**Mitigated.** The report is content-addressed and its hash is committed before
any other verifier's answer is visible. A verifier can lie, but it cannot lie
*consistently with another verifier by copying them*, and it cannot change what
it said afterwards. The consensus engine requires agreeing verifiers to cite
overlapping snapshots, so two independent lies must also coincide on evidence.

**Residual.** A single verifier that lies confidently and quotes a real span can
still be wrong; the product surfaces the evidence rather than claiming truth.
There is no slashing. `verifierSlashBps` is a reserved parameter that no code
path reads, and `VerifierRecord.slashed` is never written, so a verifier that
lies risks nothing it has staked. The allow-list is the only sanction: an admin
can revoke approval, which stops future commits but claws back nothing.

### A verifier copies another verifier's answer

**Mitigated.** `revealReport` reverts while any commit slot is open and the
commit window is running, so no report pointer is readable until every verifier
is committed. `commitReport` binds the commitment to `msg.sender`, so replaying
another verifier's commitment produces a `CommitmentMismatch` on reveal — this
is covered by a dedicated test.

### The keeper steals the bounty

**Mitigated.** `finalizeConsensus` derives every amount from the outcome:
`Consensus` splits the bounty among a duplicate-free subset of *revealed*
verifiers, `Conflict` pays a fixed reduced rate to everyone who revealed,
`NoQuorum` refunds in full. The keeper cannot name a beneficiary who did not
reveal, cannot name itself, and has no withdrawal path.

The self-payment refusal is an explicit check in `_requireRevealedSet`, not a
side effect of the keeper not being a verifier. Nothing stops the keeper key
from also being an approved verifier — the admin can approve one in a single
transaction — and it would otherwise have been able to reveal a report and then
name itself for the whole bounty. The same check covers the adjudicator on
`resolveDispute`.

**Residual.** A privileged key that is also a verifier is still paid by the
derived paths (`Conflict` and `expireTask` pay every revealer the same fixed
rate). It cannot choose that share, only trigger the branch.

**Residual.** The keeper can classify a genuine consensus as a conflict, which
underpays verifiers. The dispute path exists precisely for that, and any party
to the task can open it.

### The API is compromised

**Mitigated.** The API never holds the creator's key; `createTask`,
`openChallenge` and `claimReward` are signed in the browser. A compromised API
can serve wrong data, but every hash it shows is verifiable against the chain
and the UI marks chain-sourced values distinctly from derived ones.

**Residual.** A compromised API could serve a manifest whose claims differ from
what the creator typed. The creator signs `manifestHash` explicitly and the UI
shows the frozen claim list before escrow, so this is detectable at signing time.

### SSRF through a source URL

**Mitigated.** `SourceFetcher` allows only http/https on ports 80/443/8080/8443,
resolves the hostname and rejects any address in a private, loopback,
link-local, carrier-grade-NAT, multicast or reserved range — including
`169.254.169.254`. Redirects are followed manually and each hop is re-validated,
so a public host cannot bounce the fetcher into the metadata service. Responses
are size-capped while streaming. Tested directly.

### Stored HTML executing in the UI

**Mitigated.** Snapshots strip `<script>` and `<style>` before the text is
stored, and quoted spans render as text nodes in React. No `dangerouslySetInnerHTML`
exists in the codebase.

### Signature replay

**Mitigated.** The SIWE-style challenge binds domain, EIP-55 address, chain ID, a
single-use nonce and an expiry. The nonce is consumed transactionally *after*
signature verification, so a valid signature for a spent nonce is still
rejected. Cross-chain and expired challenges are rejected explicitly.

### Sybil verifiers

**Partially mitigated.** MVP uses an admin allow-list: `commitReport` requires
`approved && active`. Stake and slashing are **not** implemented: `registerVerifier`
accepts `msg.value` and enforces `minVerifierStake` (0 on the live deployment), but
nothing ever puts that stake at risk and `withdrawStake` has no floor and no lock,
so it can be withdrawn in full at any time — including while a commitment is open.
The allow-list is therefore the whole sybil defence, and it is only as strong as
the admin key. An open verifier market needs real stake, reputation and a much
larger anti-collusion story; that is post-MVP.

### Griefing a payout

**Mitigated.** All payouts are pull-based over `pendingWithdrawals`, guarded by a
reentrancy lock. A beneficiary contract that reverts on receive can only block
itself — tested. Verifier lists are bounded at 16, so no unbounded loop exists.

**Residual.** `pause()` blocks `revealReport`, so a pause held across a task's
reveal window strands verifiers that already committed: nobody reveals, the
window closes, and `expireTask` stores `Outcome.Expired` (enum value 4, not
`NoQuorum`) and returns the whole bounty to the creator. Escrow is not trapped
and nothing is stolen — the verifiers' reports were never published, so the
creator gains nothing either — but the pauser key can destroy a round's work.
Unpausing before the reveal deadline restores it, and `keeperGracePeriod` leaves
three further days before anyone may expire the task.

A task has exactly one dispute slot, first-come-first-served, so the **first half
of the dispute window belongs to the creator**: no verifier may challenge before
`consensusAt + disputeWindow / 2`. Without that, the party a challenge exists to
check could monopolise the remedy — a verifier that knows its own report was
fabricated opens a bogus challenge the instant consensus lands, burns the slot,
lets it expire, and the fraudulent reward stands. It stays symmetric: where the
harmed party is the verifiers rather than the creator (a keeper that
misclassified a genuine consensus), the creator has no reason to challenge and
the slot reaches them with half the window still to run. `expireDispute` also
forfeits `adjudicatorSplitBps` of an unanswered challenge's bond to the verifiers
it froze, so burning the slot is no longer free.

**Residual.** A creator that is not watching during its own half loses priority,
and the window is whatever it chose at `createTask` — a 30-second
`disputeWindowSec` gives each side 15 seconds. Pick a window you can actually
act inside.

`openChallenge` is deliberately **not** pausable. PAUSER_ROLE is granted to the
admin, and on a single-key deployment that is also the keeper — so a pausable
challenge let the party a challenge exists to check censor the check itself,
while `_disputeDeadline` kept running on wall-clock time and closed the window
for good.

### Trapping escrow

**Mitigated.** Every terminal path is reachable without a privileged key:
`finalizeTask` and `expireTask` and `expireDispute` are all permissionless once
their deadline passes, and `pause()` deliberately does not block them.
The invariant `address(this).balance >= totalLiabilities` is asserted by a
stateful invariant suite over randomized action sequences.

### Denial of service through large tasks

**Mitigated.** Source fetches are size- and time-capped, pointers are capped at
256 bytes onchain, verifier count is capped at 16, claims at 50, sources at 20,
the API body limit is 2 MB, and rate limiting is applied per IP.

Keying the limiter on the wallet when one was proved used to invert this: nothing
gates who may hold a session — `POST /v1/auth/nonce` issues a challenge for any
address it is asked for, and a wallet is a keypair anyone generates offline for
free — so signing in handed the caller a *fresh* bucket and multiplied its quota,
while a NAT'd office shared one. Client IP resolution is `TRUST_PROXY_HOPS`,
which defaults to 0; a deployment behind a TLS terminator must set it, or every
anonymous caller in the world resolves to the proxy and shares one bucket.

### Personal data in a public artifact

**Mitigated for the obvious cases.** `/v1/tasks/prepare` rejects inputs matching
email addresses, payment card numbers, phone-number-with-context, national ID
patterns and private-key-with-context, returning `PERSONAL_DATA_REJECTED`. The
manifest records `publicDataOnly: true`.

**Residual.** This is a demo guardrail, not a DLP product. Anything uploaded to
0G Storage is public and permanent. The UI states this.

### Source poisoning

**Partially mitigated.** A source is snapshotted once and hashed; every verifier
reads the same bytes, so a source that changes mid-task cannot split the
verifiers. A source that was *already* wrong when snapshotted will be quoted
faithfully — which is the honest outcome: ProofRelay reports what the source
says, with a pointer to it.

## Deliberately out of scope for the MVP

- Private or encrypted inputs, and confidential compute
- An open, permissionless verifier market with economic security
- Cross-source truth arbitration beyond verdict and evidence overlap
- Formal verification of the contract
- Reorg-safe finality tuning beyond a confirmation delay

## Contract test coverage

| Class | Tests | Examples |
|---|---:|---|
| Unit | 39 | creation, commit/reveal, consensus, conflict, dispute, expiry, registry, pause |
| Negative | 88 | wrong salt, replayed commitment, early reveal, late reveal, double claim, non-keeper finalize, rewarding a non-revealer, a keeper or adjudicator that is itself a revealed verifier naming itself, duplicate beneficiary, insufficient bond, unauthorized admin |
| Fuzz | 10 | escrow conservation, payout conservation, commitment binding, id uniqueness, bond scaling |
| Invariant | 5 | solvency, value conservation, per-task allocation bounds, terminal settlement, and a reachability test so the four above are never asserted about an empty contract |
| Cross-check | 4 | `taskId` and commitment encodings pinned against the deployed contract and the TypeScript client |

`forge test` — 146 tests, all passing.
