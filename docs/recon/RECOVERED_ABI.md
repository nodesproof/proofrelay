# Recovered ABI — ProofRelay @ 0xc1E353cb44eA09729143f06Af97E51FB952b33D7 (0G Galileo, chainId 16602)

The contract source was lost with the rest of the backend; the deployment survives.
This ABI was recovered from the deployed bytecode (PUSH4 selector extraction),
real on-chain calldata (4 createTask, 6 commitReport, 6 revealReport, 1 openChallenge,
3 finalizeConsensus, 1 resolveDispute, 2 registerVerifier, 2 setVerifierApproval),
event topics from `eth_getLogs`, and live `eth_call` struct returns.

Deploy block 52352124. Unpaused. Holds 0.0094 0G of live escrow.

## State-changing functions (confirmed against real calldata)

| Selector | Signature |
|---|---|
| `0xc84cdccb` | `createTask((uint32,uint32,uint32,uint32,bytes32,string,bytes32))` payable |
| `0x454d8929` | `commitReport(bytes32,bytes32)` |
| `0x8d1bba6a` | `revealReport(bytes32,bytes32,string,bytes32)` |
| `0xadac7b6e` | `openChallenge(bytes32,bytes32,string)` payable |
| `0xd779e0b2` | `finalizeConsensus(bytes32,bytes32,uint8,address[],uint16)` |
| `0x52f89692` | `resolveDispute(bytes32,bool,bytes32,string,address[],bytes32)` |
| `0x4c720f77` | `finalizeTask(bytes32)` |
| `0x5697a2ec` | `expireTask(bytes32)` |
| `0x83f14c6c` | `expireDispute(bytes32)` |
| `0xee8ca3b5` | `cancelTask(bytes32)` |
| `0x372c9601` | `refundCreator(bytes32)` |
| `0xf5414023` | `claimReward(bytes32)` |
| `0x3ccfd60b` | `withdraw()` |
| `0x508450a9` | `registerVerifier(bytes32,string)` payable |
| `0x8a63f9b8` | `setVerifierActive(bool)` |
| `0x32f9610c` | `setVerifierApproval(address,bool)` |
| `0x25d5971f` | `withdrawStake(uint256)` |
| `0x8456cb59` / `0x3f4ba83a` | `pause()` / `unpause()` |
| `0x2f2ff15d` / `0xd547741f` / `0x91d14854` | `grantRole` / `revokeRole` / `hasRole(bytes32,address)` |

## Views (struct layouts confirmed by live eth_call)

`getTask(bytes32)` `0x15a29035` → 16 fields, last is dynamic:
`(address creator, uint96 bounty, uint32 verifierCount, uint32 commitDeadline,
  uint32 revealDeadline, uint32 disputeWindow, uint32 consensusAt, uint32 committed,
  uint32 revealed, uint16 rewardBps, uint8 status, uint8 outcome, bytes32 manifestHash,
  bytes32 ruleId, bytes32 resultHash, string manifestPointer)`

`getReport(bytes32,address)` `0x23cef857` →
`(address verifier, bytes32 commitment, bool revealed, bytes32 reportHash,
  string reportPointer, uint32 committedAt, uint32 revealedAt)`

`getVerifier(address)` `0x059ce95d` →
`(bool registered, bool approved, bool active, uint96 stake, uint96 slashed,
  bytes32 metadataHash, string metadataPointer)`

`getDispute(bytes32)` `0x136ba6aa` → 11 fields:
`(address challenger, uint96 bond, bytes32 evidenceHash, string evidencePointer,
  bool resolved, bool upheld, uint8 outcome, uint32 openedAt, uint32 deadline,
  bytes32 adjudicationHash, string adjudicationPointer)`

Other views: `getTaskVerifiers(bytes32)` `0x3af0d66c` → `address[]`,
`allocationOf(bytes32,address)` `0x35146263`, `pendingWithdrawals(address)` `0xf3f43703`,
`creatorNonce(address)` `0x2fc0e2b7`, `totalLiabilities()` `0xf73579a9`,
`computeCommitment(bytes32,address,bytes32,bytes32)` `0xe563f4cc`,
`params()` `0xcff0ab96` → 10 numeric fields.

Constants: `MIN_WINDOW()`=30, `MAX_WINDOW()`=2592000, `MIN_VERIFIERS()`=2,
`MAX_VERIFIERS()`=16, `MAX_DISPUTE_WINDOW()`=2592000, `BPS_DENOMINATOR()`=10000,
`MAX_POINTER_BYTES()`=256.

Roles: `KEEPER_ROLE()`=`0xd4d16a49…`, `ADJUDICATOR_ROLE()`=`0xb4022bc6…`,
`PAUSER_ROLE()`=`0x4df6ff9a…`, `DEFAULT_ADMIN_ROLE()`=0.

Live `params()`: conflictRateBps 5000, challengeBondBps 1000, ?1000, ?5000,
verifierSlashBps 0, minBounty 1e14 wei, ?0, ?259200 (3d),
adjudicationWindow 604800 (7d), ?604800.

The 8th field was read as `keeperGracePeriod`, but `expireTask` does not consult
it — see below — so what it governs is unknown. Nothing in this repo uses it.

## Events (topic0 confirmed against real logs)

| topic0 | Signature |
|---|---|
| `0x3d9dbf9a…` | `TaskCreated(bytes32 indexed,address indexed,uint256,bytes32,bytes32)` |
| `0xcfb9696d…` | `TaskManifest(bytes32 indexed,string,uint32,uint32,uint32)` |
| `0x001799db…` | `ReportCommitted(bytes32 indexed,address indexed,bytes32)` |
| `0x8c19f55e…` | `ReportRevealed(bytes32 indexed,address indexed,bytes32,string)` |
| `0xbd355960…` | `ChallengeOpened(bytes32 indexed,address indexed,bytes32)` |
| `0x8dea753e…` | `ConsensusReached(bytes32 indexed,bytes32,uint8,uint16,uint32)` |
| `0xfe0cd2ac…` | `TaskFinalized(bytes32 indexed,bytes32,uint8)` |
| `0x41d878d4…` | `RewardAllocated(bytes32 indexed,address indexed,uint256)` |
| `0x9954d682…` | `TaskCancelled(bytes32 indexed,address indexed,uint256)` |
| `0xe950d47b…` | `RefundClaimed(bytes32 indexed,address indexed,uint256)` |
| `0xa95e3f63…` | `DisputeResolved(bytes32 indexed,bool,bytes32,string)` |
| `0x802d068f…` | `VerifierRegistered(address indexed,bytes32,string,uint256)` |
| `0x339a4be7…` | `VerifierApprovalSet(address indexed,bool)` |
| `0x2ae6a113…` | `RoleGranted(bytes32 indexed,address indexed)` |
| `0x530312ca…` | params-updated event, 10 numeric fields, name unrecovered (deploy-time only, not indexed) |

## Settlement semantics recovered from live calldata (not documented anywhere else)

These were read off the three real `finalizeConsensus` calls and the one real
`resolveDispute` call on Galileo, and are pinned by tests in
`contracts/test/ProofRelayEncoding.t.sol`.

- **Challenge bond is exact.** `bond == bounty * challengeBondBps / 10_000`, and
  `openChallenge` requires `msg.value` to equal it. The live challenge sent
  4e14 wei against a 4e15 wei bounty at 1000 bps.

- **Conflict and NoQuorum take an EMPTY beneficiary array and `rewardBps = 0`.**
  The contract derives the conflict rate itself from `conflictRateBps` and pays
  everyone who revealed. A keeper that passes a beneficiary set on those two
  outcomes is rejected. Only `Consensus` names beneficiaries, and then
  `rewardBps` is the share of the bounty they split.

- **`resolveDispute` overwrites `task.resultHash` with the `reasonHash`** and
  settles the task in the same transaction. The live `TaskFinalized` for the
  disputed task carried the reason hash, not the consensus result hash — so a
  reader looking for the consensus artifact of a disputed task must follow the
  dispute's `adjudicationPointer`, not `resultHash`.

- **Cancellation credits `pendingWithdrawals` directly.** `cancelTask` does not
  allocate: `allocationOf(taskId, creator)` reads zero for the whole life of a
  cancelled task, while `pendingWithdrawals(creator)` grows by the full bounty
  in the same transaction. It stores `outcome = 5` and emits
  `TaskCancelled(taskId, creator, bounty)` followed by
  `TaskFinalized(taskId, 0x0, 5)`.

  That fixes the `Outcome` enum at `Cancelled = 5`, and expiring a task nobody
  revealed on stored `4` — so `Expired = 4` is observed too, not inferred.

- **`refundCreator` pays the creator's whole pending balance.** It is
  `withdraw()` with a task-scoped event, not a per-task claim. Proven by
  cancelling two tasks and calling `refundCreator` on one: the contract paid out
  both bounties (0.0002 0G against a 0.0001 0G task) and left nothing pending.
  It emits `RefundClaimed(taskId, creator, amount)` where the amount belongs to
  no single task — so it must not be projected into a per-task ledger.

- **`expireTask` waits for the reveal deadline and nothing more.** There is no
  keeper grace period on the deployment, whatever the `params()` field decoded
  as `keeperGracePeriod` is for. Bisected against historical state on the live
  task `0x6d054dca…`: block 52360353 (timestamp `1788177384`, exactly its
  `revealDeadline`) refused, and block 52360354 one second later allowed it.
  The refusal is `DeadlineNotPassed()` (`0x2eb35430`) — a 13th error selector,
  and not the `WindowNotElapsed()` the rebuild used.

- **`withdraw()` with an empty balance reverts `NothingToWithdraw()`**
  (`0xd0d04f60`), not `NothingToClaim()`. Observed live. `verify-abi` still
  lists `NothingToWithdraw` under "only in the rebuilt source" because it scans
  the bytecode rather than observed reverts; the selector is nevertheless the
  deployment's own.

- **Upheld challenge:** the challenger receives its bond back plus
  `challengerRewardBps` of the bounty; the remainder goes to the verifiers the
  adjudicator named. The live resolution paid 8e14 and 3.6e15, summing exactly
  to bounty + bond.

## Custom errors: partially recovered

Twelve of the deployed contract's error selectors were recovered by scanning the
bytecode and are in the ABI. The rebuilt `contracts/src/ProofRelay.sol` compiles
34 — it adds guards the original did not have, and names some conditions
differently.

The scan understates the overlap: `NothingToWithdraw()` (`0xd0d04f60`) was
returned by a live revert but does not appear in the scan's results, so a name
on the "only in the rebuilt source" list is not evidence that the deployment
lacks it.

That is a decoding gap, not a compatibility gap. Calls, returns and events all
match exactly; what differs is that a revert from the *live* contract whose
selector is not in our ABI surfaces as raw hex instead of a name.
`extractRevertReason` in the chain client falls back to the raw message for that
case, so the failure is still legible — just less specific.

`npm run verify-abi` prints the coverage and names the errors that exist only in
the rebuilt source.
