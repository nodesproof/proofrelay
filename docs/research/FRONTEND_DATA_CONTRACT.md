# ProofRelay — Frontend Live-Data Contract

> **Build-time notes.** Written while working out the web app's data contract, in early
> September 2026, against 0G's test network. Kept as a record of what was
> learned rather than updated to describe the mainnet deployment; where an
> endpoint or address here differs from `README.md`, the README is current.

**Scope:** every mock/hardcoded value rendered by `proofrelay-frontend/client/src/`, mapped to a concrete live source (API field or onchain read) and its derivation.
**Deployment under contract:** `ProofRelay @ 0xc1E353cb44eA09729143f06Af97E51FB952b33D7`, 0G Galileo, chainId **16602**, deploy block **52352124**, RPC `https://evmrpc-testnet.0g.ai`, explorer `https://chainscan-galileo.0g.ai`.

Files read in full: `App.tsx`, `main.tsx`, `const.ts`, `components/DashboardLayout.tsx`, `pages/{Overview,VerificationTasks,VerifierNetwork,Artifacts,ActivityLog,ProtocolDocs,Home,NotFound}.tsx`, `index.css` (53 KB), `contexts/ThemeContext.tsx`, `vite.config.ts`, `server/index.ts`, `shared/const.ts`, plus all 42 canonical artifacts in `.proofrelay/storage/` and the six docs.

---

## 0. Ground truth available to the frontend

There are exactly **three** sources of truth, and the UI must visually distinguish them (PRD §11 "Transparency", THREAT_MODEL "the UI marks chain-sourced values distinctly from derived ones").

### 0.1 Chain (authoritative)

| Read | Selector | Returns |
|---|---|---|
| `getTask(bytes32)` | `0x15a29035` | `(address creator, uint96 bounty, uint32 verifierCount, uint32 commitDeadline, uint32 revealDeadline, uint32 disputeWindow, uint32 consensusAt, uint32 committed, uint32 revealed, uint16 rewardBps, uint8 status, uint8 outcome, bytes32 manifestHash, bytes32 ruleId, bytes32 resultHash, string manifestPointer)` |
| `getReport(bytes32,address)` | `0x23cef857` | `(address verifier, bytes32 commitment, bool revealed, bytes32 reportHash, string reportPointer, uint32 committedAt, uint32 revealedAt)` |
| `getVerifier(address)` | `0x059ce95d` | `(bool registered, bool approved, bool active, uint96 stake, uint96 slashed, bytes32 metadataHash, string metadataPointer)` |
| `getDispute(bytes32)` | `0x136ba6aa` | `(address challenger, uint96 bond, bytes32 evidenceHash, string evidencePointer, bool resolved, bool upheld, uint8 outcome, uint32 openedAt, uint32 deadline, bytes32 adjudicationHash, string adjudicationPointer)` |
| `getTaskVerifiers(bytes32)` | `0x3af0d66c` | `address[]` |
| `allocationOf(bytes32,address)` | `0x35146263` | `uint256` |
| `pendingWithdrawals(address)` | `0xf3f43703` | `uint256` |
| `totalLiabilities()` | `0xf73579a9` | `uint256` |
| `params()` | `0xcff0ab96` | 10 numerics — live: `conflictRateBps 5000, challengeBondBps 1000, ?1000, ?5000, verifierSlashBps 0, minBounty 1e14, ?0, ?259200, adjudicationWindow 604800, ?604800`. The 8th was read as `keeperGracePeriod`; `expireTask` does not use it, so its role is unknown. |
| `paused()` | `0x5c975abb` | `bool` |
| `hasRole(bytes32,address)` | `0x91d14854` | `bool` |

Events indexed from block 52352124 (idempotency key `(chainId, txHash, logIndex)`): `TaskCreated`, `TaskManifest`, `ReportCommitted`, `ReportRevealed`, `ChallengeOpened`, `ConsensusReached`, `TaskFinalized`, `RewardAllocated`, `DisputeResolved`, `VerifierRegistered`, `VerifierApprovalSet`, `RoleGranted`.

### 0.2 0G Storage (canonical artifacts, six kinds only)

Confirmed from the 42 surviving objects. **Object address = 0x-prefixed 32-byte canonical hash of the sorted-key JSON**; storage key is that hex without `0x` sharded `aa/bb/aabb….json`; each has a `.meta.json` sidecar `{ kind, byteLength }`; pointer is `local://<hexNo0x>` under `STORAGE_DRIVER=local` and a 0G root hash under `zerog`.

| kind | count | key fields |
|---|---:|---|
| `task-manifest` | 9 | `manifestId, title, question, answerText, creator, chainId, claims[]{claimId,claimText,origin}, sources[]{sourceId,uri,status,contentHash,byteLength,snapshotHash,snapshotPointer}, policy{verifierCount,commitWindowSec,revealWindowSec,disputeWindowSec,maxEvidencePerClaim,ruleId}, safety{publicDataOnly,redactions,warnings}, extraction, producer, schemaVersion, createdAt` |
| `source-snapshot` | 17 | `sourceId, uri, status, httpStatus, contentType, headers, byteLength, contentHash("sha256:…"), text, truncated, retrievedAt, error, producer` |
| `verifier-report` | 8 | `taskId, manifestHash, manifestPointer, verifier{address,modelId,pipelineVersion,verifierId}, claims[]{claimId,claimText,verdict,confidence,reasoningSummary,createdAt,sources[]{uri,snapshotObjectId,contentHash,quotedSpan,score,spanStart,spanEnd,retrievedAt}}, compute[]{requestId,operation,provider,modelId,pipelineVersion,inputHash,outputHash,latencyMs,attempts,rawArtifactPointer,verified}, graph{nodes[],edges[]}, summary{supported,contradicted,insufficient,evidenceCoverage,meanConfidence}` |
| `consensus-result` | 4 | `taskId, manifestHash, ruleId, outcome("CONSENSUS"\|"CONFLICT"), agreementBps, claims[]{claimId,claimText,majorityVerdict,agreed,agreeingVerifiers[],dissentingVerifiers[],verdicts[]{verifier,verdict,confidence},evidenceCoverage,evidenceOverlap,criticalConflict,reason}, conflicts[], reportHashes[], rewardedVerifiers[], evaluatedAt, producer` |
| `challenge-evidence` | 2 | `taskId, challenger, reason, disputedClaims[], disputedReportHashes[], additionalEvidence[], createdAt` |
| `adjudication-report` | 2 | `taskId, adjudicator, challengeHash, upheld, decision, claims[](claim shape), compute[], revisedRewardedVerifiers[], createdAt` |

Verdict enum is exactly `SUPPORTED | CONTRADICTED | INSUFFICIENT_EVIDENCE`. **There is no `evidence-graph` object and no image/PNG object kind** — the graph lives inside `verifier-report.graph`.

### 0.3 Postgres read model (index only, rebuildable)

`tasks`, `reports`, `jobs` per ARCHITECTURE §13, plus (required by this UI, must be added): `chain_events`, `consensus_results`, `disputes`, `indexer_state`, and

```sql
CREATE TABLE artifacts (
  content_hash   TEXT PRIMARY KEY,       -- 0x… canonical object hash
  kind           TEXT NOT NULL,          -- the six kinds above
  task_id        BYTEA,
  pointer        TEXT NOT NULL,
  byte_length    BIGINT NOT NULL,        -- from the .meta.json sidecar
  producer       TEXT,
  artifact_created_at TIMESTAMPTZ,       -- from the JSON body
  first_seen_block BIGINT, first_seen_tx TEXT,
  hash_verified  BOOLEAN NOT NULL
);
```

---

## 1. The exhaustive mock-data table

### 1.1 `components/DashboardLayout.tsx` — chrome on **every** page

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| All | `<img src={proofMark}>` in `.brand-symbol` | `/manus-storage/proofrelay-mark_6358cf06.png` | static asset | Move to `client/public/`. The `/manus-storage` Vite proxy (`vitePluginStorageProxy`) needs `BUILT_IN_FORGE_API_KEY` and **does not exist in prod** (`server/index.ts` serves static only) — this image 404s on deploy. |
| All | `style={{"--paperTexture": "url(/manus-storage/proofrelay-paper-texture_e264206f.png)"}}` | manus proxy URL | static asset | Same; inline as a data URI or `public/`. |
| All | `.brand-name` `Proof<span>Relay</span>`, `.brand-caption` `VERIFIABLE AI WORK` | static | — | Keep static. |
| All | `.workspace-switcher` → `.workspace-avatar` `A` | `"A"` | `useAccount().address` | Jazzicon/blockie seeded on the checksummed address; **no workspace entity exists in the contract**. See §4. |
| All | `.workspace-copy > span` | `Atlas Research` | `useAccount()` + optional ENS | `ensName ?? shortAddress(address)`; label the rail "Signer", not "Workspace". |
| All | `.workspace-copy > small` | `Personal workspace` | derived | `hasRole(ADJUDICATOR_ROLE,a) ? "Adjudicator" : hasRole(KEEPER_ROLE,a) ? "Keeper" : getVerifier(a).registered ? "Verifier" : "Task creator"`. |
| All | `.nav-item` labels/paths (`routes` array) | 6 hardcoded routes | static | Keep static — routes are app structure, not data. |
| All | `.nav-count` on "Verification tasks" | `"12"` | `GET /v1/stats/overview → nav.openTasks` | `SELECT count(*) FROM tasks WHERE status IN ('Open','Revealing','Consensus','Disputed')` (scope to `creator = :wallet` when connected). |
| All | `.nav-count` on "Artifacts" | `"28"` | `GET /v1/stats/overview → nav.artifacts` | `SELECT count(*) FROM artifacts` (scoped to `task_id IN (my tasks)` when connected). |
| All | `.network-card` `.network-label` text | `0G Galileo testnet` | `GET /health → chainId` + `wagmi useChainId()` | Name from a chain registry keyed on `chainId`; render a mismatch banner when `walletChainId !== apiChainId` (RUNBOOK "the header names the network your wallet is on"). |
| All | `.network-label > .live-dot` | always lit lime | `GET /health → dependencies.chain.ok` | Lime when `ok && chain_sync_lag_blocks <= INDEXER_CONFIRMATIONS`; coral otherwise; grey while the fetch is in flight. |
| All | `.network-row` `Connection` / `<strong>Healthy</strong>` | `"Healthy"` | `GET /health` | `res.status===503 ? "Down" : (indexer.running && lag<=2 && deps all ok) ? "Healthy" : "Degraded"`. Tooltip = `dependencies.*.detail`. |
| All | `.network-row` `Latest block` / `<strong>#1,945,822</strong>` | `#1,945,822` | `wagmi useBlockNumber({watch:true})` **or** `GET /v1/chain/head → blockNumber` | `#${blockNumber.toLocaleString()}`. Real Galileo head is ≈52.4M — the mock is 27× too small and will look obviously fake next to the explorer. |
| All | `.breadcrumb` `<span>Workspace</span>` | `"Workspace"` | static | Rename to the network or signer label; there is no workspace object. |
| All | `.breadcrumb > strong` | `{title}` prop | route table | Static per route. |
| All | `.network-chip` `0G testnet` + `.live-dot` | static | `GET /health → chainId`, `dependencies.chain.ok` | Same as the rail card; chip text = short chain name. |
| All | `.notification-badge` | `"2"` | `GET /v1/stats/overview → actionable.total` | `disputesOnMyTasks + claimableTasks + (pendingWithdrawals(a) > 0 ? 1 : 0)`. Hide the badge at 0. |
| All | Bell `onClick` toast `"No new alerts"` / `"Your task queue is clear."` | static toast | `GET /v1/stats/overview → actionable.items[]` | Replace the toast with a popover listing `{kind:'DISPUTE_OPEN'\|'REWARD_CLAIMABLE'\|'WITHDRAWAL_PENDING'\|'REVEAL_DUE', taskId, deadlineTs}`. |
| All | `.wallet-button` label | `"Connect wallet"` / `"0x7A…8C21"` | `wagmi useAccount()` | `isConnected ? shortAddress(address) : "Connect wallet"`; `.connected` class from `isConnected`. |
| All | Wallet toast `"Wallet connected" / "Connected as 0x7A…8C21"` | fake `setConnected(!connected)` | wagmi `useConnect`/`useDisconnect` | Real connector modal; toast only on the resolved promise. |
| All | `.user-row` `.user-avatar` `AR` | `"AR"` | `useAccount().address` | Address-derived identicon. |
| All | `.user-copy > span` | `0x7A…8C21` | `useAccount().address` | `shortAddress()`. |
| All | `.user-copy > small` | `Connected wallet` / `Demo wallet` | `useAccount().status` | `connected \| connecting \| reconnecting \| disconnected`; never "Demo". |
| All | `.user-row` toast `"Demo wallet" / "Wallet controls are simulated…"` | static | — | Replace with a menu: Copy address, View on explorer, Withdraw (`pendingWithdrawals`), Disconnect. |
| All | `.footer-strip > div` `ProofRelay protocol preview` | static | build metadata | `${APP_NAME} ${__GIT_SHA__}` + contract address link. |
| All | `.footer-links > span` `0G Storage connected` | static | `GET /health → dependencies.storage.ok` + `drivers.storage` | `` `0G Storage ${drivers.storage} · ${ok ? "connected" : "unavailable"}` ``; tooltip `dependencies.storage.detail`. |
| All | `.footer-links > span` `.live-dot` + `Compute ready` | static | `GET /health → dependencies.compute.ok` + `drivers.compute` | Same pattern; `drivers.compute ∈ {zerog-router, zerog-broker, local}` must be shown — RUNBOOK requires the driver to be visible when falling back to `local`. |
| All | `.footer-links > span` `Canonical artifacts` | static | `GET /v1/stats/overview → artifacts.hashVerifiedPct` | `` `Canonical artifacts ${pct}%` ``. |
| All | `.page-heading .overline` (`eyebrow` prop) / `h1` (`title` prop) | static per page | route table | Static. |

### 1.2 `pages/Overview.tsx`

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| Overview | `.hero-title` / hero `<p>` | "Make every answer / earn its confidence." + blurb | static marketing copy | Keep. |
| Overview | `.hero-visual > img` | `/manus-storage/proofrelay-evidence-graph_9594542b.png` | static asset | Move to `public/`; or replace with a real SVG rendered from `verifier-report.graph.{nodes,edges}` of the selected task. |
| Overview | `.visual-caption > span` `LIVE EVIDENCE GRAPH` | static | — | Only honest if the graph is real (see §4). |
| Overview | `.visual-caption > strong` | `2 verifiers · 1 settlement` | `GET /v1/tasks/{id}` | `` `${task.revealed}/${task.verifierCount} verifiers · ${task.status==='Finalized'?1:0} settlement` ``. |
| Overview | `.visual-corner.top-left` | `0G / PROOF-01` | decorative | Substitute `` `0G / ${shortTaskId}` ``. |
| Overview | `.visual-corner.bottom-right` | `hash anchored` | `GET /v1/tasks/{id} → manifestHash` | Show only when `manifestHash !== 0x0`; else "manifest pending". |
| Overview | `<Metric label="Active tasks" value="12">` `.metric-value` | `"12"` | `GET /v1/stats/overview → tasks.active` | `count(tasks WHERE status NOT IN ('Finalized','Expired','Cancelled'))`. |
| Overview | that card's `.metric-helper` | `3 need your review` | `→ tasks.needsYourAction` | `count(tasks WHERE (creator=:w AND status='Disputed') OR (:w is approved verifier AND getReport(task,:w).commitment=0 AND now<commitDeadline))`. |
| Overview | `<Metric label="Evidence coverage" value="93.8%">` | `"93.8%"` | `→ evidence.coveragePct` | `avg(consensus_results.claims[].evidenceCoverage)` over the last 30 tasks with a `consensus-result`; fallback `verifier-report.summary.evidenceCoverage`. ×100, 1 dp. |
| Overview | its `.metric-helper` | `Across last 30 tasks` | `→ evidence.windowTasks` | `` `Across last ${n} tasks` ``. |
| Overview | `<Metric label="Bounties settled" value="84.50 0G">` | `"84.50 0G"` | `→ settlement.paidWei` | `Σ RewardAllocated.amount` over the window (scope `taskId IN (my tasks)` when connected); `formatEther`, 2 dp, `+" 0G"`. |
| Overview | its `.metric-helper` | `This workspace` | scope flag | `"Your tasks"` when connected, `"All tasks"` otherwise. |
| Overview | `<Metric label="Median verification" value="38 sec">` | `"38 sec"` | `→ timing.medianSecondsToConsensus` | `median(ts(ConsensusReached) − ts(TaskCreated))` over finalized tasks, from block timestamps. |
| Overview | its `.metric-helper` | `From claim to result` | static | Keep. |
| Overview | `.metric-trend` `<ArrowUpRight/>{tone === "coral" ? "" : "18%"}` | `"18%"` on 3 of 4 cards | `→ *.deltaPct` per metric | Same metric over the immediately preceding window; sign chooses `ArrowUpRight`/`ArrowDownRight`. **A single literal `18%` on three unrelated metrics is the most visibly fake element on the page.** |
| Overview | `.section-header .eyebrow` | `SELECTED TASK · PR-1048` | `GET /v1/tasks?limit=1&sort=updated_desc` | `` `SELECTED TASK · ${shortTaskId(task.taskId)}` ``. |
| Overview | `Export JSON` `.quiet-button` toast | `"Evidence export prepared" / "…simulated"` | `GET /v1/tasks/{id}/bundle` | Server streams `{manifest, snapshots[], reports[], consensus, dispute?, adjudication?}` + a `hashes.txt`; client `Blob` download. |
| Overview | `.task-banner-copy > strong` | `0G Storage release claim audit` | `task-manifest.title` | Fetched via `manifestPointer` from `getTask`, hash-checked against `manifestHash`. |
| Overview | `.task-banner-top` `<Pill>VERIFIED</Pill>` | `"VERIFIED"` | `getTask → status, outcome` | See status map, §6.1. Must render `CONFLICT` for `Finalized+Conflict`, never `VERIFIED`. |
| Overview | `.task-banner-copy > span` | `Snapshot anchored 8 minutes ago · 2 independent verifiers · no challenge opened` | 3 sources | `relTime(ts(TaskManifest))` · `` `${task.verifierCount} independent verifiers` `` · `dispute===null ? "no challenge opened" : \`challenge open by ${short(dispute.challenger)}\``. |
| Overview | `.task-banner-hash > span` `Task hash` | label | — | Ambiguous: split into **`Task ID`** (`taskId`) and **`Manifest hash`** (`manifestHash`) — the artifacts prove they are different values. |
| Overview | `.task-banner-hash > strong` | `0x4E9B…D188` | `getTask` / `TaskCreated.taskId` | `shortHash(taskId)`, copy-to-clipboard = full 66-char value, link to `chainscan-galileo.0g.ai/tx/{createTx}`. |
| Overview | `evidence` array row `[0]` `.evidence-number` | `"01"`,`"02"`,`"03"` | `task-manifest.claims[i]` | `String(i+1).padStart(2,'0')` over **manifest order** (canonical), not report order. |
| Overview | `.evidence-title > strong` | `0G Storage is available as a standalone service` | `manifest.claims[i].claimText` | Verbatim; React text node (no `dangerouslySetInnerHTML` — THREAT_MODEL). |
| Overview | `.evidence-title > span` (`<FileText/>` + source) | `docs.0g.ai / Understanding 0G` | `verifier-report.claims[i].sources[0].uri` | `` `${new URL(uri).host} / ${lastPathSegment}` ``. |
| Overview | `<Pill tone={status==="INSUFFICIENT"?"sky":"lime"}>{status}</Pill>` | `SUPPORTED` / `INSUFFICIENT` | `verifier-report.claims[i].verdict` | Real enum is `SUPPORTED\|CONTRADICTED\|INSUFFICIENT_EVIDENCE`. **`CONTRADICTED` has no branch today and would render lime.** Map: SUPPORTED→lime, CONTRADICTED→coral, INSUFFICIENT_EVIDENCE→sky, label `"INSUFFICIENT"`. |
| Overview | `.confidence` | `94%` / `91%` / `63%` | `claims[i].confidence` | `Math.round(c*100)+"%"`. When ≥2 reports exist, show per-verifier values, not one. |
| Overview | `.evidence-detail > p` (after `.quote-mark`) | prose excerpt | `claims[i].sources[0].quotedSpan` | Verbatim, with `spanStart`/`spanEnd` offsets available to highlight inside the snapshot viewer. |
| Overview | `.evidence-meta > span` `<Hash/>snapshot_8a1c…f3b2` | `snapshot_8a1c…f3b2` | `claims[i].sources[0].snapshotObjectId` | `local://757475…` → render `shortPointer()`; also expose `sources[0].contentHash` (`sha256:…`) as the body hash. |
| Overview | `.evidence-meta > span` `<Clock3/>retrieved 08:32 UTC` | `08:32 UTC` | `claims[i].sources[0].retrievedAt` | ISO → `HH:mm` UTC. |
| Overview | `.evidence-meta > button` `View source` toast | `"Opening source snapshot"` | `GET /v1/artifacts/{snapshotHash}` | Opens `source-snapshot.text` with the quoted span highlighted; header shows `httpStatus`, `contentType`, `truncated`, `status`. |
| Overview | `tasks[]` `.task-id` | `PR-1048/47/46` | `tasks.seq` (indexer-assigned) + `taskId` | **No short ID exists onchain.** Either `shortHash(taskId)` or an indexer sequence rendered as `#0004`, explicitly marked index-derived. See §4. |
| Overview | `.task-main > div > strong` | task title | `task-manifest.title` | via `manifestPointer`. |
| Overview | `.task-main span` `<GitBranch/>` source | `github.com/0gfoundation/0g-doc` | `manifest.sources[0].uri` | `host + pathname`, `+" +n"` when `sources.length>1`. |
| Overview | `<Pill tone={task.color}>{task.status}</Pill>` | VERIFIED/IN REVIEW/DISPUTED | `getTask.status`+`outcome` | §6.1 map; `color` derives from the same map, not a stored field. |
| Overview | `.progress-track > .progress-fill` `width:{task.progress}%` | `100 / 64 / 42` | **no field exists** | Substitute: `Open`→10, `Revealing`→`10+70*(committed+revealed)/(2*verifierCount)`, `Consensus`→90, `Finalized`→100, `Disputed`→ freeze at entry value with coral fill. See §4. |
| Overview | `.agreement > span` | `2/2 agree` / `1/2 agree` / `Conflict` | `consensus-result` + `getTask` | Pre-consensus: `` `${task.revealed}/${task.verifierCount} revealed` ``. Post: `` `${claims.filter(c=>c.agreed).length}/${claims.length} claims agree` ``; `outcome==='CONFLICT'` → `"Conflict"`. Today's string conflates verifier count with claim agreement. |
| Overview | `.task-bounty > strong` | `10.00 0G` | `getTask.bounty` (uint96 wei) | `formatEther`, 2 dp. `minBounty` is `1e14 wei` = 0.0001 0G — real demo bounties are ~0.001 0G, not 10. |
| Overview | `.task-bounty > span` | hardcoded `2 verifiers` | `getTask.verifierCount` | `` `${verifierCount} verifiers` `` (contract bounds: `MIN_VERIFIERS 2`, `MAX_VERIFIERS 16`). |
| Overview | `.task-time > strong` | `8 min ago` / `22 min ago` / `1 hr ago` | `tasks.updated_at` ← last event block timestamp | `relTime()`; recompute on a 30 s tick, not on fetch. |
| Overview | `.task-time > span` ternary | `Finalized`/`Needs review`/`Processing` | `getTask.status` | Full map: Open→"Awaiting commits", Revealing→"Revealing", Consensus→"Dispute window", Disputed→"Needs review", Finalized→"Finalized", Expired→"Expired", Cancelled→"Cancelled". |
| Overview | Task row `onClick` toast `` `Opened ${task.id}` `` | toast | route | `navigate('/task/'+taskId)` — `App.tsx` already declares `/task/:taskId` but it renders the **list** page; the detail view does not exist. |
| Overview | `.modal-card` `New verification request` / `Make the claim earn its confidence.` / `.modal-copy` | static | static | Keep. |
| Overview | `.modal-note` `Public-data demo · no private inputs stored` | static | `task-manifest.safety.publicDataOnly` | Keep static as a warning, and surface `safety.warnings[]` / `PERSONAL_DATA_REJECTED` from `/v1/tasks/prepare`. |
| Overview | `"View how it works"` toast `"Demo tour queued"` | toast | — | Route to `/protocol-docs`. |

### 1.3 `pages/VerificationTasks.tsx`

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| Verification tasks | `.page-intro` paragraph | static prose | — | Keep. |
| Verification tasks | `.summary-strip` `OPEN QUEUE` `<strong>12</strong>` | `12` | `GET /v1/stats/overview → tasks.open` | `count(status IN ('Open','Revealing'))`. |
| Verification tasks | that strip's trailing `<span>` | `3 waiting on your review` | `→ tasks.needsYourAction` | As above; hide when disconnected. |
| Verification tasks | `.summary-strip.sky-summary` `IN REVIEW` `<strong>5</strong>` | `5` | `→ tasks.revealing` | `count(status='Revealing')`. |
| Verification tasks | its `<span>` | `Median age 38 sec` | `→ timing.medianOpenAgeSeconds` | `median(now − ts(TaskCreated))` over non-terminal tasks. |
| Verification tasks | `.summary-strip.coral-summary` `DISPUTED` `<strong>1</strong>` | `1` | `→ tasks.disputed` | `count(status='Disputed')`, cross-checked against `getDispute(t).resolved===false`. |
| Verification tasks | its `<span>` | `Needs adjudication` | `getDispute → deadline` | `` `Adjudication closes ${relTime(deadline)}` ``; after `deadline`, `"expireDispute available"` (permissionless). |
| Verification tasks | `.search-field > input` placeholder | `Search task IDs, claims, or sources` | — | Client filter today; must become `GET /v1/tasks?q=` — server-side over `taskId`, `manifest.title`, `manifest.claims[].claimText`, `manifest.sources[].uri`. |
| Verification tasks | `.filter-tabs` array `["ALL","VERIFIED","IN REVIEW","DISPUTED"]` | 4 strings | `GET /v1/tasks?status=` | **These 4 strings are the whole reason the API status enum must be defined.** They are display groups, not contract states. Map: `ALL`→no filter, `VERIFIED`→`status=Finalized&outcome=Consensus`, `IN REVIEW`→`status=Open,Revealing,Consensus`, `DISPUTED`→`status=Disputed`. Add tabs for `CONFLICT` (Finalized+Conflict) and `EXPIRED` — otherwise finalized conflicts silently vanish from every tab except ALL. |
| Verification tasks | tab label transform `item==="ALL" ? "All tasks" : item.toLowerCase()` | `"verified"`, `"in review"`, `"disputed"` | — | Keep the transform; drive it from the group table. |
| Verification tasks | `.task-table-head` `<span>`s | `Task \| Status \| Agreement \| Bounty \| Updated` | — | Static; `Agreement` should read `Revealed / Agreement` since it shows both phases. |
| Verification tasks | `data[]` 5 rows (id, title, source, status, agree, bounty, time, tone, progress) | 5 tuples | `GET /v1/tasks → items[]` | Every cell as in §1.2. |
| Verification tasks | `.task-bounty > span` hardcoded `2 verifiers` | `"2 verifiers"` | `items[].verifierCount` | Same as Overview. |
| Verification tasks | `.empty-state` | `No matching verification tasks.` | `items.length===0` + query state | Three distinct states: no tasks indexed yet ("Indexing from block 52352124…"), filter yields nothing, and request failed (retry button). |
| Verification tasks | `.workflow-card` `HOW A TASK MOVES` / `Claim → evidence → settlement` / `.workflow-steps` 01 Manifest, 02 Verify, 03 Settle | static | static | Keep — but the real machine has 4 stages (Manifest → Commit → Reveal → Settle) per `ProtocolDocs`; the two pages disagree. |
| Verification tasks | Create modal `.field.full` `Claim or task title` `<input>` | uncontrolled, no state | `POST /v1/tasks/prepare` body `title` | Becomes `task-manifest.title`. |
| Verification tasks | `.field.full` `Public source URL` `<input>` | uncontrolled | `→ sources[].uri` | SSRF-safe fetcher, http/https only, ports 80/443/8080/8443, private ranges rejected. Max 20 sources. |
| Verification tasks | `.field` `Verifier count` `.field-static` `2 independent verifiers` | **not editable** | contract `MIN_VERIFIERS()=2`, `MAX_VERIFIERS()=16` | Must become a real select 2..16 → `TaskParams.verifierCount` and `manifest.policy.verifierCount`. |
| Verification tasks | `.input-with-suffix` `<input defaultValue="10"/><span>0G</span>` | `"10"` | `params().minBounty = 1e14 wei` | Value → `parseEther` → `msg.value`. Validate `>= minBounty`; default should be `0.001`, not `10`. |
| Verification tasks | (missing) commit/reveal/dispute window inputs | not in the UI at all | `MIN_WINDOW()=30`, `MAX_WINDOW()=2592000`, `MAX_DISPUTE_WINDOW()=2592000` | `createTask` takes 4 `uint32` windows; the manifests show `900/900/900`. The form must collect them (or send documented defaults) — they are 3 of the 7 tuple fields. |
| Verification tasks | Create toast `"Task added to the demo queue"` | fake | tx lifecycle | Replace with prepare → sign → `wagmi useWaitForTransactionReceipt` → decode `TaskCreated.taskId` → navigate. See §6. |
| Verification tasks | Row toast `"Task detail route will connect to onchain state in the next integration."` | toast | route | `navigate('/task/'+taskId)`. |

### 1.4 `pages/VerifierNetwork.tsx`

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| Verifier network | `.network-overview-card` `ACTIVE VERIFIERS` `<strong>18</strong>` | `18` | `GET /v1/verifiers → summary.active` | `count(VerifierRegistered) filtered by getVerifier(a).approved && .active`. **This deployment has 2 registered + 2 approved** (`registerVerifier` ×2, `setVerifierApproval` ×2 in `txs.json`). |
| Verifier network | its `<span>` `<span className="live-dot"/>16 online · 2 degraded` | `16 online · 2 degraded` | **no liveness onchain** | Substitute `` `${approved} approved · ${registered-approved} awaiting approval` ``. See §4. |
| Verifier network | `.network-overview-card.sky-overview` `NETWORK AGREEMENT` `<strong>92.6%</strong>` | `92.6%` | `→ summary.agreementBps` | `avg(consensus_results.agreementBps)/100` over the last N. Live artifacts give `10000` (CONSENSUS ×2) and `0` (CONFLICT ×2) → real value 50.0%. |
| Verifier network | its `<span>` `<ArrowUpRight/>+4.8% this month` | `+4.8%` | `→ summary.agreementDeltaBps` | Same metric over the preceding 30 d; drop the card's arrow when the previous window is empty. |
| Verifier network | `.ink-overview` `TOTAL STAKED` `<strong>3,840 0G</strong>` | `3,840 0G` | `Σ getVerifier(a).stake` | `formatEther`. **MVP stake defaults to 0** — expect `0 0G` until `registerVerifier` is called with value. |
| Verifier network | its `<span>` `<ShieldCheck/>Slashing enabled in next release` | static | `params().verifierSlashBps` | `bps===0 ? "Slashing disabled (slashBps 0)" : \`Slash rate ${bps/100}%\``. Also surface `getVerifier(a).slashed`. |
| Verifier network | `.coral-overview` `MEDIAN LATENCY` `<strong>241ms</strong>` | `241ms` | `→ summary.medianComputeLatencyMs` | `median(verifier-report.compute[].latencyMs)` across recent reports (live values are 1–11 ms on the `local` driver). Label it "median compute latency (self-reported in report)". |
| Verifier network | its `<span>` `<Zap/>Within target range` | static | threshold compare | `< p95Target ? "Within target range" : "Above target"`. |
| Verifier network | `verifiers[].name` → `.verifier-directory-main > strong` and `<h3>{current.name}</h3>` | `Verifier A/B/C` | verifier-metadata artifact via `getVerifier().metadataPointer` | `metadata.displayName` → fallback `verifier-report.verifier.verifierId` (`"verifier-a"`) → fallback `shortAddress`. |
| Verifier network | `.verifier-avatar` `{verifier.name.slice(-1)}` | `A`/`B`/`C` | address | Identicon or `address.slice(2,4).toUpperCase()`. |
| Verifier network | `.verifier-directory-main > span` `{address} · {model}` | `0x2c…91af · evidence-reranker-v0.8.1` | `VerifierRegistered.verifier` + `verifier-report.verifier.modelId` | Address is real onchain; model is the latest report's `modelId` (+`pipelineVersion`), e.g. `local-entailment/2-0.55` / `0.1.0`. |
| Verifier network | `.directory-stat` label `AGREEMENT` / `<strong>{verifier.agreement}</strong>` | `94.2% / 91.7% / 88.9%` | `GET /v1/verifiers → items[].agreementPct` | `count(consensus_results.claims[] where agreeingVerifiers contains a) / count(claims where a submitted a verdict)`. |
| Verifier network | `.directory-stat` label `UPTIME` / `<strong>{verifier.uptime}</strong>` | `99.8/99.4/97.1%` | **no uptime onchain** | Substitute `revealRatePct = count(ReportRevealed by a)/count(ReportCommitted by a)`. Live data: 6 commits → 6 reveals = 100%. Relabel the column `REVEAL RATE`. See §4. |
| Verifier network | `.directory-status` `ONLINE` / `DEGRADED` (+ `.status-online`/`.status-degraded`) | 2 online, 1 degraded | `getVerifier(a)` | `!registered→"UNREGISTERED"`, `!approved→"PENDING"`, `!active→"INACTIVE"`, `approved&&active&&lastRevealWithin(7d)→"ACTIVE"`, else `"IDLE"`. Retire "ONLINE/DEGRADED" — there is no heartbeat. |
| Verifier network | `.operator-identity > div > strong` | `{current.address}` | `VerifierRegistered.verifier` | Full address + explorer link. |
| Verifier network | `.operator-identity > div > span` `{current.role}` | `Primary evidence` / `Independent check` / `Adjudication backup` | `hasRole(ADJUDICATOR_ROLE,a)` / `hasRole(KEEPER_ROLE,a)` | No role taxonomy exists for verifiers. Render `"Adjudicator"` / `"Keeper"` / `"Verifier"`. |
| Verifier network | `.operator-metrics` `Model version` | `evidence-reranker-v0.8.1` | `verifier-report.verifier.modelId` + `pipelineVersion` | Latest revealed report by that address. |
| Verifier network | `.operator-metrics` `Stake locked` | `240 0G` | `getVerifier(a).stake` | `formatEther`; show `.slashed` beside it. |
| Verifier network | `.operator-metrics` `Median latency` | `182ms` | `median(compute[].latencyMs)` for that verifier | Per-address aggregate. |
| Verifier network | `.uptime-panel > div:first-child > span` `30-day uptime` | label | — | Relabel `30-day reveal rate`. |
| Verifier network | `.uptime-panel > div:first-child > strong` | `{current.uptime}` | `→ items[].revealRatePct` | As above. |
| Verifier network | `.uptime-bars` — 24 literal heights `[88,96,92,100,97,100,98,93,100,100,95,100,99,100,100,96,98,100,100,100,97,100,98,100]` | 24 numbers | `GET /v1/verifiers/{a}/history → buckets[]` | 24 daily buckets over 30 d (or 24 hourly): `bucket.revealed/bucket.committed*100`; `null` (no tasks that day) renders as a flat grey stub, **not** as 100. |
| Verifier network | `.uptime-bars i.bar-warning` when `height < 95` | literal threshold | client | Keep the 95 threshold, apply to the real bucket value; grey class for `null`. |
| Verifier network | `.full-button` `Inspect verifier metadata` toast `"…simulated in this preview."` | toast | `GET /v1/artifacts/{metadataHash}` | Resolve `getVerifier(a).metadataPointer`, hash-check against `metadataHash`, show raw JSON. |
| Verifier network | `Register verifier` `.primary-button` toast | toast | `registerVerifier(bytes32,string)` payable | §6. |
| Verifier network | `Filters` `.quiet-button` toast `"All verifiers shown in this demo."` | toast | `GET /v1/verifiers?status=&minStake=` | Real query params. |
| Verifier network | `.side-card-head` `<MoreHorizontal/>` toast `"Suspend and edit controls are coming soon."` | toast | `setVerifierActive(bool)` (self) / `setVerifierApproval(address,bool)` (admin) | Gate on `address===a` and `hasRole(DEFAULT_ADMIN_ROLE)`. |
| Verifier network | `.signal-head` `Event \| Operator \| Task \| Time` | static | — | Static. |
| Verifier network | signal rows `[["Report revealed","Verifier A","PR-1048","08:40","lime"],["Commit accepted","Verifier B","PR-1047","08:35","sky"],["Endpoint degraded","Verifier C","PR-1046","08:18","coral"]]` | 3 tuples | `GET /v1/activity?category=verification&limit=10` | `ReportRevealed`→"Report revealed" (lime), `ReportCommitted`→"Commit accepted" (sky), `VerifierApprovalSet`→"Approval changed", `VerifierRegistered`→"Verifier registered". **`"Endpoint degraded"` has no onchain or artifact equivalent** — see §4. `key={event[0]}` also collides on repeated event names; key on `${txHash}:${logIndex}`. |
| Verifier network | `.small-status` `<span className="live-dot"/>streaming` | always "streaming" | SSE/poll connection state | `"streaming"` only when the `/v1/stream` EventSource is open; else `"polling"` / `"reconnecting"`. |

### 1.5 `pages/Artifacts.tsx`

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| Artifacts | `.artifact-stat-grid` `TOTAL OBJECTS` `<strong>28</strong>` | `28` | `GET /v1/artifacts → total` | `count(artifacts)`. Local store has 42. |
| Artifacts | `<small>Across 12 tasks</small>` | `12` | `→ summary.distinctTasks` | `count(DISTINCT task_id)`. |
| Artifacts | `STORAGE USED` `<strong>18.4 MB</strong>` | `18.4 MB` | `→ summary.totalBytes` | `Σ artifacts.byte_length` (from each `.meta.json` `byteLength`); humanize. |
| Artifacts | `<small>0G Storage · Galileo</small>` | static | `GET /health → drivers.storage`, `chainId` | `` `0G Storage · ${driver==='zerog'?'Galileo':'local'}` `` — must not claim 0G while `STORAGE_DRIVER=local`. |
| Artifacts | `HASH COVERAGE` `<strong>100%</strong>` | `100%` | `→ summary.hashVerifiedPct` | `count(hash_verified)/count(*)`. Verified = recomputed canonical hash equals the storage key **and** equals the `manifestHash`/`reportHash` recorded onchain. |
| Artifacts | `<small>Canonical objects only</small>` | static | — | Keep. |
| Artifacts | `artifacts[].name` → `.artifact-name > strong` | `report_PR-1048.json`, `snapshot_0g-doc.html`, `evidence-graph_PR-1047.json`, `claim-source-capture.png`, `task-manifest_PR-1048.json` | **no filename exists in storage** | Synthesize `` `${kind}_${shortTaskId}.json` ``; every canonical object is JSON — `.html` and `.png` names are impossible. |
| Artifacts | `.artifact-name > span` (hash) | `sha256:7b1d…a32f` | `artifacts.content_hash` | **Wrong hash family.** Objects are addressed by `0x`-prefixed bytes32 (`0x51b73b3d…`); `sha256:` appears only as `source-snapshot.contentHash`, the hash of the fetched bytes. Show both, labelled. |
| Artifacts | `.artifact-type` `{artifact.type}` | `Verifier report`, `Source snapshot`, `Evidence graph`, `Visual evidence`, `Task manifest` | `artifacts.kind` | Real set is 6: `task-manifest`, `source-snapshot`, `verifier-report`, `consensus-result`, `challenge-evidence`, `adjudication-report`. |
| Artifacts | `.mono-text` `{artifact.task}` | `PR-1048` | `artifacts.task_id` | `shortHash(taskId)`, links to the task page. `source-snapshot` rows have **no** taskId until joined via the manifest's `sources[].snapshotHash` — render `—` or resolve the join. |
| Artifacts | `.storage-pointer` `<Database/>{artifact.object}` | `0g://storage/7b1d…a32f` | `artifacts.pointer` | Verbatim from chain (`manifestPointer` / `reportPointer` / `evidencePointer` / `adjudicationPointer`) or from the manifest's `snapshotPointer`. Real values are `local://757475…`; `0g://` is not a scheme this system emits. Cap display at `MAX_POINTER_BYTES()=256`. |
| Artifacts | size column `{artifact.size}` | `128 KB`, `2.4 MB`, `46 KB`, `940 KB`, `12 KB` | `artifacts.byte_length` | From the sidecar (`{"kind":"task-manifest","byteLength":1802}`). Real objects are 1–10 KB. |
| Artifacts | `.muted-time` `{artifact.created}` | `8 min ago` | `artifacts.artifact_created_at` | Each artifact carries its own `createdAt`/`retrievedAt`/`evaluatedAt`; fall back to `ts(first_seen_block)`. |
| Artifacts | `artifact.icon` / `artifact.tone` | per-row literal | derived from `kind` | `task-manifest→FileCheck2/sky`, `source-snapshot→FileText/sky`, `verifier-report→FileJson2/lime`, `consensus-result→ShieldCheck/lime`, `challenge-evidence→ShieldAlert/coral`, `adjudication-report→Gavel/coral`. |
| Artifacts | `.filter-select > select` `<option>`s | `All types \| Verifier report \| Source snapshot \| Evidence graph \| Task manifest \| Visual evidence` | `GET /v1/artifacts?kind=` | **This option list is the API's `kind` enum.** Drop `Evidence graph` (it is `verifier-report.graph`, not an object) and `Visual evidence` (no such kind); add `Consensus result`, `Challenge evidence`, `Adjudication report`. |
| Artifacts | `.search-field` placeholder `Search artifacts, task IDs, or hashes` | client filter | `GET /v1/artifacts?q=` | Server-side prefix match on `content_hash`, `pointer`, `task_id`. |
| Artifacts | `.artifact-head` `Object \| Type \| Task \| Storage pointer \| Size \| Created` | static | — | Add a **Verified** column bound to `hash_verified`. |
| Artifacts | `.empty-state` `No artifacts found.` | static | `items.length===0` | Distinguish "none indexed yet" from "filter empty". |
| Artifacts | `Sync storage` `.secondary-button` toast `"All five demo artifacts are indexed."` | toast | `POST /v1/tasks/{taskId}/sync` | Per-task in the recovered API; either add `POST /v1/artifacts/reindex` or scope the button to a task. |
| Artifacts | `Copy sample hash` → `writeText("sha256:7b1d…a32f")` | literal truncated string | selected row `content_hash` | **Copies a truncated, non-existent hash today.** Must copy the full 66-char value. |
| Artifacts | `Open Storage Scan` toast | toast | `https://storagescan-galileo.0g.ai` | Deep-link the pointer; disable when `drivers.storage==='local'`. |
| Artifacts | `.artifact-detail-card` prose ("The database is an index—the artifact is the source of truth.") | static | — | Keep — it is literally the ARCHITECTURE §13 rule. |

### 1.6 `pages/ActivityLog.tsx`

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| Activity log | `.activity-summary` `EVENTS TODAY` `<strong>48</strong>` | `48` | `GET /v1/stats/overview → activity.eventsToday` | `count(chain_events WHERE block_timestamp >= date_trunc('day', now()))` + offchain job events. |
| Activity log | its `<span>` `<ArrowUpRight/>12% vs yesterday` | `12%` | `→ activity.eventsDeltaPct` | vs the preceding 24 h; arrow flips on sign. |
| Activity log | `LAST BLOCK SYNC` `<strong>#1,945,822</strong>` | `#1,945,822` | `GET /health → indexer` / `GET /v1/chain/head → indexedBlock` | `indexer_state.last_processed_block`, thousand-separated. Show chain head beside it and the `chain_sync_lag_blocks` delta. |
| Activity log | its `<span>` `<span className="live-dot"/>8 sec ago` | `8 sec` | `indexer_state.updated_at` | `relTime()`; dot goes coral when `lag > 20` (RUNBOOK alert threshold). |
| Activity log | `OPEN SIGNALS` `<strong>01</strong>` | `01` | `→ activity.openDisputes` | `count(disputes WHERE resolved=false)`, verified by `getDispute(t).resolved`. Zero-pad to 2. |
| Activity log | its `.warning-copy` `<ShieldAlert/>One dispute needs review` | static | same count | Pluralize; when 0 render neutral copy without `.warning-copy`. |
| Activity log | `.timeline-day` `TODAY` / `YESTERDAY` | literal per row | `ts(block)` grouping | Group by local date of the block timestamp; `TODAY`/`YESTERDAY`/`DD MMM YYYY`. |
| Activity log | `<time>{event.time} UTC` | `08:42:18` | `blocks.timestamp` | `HH:mm:ss` UTC from the block, not the row. |
| Activity log | `.event-type` `{event.type}` | `Settlement`,`Storage`,`Verification`,`Dispute`,`Compute` | `chain_events.event_name` / `jobs.job_type` | Categorize: **onchain** — `TaskCreated`/`TaskManifest`→Task, `ReportCommitted`/`ReportRevealed`→Verification, `ConsensusReached`/`TaskFinalized`/`RewardAllocated`→Settlement, `ChallengeOpened`/`DisputeResolved`→Dispute, `VerifierRegistered`/`VerifierApprovalSet`/`RoleGranted`→Registry. **offchain** — `jobs.job_type ∈ {SOURCE_SNAPSHOT, MANIFEST_UPLOAD}`→Storage, `{VERIFIER_DISPATCH, CONSENSUS_EVALUATION}`→Compute. |
| Activity log | `.timeline-task` `{event.task}` | `PR-1048` | `chain_events.task_id` | `shortHash`; link to the task. |
| Activity log | `.timeline-content > h3` `{event.title}` | `Task finalized`, `Artifact pinned to 0G Storage`, `Verifier B revealed report`, `Dispute window closed`, `Challenge opened`, `Compute job completed` | event name → display map | Note **"Dispute window closed" is not an event** — no log fires when a window merely lapses. It must be a derived, clock-driven row or dropped. See §4. |
| Activity log | `.timeline-content > p` `{event.detail}` | prose | decoded log args | e.g. `ConsensusReached(taskId, resultHash, outcome, agreementBps, at)` → `` `${outcomeLabel} at ${agreementBps/100}% agreement across ${claims} claims` ``; `RewardAllocated(taskId, verifier, amount)` → `` `${formatEther(amount)} 0G allocated to ${short(verifier)}` ``. |
| Activity log | `.timeline-meta > span` `<Activity/>{event.actor}` | `ProofRelay keeper`, `Storage adapter`, `0x9D…c17e`, `0G Compute adapter` | `tx.from` (onchain) / `jobs.producer` (offchain) | Onchain: `tx.from` + role label from `hasRole` (KEEPER/ADJUDICATOR/ADMIN). Offchain: `producer` from the artifact (`proofrelay-api/1.0.0`). **The three "adapter" actors are offchain and must be visually marked as such.** |
| Activity log | `.timeline-meta > span` `<Hash/>{event.hash}` | `0x7cd2…a91f`, `sha256:7b1d…a32f`, `job_7a82…91cc` | 3 different sources | Settlement/Verification/Dispute→`txHash` (explorer link); Storage→`artifacts.content_hash` (`0x…`, **not** `sha256:`); Compute→`verifier-report.compute[].requestId` (real form `local-c3500d125c212d9e`). |
| Activity log | `.timeline-node` tone (`timeline-lime/sky/ink/coral`) | per-row literal | category | Settlement→lime, Storage→sky, Verification→ink, Dispute→coral, Compute→sky, Task→ink. |
| Activity log | `.filter-tabs.activity-filters` `["All events","Verification","Storage","Settlement","Dispute","Compute"]` | 6 strings | `GET /v1/activity?category=` | **This list is the API `category` enum.** Add `Task` and `Registry`, or `TaskCreated`/`VerifierRegistered` become unreachable by filter. |
| Activity log | `.search-field` placeholder `Search activity, task IDs, or actors` | client filter | `GET /v1/activity?q=` | Server-side over `task_id`, `actor`, `event_name`. |
| Activity log | `View payload` button toast `"Raw event payload will be available after indexer integration."` | toast | `GET /v1/activity/{eventId}` | Returns `{ chainId, blockNumber, blockTimestamp, txHash, logIndex, address, topics[], data, decoded }` — exactly the shape in `docs/recon/logs.json`. |
| Activity log | `Export activity` toast `"CSV export is simulated…"` | toast | `GET /v1/activity.csv?...` | Server-rendered CSV of the current filter. |
| Activity log | `.empty-state` `No activity matches this filter.` | static | `visible.length===0` | Plus an "indexing from block 52352124" state. |
| Activity log | `key={`${event.time}-${event.title}`}` | composite | `(txHash, logIndex)` | Two logs in one tx share a timestamp; the current key collides. |

### 1.7 `pages/ProtocolDocs.tsx`

| Page | UI element (exact JSX/class) | Mock value today | Live source | Derivation |
|---|---|---|---|---|
| Protocol docs | `sections[]` `["What is ProofRelay?","Task lifecycle","0G integration","Evidence schema","Settlement rules"]` | 5 strings | static | Keep. |
| Protocol docs | `.docs-kicker` `PROOFRELAY / V1.0 MVP` | static | build metadata | `` `PROOFRELAY / ${__APP_VERSION__}` ``. |
| Protocol docs | `.docs-lifecycle` rows `01 Manifest / 02 Commit / 03 Reveal / 04 Settle` | static prose | static + `params()` | Annotate each with live windows: Manifest→`MIN_WINDOW..MAX_WINDOW`, Settle→`adjudicationWindow 7d`, `conflictRateBps 5000`. |
| Protocol docs | `.og-integration-grid` 3 cards | static | `GET /health → drivers` | Append the resolved driver per surface (`zerog` / `zerog-router` / `local`) and the endpoint host. |
| Protocol docs | `.code-block` `<pre>` `report.json` sample | hand-written JSON with `"modelId":"verifier-a-v1"` | `GET /v1/schemas/verifier-report` or a real `GET /v1/reports/{hash}` | The sample is **not** the real schema: it omits `taskId`, `manifestHash`, `compute[]`, `graph`, `summary`, `reasoningSummary`, `score`, `spanStart/spanEnd`, `verifierId`, `schemaVersion`. Render a truncated real report. |
| Protocol docs | `Copy snippet` → `writeText('claimId, verdict, confidence, sources, verifier')` | copies a **comma list, not JSON** | the `<pre>` content | Copy the actual displayed JSON. |
| Protocol docs | `.rule-list` Consensus / Dispute / Auditability | static prose | `params()` + `ruleId` | "Two verifiers share the same verdict" ← `requiredAgreement=2of2`, `minimumEvidenceCoverage=0.8` (ARCHITECTURE §8). Show the live `ruleId` (`0x454d618f…`) that every manifest pins. |
| Protocol docs | `.docs-bottom-cta` toast `"Use the sidebar to open Verification tasks"` | toast | route | `navigate('/verification-tasks')`. |
| Protocol docs | `.docs-tip` `Built for 0G` blurb | static | — | Keep. |

### 1.8 `pages/Home.tsx` (dead code — not routed in `App.tsx`)

20 KB duplicate of the pre-split single-page app: `initialTasks[3]`, `evidenceRows[3]`, `activity[4]`, its own sidebar/topbar, `navItems` with counts `"12"`/`"28"`, `#1,945,822`, `0x7A…8C21`, `Compute latency 182ms` in the footer, and a `CreateTaskModal` that fakes a 650 ms `setTimeout` and hardcodes the new task as `id:"PR-1049", verified:"0/2 agree", progress:18`. **Delete it** — otherwise it is a second, divergent copy of every mock in this table. Its only unique elements worth keeping are the `CopyButton` component and the working controlled-input create form (the routed `VerificationTasks` modal has uncontrolled inputs that discard user text).

### 1.9 `pages/NotFound.tsx`, `contexts/ThemeContext.tsx`

No data. `NotFound` is generic Tailwind and visually inconsistent with the Evidence Ledger system (`bg-gradient-to-br from-slate-50`, `text-blue-600`) — cosmetic, not a data concern. `ThemeContext` defaults to `light` and toggles a `.dark` class that `index.css` defines but nothing in the UI exposes.

---

## 2. Complete TypeScript API types

```ts
// ─────────────────────────────────────────────────────────────
// packages/schemas/src/api.ts — every response the frontend needs
// ─────────────────────────────────────────────────────────────

export type Hex        = `0x${string}`;
export type Address    = `0x${string}`;      // EIP-55 checksummed
export type Bytes32    = `0x${string}`;      // 66 chars — task ids, all object hashes
export type Sha256     = `sha256:${string}`; // source-body hashes ONLY
export type Iso        = string;             // "2026-08-31T10:43:06.115Z"
export type Wei        = string;             // decimal string, never number
export type Pointer    = string;             // "local://<hex>" | 0G root, <= 256 bytes

// ── enums ─────────────────────────────────────────────────────
export type TaskStatus =
  | "None" | "Open" | "Revealing" | "Consensus"
  | "Disputed" | "Finalized" | "Expired" | "Cancelled";

export type TaskOutcome = "Pending" | "Consensus" | "Conflict" | "NoQuorum";

/** UI display groups backing the VerificationTasks filter tabs. */
export type TaskDisplayState =
  | "VERIFIED" | "CONFLICT" | "IN REVIEW" | "DISPUTED" | "EXPIRED" | "CANCELLED";

export type Verdict = "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE";

export type ConsensusOutcome = "CONSENSUS" | "CONFLICT" | "NO_QUORUM";

export type ArtifactKind =
  | "task-manifest" | "source-snapshot" | "verifier-report"
  | "consensus-result" | "challenge-evidence" | "adjudication-report";

export type SourceStatus = "OK" | "SOURCE_UNAVAILABLE" | "TRUNCATED" | "BLOCKED";

export type VerifierState =
  | "UNREGISTERED" | "PENDING" | "INACTIVE" | "IDLE" | "ACTIVE";

export type ActivityCategory =
  | "Task" | "Verification" | "Settlement" | "Dispute" | "Registry"   // onchain
  | "Storage" | "Compute";                                            // offchain jobs

export type JobType =
  | "SOURCE_SNAPSHOT" | "MANIFEST_UPLOAD" | "VERIFIER_DISPATCH"
  | "COMMIT_SUBMISSION" | "REVEAL_SUBMISSION" | "CONSENSUS_EVALUATION"
  | "FINALIZATION" | "NOTIFICATION";

export type JobStatus =
  | "PENDING" | "RUNNING" | "DONE" | "FAILED_RETRYABLE" | "FAILED_FINAL";

// ── envelope ──────────────────────────────────────────────────
export interface Page<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
  /** Set when the read model is behind the chain (ARCHITECTURE §13). */
  syncState: "OK" | "SYNC_REQUIRED";
}

export interface ApiError {
  error: {
    code:
      | "PERSONAL_DATA_REJECTED" | "CONTENT_HASH_MISMATCH" | "SOURCE_UNAVAILABLE"
      | "SSRF_BLOCKED" | "RATE_LIMITED" | "NOT_FOUND" | "VALIDATION_FAILED"
      | "CHAIN_UNAVAILABLE" | "STORAGE_UNAVAILABLE" | "COMPUTE_UNAVAILABLE"
      | "IDEMPOTENCY_CONFLICT" | "UNAUTHORIZED";
    message: string;
    details?: unknown;
    requestId: string;
  };
}

// ── GET /health ───────────────────────────────────────────────
export interface DependencyHealth { ok: boolean; detail?: string; latencyMs?: number }

export interface HealthResponse {
  ok: boolean;
  chainId: number;                    // 16602
  contract: Address;                  // 0xc1E3…33D7
  deployBlock: number;                // 52352124
  paused: boolean;                    // paused()
  drivers: {
    storage: "zerog" | "local";
    compute: "zerog-router" | "zerog-broker" | "local";
  };
  dependencies: {
    database: DependencyHealth;
    storage:  DependencyHealth;
    compute:  DependencyHealth;
    chain:    DependencyHealth;       // detail: "head=52357975"
  };
  indexer: {
    running: boolean;
    lastError: string | null;
    processedEvents: number;
    lastProcessedBlock: number;
    chainHead: number;
    lagBlocks: number;                // -> .live-dot colour, "LAST BLOCK SYNC"
    updatedAt: Iso;
  };
  queue: Record<JobStatus, number>;
  version: string;
}

// ── GET /v1/chain/head ────────────────────────────────────────
export interface ChainHeadResponse {
  chainId: number;
  blockNumber: number;                // "Latest block #…"
  blockTimestamp: Iso;
  indexedBlock: number;
  lagBlocks: number;
  confirmations: number;              // INDEXER_CONFIRMATIONS (2)
  gasPriceWei: Wei;
}

// ── GET /v1/stats/overview ────────────────────────────────────
export interface OverviewStats {
  windowDays: number;                 // 30
  nav:    { openTasks: number; artifacts: number };
  tasks: {
    active: number; activeDeltaPct: number | null;      // "Active tasks" + trend
    open: number; revealing: number; consensus: number;
    disputed: number; finalized: number; expired: number;
    needsYourAction: number;                            // "3 need your review"
  };
  evidence: { coveragePct: number; windowTasks: number };
  settlement: {
    paidWei: Wei; paidDeltaPct: number | null;
    escrowedWei: Wei; totalLiabilitiesWei: Wei; contractBalanceWei: Wei;
  };
  timing: {
    medianSecondsToConsensus: number | null;
    medianOpenAgeSeconds: number | null;
    deltaPct: number | null;
  };
  verifiers: {
    registered: number; approved: number; active: number;
    totalStakeWei: Wei; totalSlashedWei: Wei;
    agreementBps: number; agreementDeltaBps: number | null;
    medianComputeLatencyMs: number | null;
  };
  artifacts: {
    total: number; distinctTasks: number;
    totalBytes: number; hashVerifiedPct: number;
    byKind: Record<ArtifactKind, number>;
  };
  activity: {
    eventsToday: number; eventsDeltaPct: number | null;
    openDisputes: number;
  };
  actionable: {
    total: number;                                       // notification badge
    items: Array<{
      kind: "DISPUTE_OPEN" | "REWARD_CLAIMABLE" | "WITHDRAWAL_PENDING"
          | "REVEAL_DUE" | "COMMIT_DUE" | "FINALIZE_AVAILABLE";
      taskId: Bytes32 | null; amountWei?: Wei; deadline?: Iso;
    }>;
  };
}

// ── GET /v1/tasks ─────────────────────────────────────────────
export interface TaskListItem {
  taskId: Bytes32;
  seq: number;                        // indexer-assigned, NOT canonical
  creator: Address;
  title: string | null;               // manifest.title (null until resolved)
  question: string | null;
  primarySource: { uri: string; host: string; extraCount: number } | null;
  status: TaskStatus;
  outcome: TaskOutcome;
  displayState: TaskDisplayState;     // <- Pill text + tone
  tone: "lime" | "sky" | "coral" | "ink";
  progressPct: number;                // <- .progress-fill width
  bountyWei: Wei;
  verifierCount: number;              // "N verifiers"
  committed: number;
  revealed: number;
  rewardBps: number;
  agreement: {
    label: string;                    // "2/2 revealed" | "3/3 claims agree" | "Conflict"
    agreementBps: number | null;
    claimsTotal: number | null;
    claimsAgreed: number | null;
  };
  manifestHash: Bytes32;
  manifestPointer: Pointer;
  ruleId: Bytes32;
  resultHash: Bytes32 | null;
  commitDeadline: Iso; revealDeadline: Iso;
  disputeWindowSec: number; consensusAt: Iso | null;
  createdAt: Iso; updatedAt: Iso;
  createdBlock: number; createdTxHash: Hex;
  hasDispute: boolean;
  syncState: "OK" | "SYNC_REQUIRED";
}

export type TaskListResponse = Page<TaskListItem>;

// ── GET /v1/tasks/{taskId} ────────────────────────────────────
export interface ManifestClaim { claimId: string; claimText: string; origin: "creator" | "extraction" }

export interface ManifestSource {
  sourceId: string; uri: string; status: SourceStatus;
  contentHash: Sha256; byteLength: number;
  snapshotHash: Bytes32; snapshotPointer: Pointer;
}

export interface TaskManifest {
  kind: "task-manifest"; schemaVersion: string; manifestId: string;
  createdAt: Iso; creator: Address; chainId: number; producer: string;
  title: string; question: string; answerText: string | null;
  claims: ManifestClaim[];
  extraction: { modelId: string; pipelineVersion: string } | null;
  sources: ManifestSource[];
  policy: {
    verifierCount: number; commitWindowSec: number; revealWindowSec: number;
    disputeWindowSec: number; maxEvidencePerClaim: number; ruleId: Bytes32;
  };
  safety: { publicDataOnly: boolean; redactions: string[]; warnings: string[] };
}

export interface EvidenceSource {
  uri: string; snapshotObjectId: Pointer; contentHash: Sha256;
  quotedSpan: string; spanStart: number; spanEnd: number;
  score: number; retrievedAt: Iso;
}

export interface ReportClaim {
  claimId: string; claimText: string; verdict: Verdict; confidence: number;
  reasoningSummary: string; createdAt: Iso; taskId: Bytes32;
  sources: EvidenceSource[];
  verifier: VerifierIdentity;
}

export interface VerifierIdentity {
  address: Address; verifierId: string; modelId: string; pipelineVersion: string;
}

export interface ComputeTrace {
  requestId: string; operation: "claim-extraction" | "evidence-scoring";
  provider: "local" | "zerog-router" | "zerog-broker";
  modelId: string; pipelineVersion: string;
  inputHash: Bytes32; outputHash: Bytes32;
  latencyMs: number; attempts: number;
  rawArtifactPointer: Pointer | null; verified: boolean;
}

export interface EvidenceGraph {
  nodes: Array<{ id: string; type: "claim" | "evidence" | "source"; label: string;
                 verdict: Verdict | null; confidence: number | null }>;
  edges: Array<{ from: string; to: string;
                 type: "supports" | "contradicts" | "insufficient" | "cites";
                 weight: number }>;
}

export interface VerifierReport {
  kind: "verifier-report"; schemaVersion: string;
  taskId: Bytes32; manifestHash: Bytes32; manifestPointer: Pointer;
  createdAt: Iso; verifier: VerifierIdentity;
  claims: ReportClaim[]; compute: ComputeTrace[]; graph: EvidenceGraph;
  summary: { supported: number; contradicted: number; insufficient: number;
             evidenceCoverage: number; meanConfidence: number };
}

export interface ConsensusClaim {
  claimId: string; claimText: string; majorityVerdict: Verdict; agreed: boolean;
  agreeingVerifiers: Address[]; dissentingVerifiers: Address[];
  verdicts: Array<{ verifier: Address; verdict: Verdict; confidence: number }>;
  evidenceCoverage: number; evidenceOverlap: number;
  criticalConflict: boolean; reason: string;
}

export interface ConsensusResult {
  kind: "consensus-result"; schemaVersion: string;
  taskId: Bytes32; manifestHash: Bytes32; ruleId: Bytes32;
  outcome: ConsensusOutcome; agreementBps: number;
  claims: ConsensusClaim[]; conflicts: string[];
  reportHashes: Bytes32[]; rewardedVerifiers: Address[];
  evaluatedAt: Iso; producer: string;
}

export interface ChallengeEvidence {
  kind: "challenge-evidence"; schemaVersion: string;
  taskId: Bytes32; challenger: Address; reason: string;
  disputedClaims: string[]; disputedReportHashes: Bytes32[];
  additionalEvidence: EvidenceSource[]; createdAt: Iso;
}

export interface AdjudicationReport {
  kind: "adjudication-report"; schemaVersion: string;
  taskId: Bytes32; adjudicator: Address; challengeHash: Bytes32;
  upheld: boolean; decision: string;
  claims: ReportClaim[]; compute: ComputeTrace[];
  revisedRewardedVerifiers: Address[]; createdAt: Iso;
}

export interface SourceSnapshot {
  kind: "source-snapshot"; schemaVersion: string;
  sourceId: string; uri: string; status: SourceStatus;
  httpStatus: number | null; contentType: string | null;
  headers: Record<string, string>;
  byteLength: number; contentHash: Sha256; text: string;
  truncated: boolean; retrievedAt: Iso; error: string | null; producer: string;
}

export interface TaskReportEntry {
  verifier: Address; verifierId: string | null; displayName: string | null;
  commitment: Bytes32; revealed: boolean;
  reportHash: Bytes32 | null; reportPointer: Pointer | null;
  committedAt: Iso | null; revealedAt: Iso | null;
  commitTxHash: Hex | null; revealTxHash: Hex | null;
  modelId: string | null; pipelineVersion: string | null;
  allocationWei: Wei;
  report: VerifierReport | null;      // inlined when ?include=reports
  hashVerified: boolean | null;
}

export interface TaskDispute {
  challenger: Address; bondWei: Wei;
  evidenceHash: Bytes32; evidencePointer: Pointer;
  resolved: boolean; upheld: boolean; outcome: number;
  openedAt: Iso; deadline: Iso;
  adjudicationHash: Bytes32 | null; adjudicationPointer: Pointer | null;
  openTxHash: Hex; resolveTxHash: Hex | null;
  evidence: ChallengeEvidence | null;
  adjudication: AdjudicationReport | null;
  expireAvailable: boolean;           // now > deadline && !resolved
}

export interface TaskDetail extends TaskListItem {
  manifest: TaskManifest | null;
  manifestVerified: boolean;          // recomputed hash === manifestHash
  snapshots: SourceSnapshot[];
  reports: TaskReportEntry[];
  consensus: ConsensusResult | null;
  dispute: TaskDispute | null;
  timeline: ActivityEvent[];
  actions: {                          // what the connected wallet may do
    canCancel: boolean; canChallenge: boolean; canClaimReward: boolean;
    canRefund: boolean; canFinalize: boolean; canExpire: boolean;
    challengeBondWei: Wei;
  };
}

// ── GET /v1/verifiers ─────────────────────────────────────────
export interface VerifierListItem {
  address: Address;
  displayName: string | null;         // metadata.displayName
  verifierId: string | null;          // "verifier-a"
  registered: boolean; approved: boolean; active: boolean;
  state: VerifierState;               // -> .directory-status
  tone: "lime" | "sky" | "coral";
  stakeWei: Wei; slashedWei: Wei;
  metadataHash: Bytes32; metadataPointer: Pointer;
  roles: Array<"KEEPER" | "ADJUDICATOR" | "PAUSER" | "ADMIN">;
  roleLabel: string;                  // -> .operator-identity span
  modelId: string | null; pipelineVersion: string | null;
  agreementPct: number | null;        // -> AGREEMENT
  revealRatePct: number | null;       // -> replaces UPTIME
  medianComputeLatencyMs: number | null;
  tasksCommitted: number; tasksRevealed: number;
  lastRevealAt: Iso | null;
  totalEarnedWei: Wei;
  registeredAt: Iso; registeredBlock: number; registeredTxHash: Hex;
}

export interface VerifierListResponse extends Page<VerifierListItem> {
  summary: OverviewStats["verifiers"];
}

// ── GET /v1/verifiers/{address}/history?buckets=24&unit=day ───
export interface VerifierHistoryResponse {
  address: Address; unit: "hour" | "day"; buckets: Array<{
    start: Iso; committed: number; revealed: number;
    revealRatePct: number | null;     // null => grey stub bar
    medianComputeLatencyMs: number | null;
  }>;
}

// ── GET /v1/artifacts ─────────────────────────────────────────
export interface ArtifactListItem {
  contentHash: Bytes32;               // canonical object hash — the storage key
  displayName: string;                // synthesized "verifier-report_0x1f46….json"
  kind: ArtifactKind;
  kindLabel: string;                  // "Verifier report"
  tone: "lime" | "sky" | "coral" | "ink";
  taskId: Bytes32 | null;
  pointer: Pointer;
  byteLength: number;
  producer: string | null;
  sourceContentHash: Sha256 | null;   // source-snapshot bodies only
  createdAt: Iso;
  firstSeenBlock: number | null; firstSeenTxHash: Hex | null;
  hashVerified: boolean;
  onchainRef: "manifestHash" | "reportHash" | "evidenceHash"
            | "adjudicationHash" | "metadataHash" | null;
}

export interface ArtifactListResponse extends Page<ArtifactListItem> {
  summary: OverviewStats["artifacts"];
}

// ── GET /v1/artifacts/{contentHash}  &  GET /v1/reports/{reportHash} ──
export interface ArtifactResponse {
  contentHash: Bytes32;
  kind: ArtifactKind;
  pointer: Pointer;
  byteLength: number;
  verified: boolean;                  // recomputed canonical hash matched
  source: "storage" | "cache";        // RUNBOOK: "cache" on gateway fallback
  fetchedAt: Iso;
  body: TaskManifest | SourceSnapshot | VerifierReport
      | ConsensusResult | ChallengeEvidence | AdjudicationReport;
}
// 409 CONTENT_HASH_MISMATCH is never served from cache.

// ── GET /v1/activity ──────────────────────────────────────────
export interface ActivityEvent {
  id: string;                         // `${txHash}:${logIndex}` | `job:${jobId}`
  origin: "chain" | "offchain";       // MUST be visually distinct
  category: ActivityCategory;
  eventName: string;                  // "ReportRevealed" | "MANIFEST_UPLOAD"
  title: string; detail: string;
  actor: Address | string;            // tx.from | producer
  actorRole: "creator" | "verifier" | "keeper" | "adjudicator" | "admin" | "api" | null;
  taskId: Bytes32 | null;
  hash: Hex | Bytes32 | string;       // txHash | contentHash | compute requestId
  hashKind: "tx" | "artifact" | "computeRequest";
  tone: "lime" | "sky" | "coral" | "ink";
  occurredAt: Iso;
  blockNumber: number | null; txHash: Hex | null; logIndex: number | null;
  amountWei: Wei | null;
  payload: Record<string, unknown>;   // decoded args / job record
}

export type ActivityResponse = Page<ActivityEvent>;

// ── GET /v1/activity/{id} ─────────────────────────────────────
export interface RawLogResponse {
  chainId: number; address: Address;
  blockNumber: number; blockHash: Hex; blockTimestamp: Iso;
  transactionHash: Hex; transactionIndex: number; logIndex: number;
  topics: Hex[]; data: Hex; removed: boolean;
  decoded: { name: string; args: Record<string, unknown> };
}

// ── POST /v1/tasks/prepare ────────────────────────────────────
export interface PrepareTaskRequest {
  title: string;
  question: string;
  claims?: Array<{ claimText: string }>;   // else extracted on Compute
  sources: Array<{ uri: string } | { inlineText: string; label: string }>;
  policy: {
    verifierCount: number;      // 2..16
    commitWindowSec: number;    // 30..2592000
    revealWindowSec: number;
    disputeWindowSec: number;   // <= 2592000
    maxEvidencePerClaim?: number;
  };
  bountyWei: Wei;               // >= params().minBounty (1e14)
}

export interface PrepareTaskResponse {
  manifest: TaskManifest;
  manifestHash: Bytes32;
  manifestPointer: Pointer;
  ruleId: Bytes32;
  snapshots: Array<Pick<SourceSnapshot,
    "sourceId" | "uri" | "status" | "httpStatus" | "byteLength"
    | "contentHash" | "truncated" | "error">>;
  /** ABI-ready tuple for createTask((uint32,uint32,uint32,uint32,bytes32,string,bytes32)) */
  createTaskArgs: {
    verifierCount: number; commitWindowSec: number;
    revealWindowSec: number; disputeWindowSec: number;
    manifestHash: Bytes32; manifestPointer: Pointer; ruleId: Bytes32;
  };
  valueWei: Wei;
  estimatedGas: string;
  warnings: string[];           // safety.warnings
}

// ── POST /v1/tasks/{taskId}/challenge ─────────────────────────
export interface PrepareChallengeRequest {
  reason: string;
  disputedClaims: string[];
  disputedReportHashes: Bytes32[];
  additionalSources?: Array<{ uri: string }>;
}
export interface PrepareChallengeResponse {
  evidence: ChallengeEvidence;
  evidenceHash: Bytes32;
  evidencePointer: Pointer;
  bondWei: Wei;                 // bounty * params().challengeBondBps / 10000
}

// ── POST /v1/tasks/{taskId}/sync ──────────────────────────────
export interface SyncResponse {
  taskId: Bytes32; scannedFrom: number; scannedTo: number;
  eventsProcessed: number; status: TaskStatus; syncState: "OK" | "SYNC_REQUIRED";
}

// ── auth (SIWE) ───────────────────────────────────────────────
export interface NonceResponse { nonce: string; issuedAt: Iso; expiresAt: Iso; statement: string; domain: string; chainId: number }
export interface VerifyRequest  { message: string; signature: Hex }
export interface VerifyResponse { address: Address; sessionExpiresAt: Iso }

// ── GET /v1/params ────────────────────────────────────────────
export interface ProtocolParams {
  conflictRateBps: number;      // 5000
  challengeBondBps: number;     // 1000
  verifierSlashBps: number;     // 0
  minBountyWei: Wei;            // "100000000000000"
  keeperGracePeriodSec: number; // 259200
  adjudicationWindowSec: number;// 604800
  minWindowSec: number;         // 30
  maxWindowSec: number;         // 2592000
  maxDisputeWindowSec: number;  // 2592000
  minVerifiers: number;         // 2
  maxVerifiers: number;         // 16
  maxPointerBytes: number;      // 256
  bpsDenominator: number;       // 10000
  paused: boolean;
}
```

---

## 3. Per-page API calls and polling

Every list endpoint accepts `?cursor=&limit=`; every artifact response is immutable and should be served `Cache-Control: public, max-age=31536000, immutable` (content-addressed).

### 3.1 Shared (`DashboardLayout`, mounted on all routes)

| Call | Purpose | Poll |
|---|---|---|
| `GET /health` | network card, footer chips, driver labels, paused banner | **30 s**; 5 s backoff-retry after a 503 |
| `GET /v1/chain/head` **or** wagmi `useBlockNumber({watch:true})` | "Latest block" | **5 s** (viem `pollingInterval: 5000`); prefer the wagmi watcher and skip the HTTP call |
| `GET /v1/stats/overview` | nav counts, notification badge | **20 s**, `refetchOnWindowFocus` |
| `GET /v1/params` | contract constants used by forms/validators | **once per session**, `staleTime: Infinity` |
| wagmi `useAccount`/`useChainId` | wallet button, signer rail, chain-mismatch banner | event-driven |

### 3.2 `/` Overview

| Call | Purpose | Poll |
|---|---|---|
| `GET /v1/stats/overview` | 4 metric cards (deduped with the shared query) | 20 s |
| `GET /v1/tasks?limit=5&sort=updated_desc` | "Latest tasks" table | **10 s**; 5 s while any listed task is non-terminal |
| `GET /v1/tasks/{selectedId}?include=manifest,reports,consensus` | task banner + evidence trail | **5 s** while non-terminal, then `staleTime: Infinity` |
| `GET /v1/artifacts/{snapshotHash}` | "View source" drawer | on demand, cache forever |
| `GET /v1/tasks/{id}/bundle` | Export JSON | on click |

### 3.3 `/verification-tasks`

| Call | Purpose | Poll |
|---|---|---|
| `GET /v1/stats/overview` | 3 summary strips | 20 s |
| `GET /v1/tasks?status=&q=&cursor=&limit=25` | main table (server-side filter + search, debounced 300 ms) | **8 s** when the page has non-terminal tasks, **60 s** when all terminal |
| `GET /v1/params` | verifier-count range, `minBounty`, window bounds for the create form | session |
| `POST /v1/tasks/prepare` | step 1 of create (Idempotency-Key required) | on submit |
| `POST /v1/auth/nonce` + `POST /v1/auth/verify` | SIWE session before `prepare` | on first mutation |
| `POST /v1/tasks/{taskId}/sync` | after `TaskCreated` receipt, force an indexer pass | once per created task |

### 3.4 `/verifier-network`

| Call | Purpose | Poll |
|---|---|---|
| `GET /v1/verifiers` | overview cards + directory | **60 s** (registry changes are rare) |
| `GET /v1/verifiers/{address}/history?buckets=24&unit=day` | uptime-bar panel | **on selection change**, `staleTime: 5 min` |
| `GET /v1/activity?category=Verification&limit=10` | "Latest verifier events" | **6 s**, or SSE `/v1/stream?category=Verification` |
| `GET /v1/artifacts/{metadataHash}` | "Inspect verifier metadata" | on demand |
| `useReadContract getVerifier(address)` | live truth for the selected operator's `approved/active/stake` | 30 s, or `watch` on `VerifierApprovalSet` |

### 3.5 `/artifacts`

| Call | Purpose | Poll |
|---|---|---|
| `GET /v1/artifacts?kind=&q=&cursor=&limit=25` | table + 3 stat cards (`summary` is embedded) | **30 s** |
| `GET /v1/artifacts/{contentHash}` | row click → object viewer | on demand, immutable cache |
| `POST /v1/artifacts/reindex` (or per-task `/sync`) | "Sync storage" | on click |

### 3.6 `/activity-log`

| Call | Purpose | Poll |
|---|---|---|
| `GET /v1/stats/overview` | 3 summary tiles | 20 s |
| `GET /v1/activity?category=&q=&cursor=&limit=50` | timeline | **6 s** head-poll (`after=<newest id>`, prepend); infinite-scroll uses `cursor` |
| `GET /v1/activity/{id}` | "View payload" | on demand |
| `GET /v1/activity.csv?...` | export | on click |

**Recommended upgrade for this page and the verifier signals:** `GET /v1/stream` (SSE) emitting `{type:"activity"|"task"|"health", payload}`, with the poll intervals above as fallback. `INDEXER_POLL_MS=2000` and `INDEXER_CONFIRMATIONS=2` set the floor on freshness — polling faster than ~4 s cannot produce new data.

### 3.7 `/protocol-docs`

| Call | Purpose | Poll |
|---|---|---|
| `GET /v1/params` | live window/bps annotations | session |
| `GET /v1/schemas/verifier-report` | render the schema block from the real JSON Schema | session |
| `GET /v1/reports/{sampleHash}` | show a real report as the sample | session |

---

## 4. UI elements that **cannot** be backed by live data

| # | Element | Why it is unbackable | Nearest honest live substitute |
|---|---|---|---|
| 1 | `"18"` active verifiers (`.network-overview-card > strong`) | Only 2 verifiers were ever registered on this deployment | Real count from `VerifierRegistered` logs ∩ `getVerifier().approved && .active` — expect **2** |
| 2 | `"16 online · 2 degraded"` | No heartbeat, no liveness beacon, nothing onchain or in any artifact reports endpoint health | `` `${approved} approved · ${registered-approved} awaiting approval` `` |
| 3 | `"ONLINE"` / `"DEGRADED"` status pills (`.status-online`/`.status-degraded`) | Same — a verifier is a key that commits, not a monitored service | `UNREGISTERED / PENDING / INACTIVE / IDLE / ACTIVE` from `getVerifier()` + last-reveal recency |
| 4 | `"Endpoint degraded"` signal row (Verifier network) | No such event exists onchain or offchain | Replace with a real registry event: `VerifierApprovalSet(addr,false)` → "Approval revoked" |
| 5 | `"99.8%"` uptime + the 24-bar `.uptime-bars` sparkline | Uptime is not observable; the contract records commits and reveals, not availability | **Reveal rate** = `ReportRevealed/ReportCommitted` per verifier, bucketed daily; relabel the panel `30-day reveal rate`; render `null` buckets as grey stubs, never as 100 |
| 6 | `"241ms"` / `"182ms"` median latency | Nothing measures verifier wall-clock latency; `compute[].latencyMs` is **self-reported inside an untrusted artifact** | Show it, labelled "median compute latency (self-reported)"; or an honest chain-derived alternative: median `revealedAt − committedAt` in seconds |
| 7 | `"+4.8% this month"`, `"18%"` metric trend, `"12% vs yesterday"` | No historical snapshots exist; the read model is rebuildable and carries no time series today | Compute the same metric over the immediately preceding window from block timestamps; suppress the badge when the prior window has no data — never render a placeholder percentage |
| 8 | `"Atlas Research"` / `"Personal workspace"` / avatar `"A"` | There is no workspace, org, or account entity anywhere in the contract or artifacts | The connected address (ENS → short address) + its derived role label |
| 9 | `.notification-badge` `"2"` | No notification store, no subscriptions | Count of actionable items for the connected wallet (`actionable.total`) |
| 10 | `"PR-1048"` task IDs | `taskId` is `bytes32`; the mock format implies a sequence the protocol does not mint | `shortHash(taskId)` (`0x1f46…54ee`), or an indexer `seq` rendered `#0004` **and explicitly marked index-derived**, since a read-model rebuild can renumber it |
| 11 | `.progress-fill` widths `100 / 64 / 42` | No progress field exists on `Task` | Lifecycle progress from `status` + `(committed+revealed)/(2*verifierCount)`; freeze and turn coral on `Disputed` |
| 12 | `"2/2 agree"` used as a per-task agreement | Agreement is **per claim** (`consensus-result.claims[].agreed`), not per task | Two-phase label: `"N/M revealed"` before consensus, `"K/C claims agree"` after; `"Conflict"` on `outcome==='CONFLICT'` |
| 13 | Artifact type `"Evidence graph"` | Not an object kind — the graph is `verifier-report.graph` | Remove the option, or render a virtual row explicitly labelled "derived from report 0x…" |
| 14 | Artifact type `"Visual evidence"` + `claim-source-capture.png` | Every canonical object is JSON; there is no image kind, and `challenge-evidence.additionalEvidence[]` is a text/span array | Remove; add `Consensus result`, `Challenge evidence`, `Adjudication report` |
| 15 | Artifact names `report_PR-1048.json`, `snapshot_0g-doc.html` | Storage keys are hashes; there are no filenames and no `.html` objects | Synthesize `${kind}_${shortTaskId}.json`, with the hash as the real identity |
| 16 | `hash: "sha256:7b1d…a32f"` on report/manifest rows | Wrong hash family — objects are `0x…` bytes32; `sha256:` is only a source **body** hash | Show `contentHash: 0x…` for objects and `sha256:…` in a separate "Source body hash" column |
| 17 | `0g://storage/7b1d…a32f` pointers | Not a scheme this system emits (`local://<hex>` locally, a 0G root under `zerog`) | Render `getTask().manifestPointer` / `getReport().reportPointer` verbatim |
| 18 | `"Dispute window closed"` activity entry | A lapsing window emits **no log** — nothing fires | Derive a clock-based row from `consensusAt + disputeWindow`, visually marked "derived", or drop it and show `TaskFinalized` instead |
| 19 | `"Storage adapter"` / `"0G Compute adapter"` actors and their rows | Storage/Compute activity is never onchain; it exists only as `jobs` rows and inside `verifier-report.compute[]` | Keep them but mark `origin:"offchain"` distinctly (PRD §11 requires onchain/offchain to be visually different) — and note compute traces only become visible **after reveal** |
| 20 | `"Compute job completed · 182ms across 3 claims"` before reveal | Compute traces are inside the report, which is unreadable until `revealReport` | Show it only after `ReportRevealed`; before that, show the job row from `jobs` with no model detail |
| 21 | `"Verifier A/B/C"` display names | No name field onchain | `metadataPointer` → `metadata.displayName` → `verifier-report.verifier.verifierId` → `shortAddress` |
| 22 | Verifier `role`: `"Primary evidence"` / `"Independent check"` / `"Adjudication backup"` | No verifier role taxonomy exists | `hasRole(ADJUDICATOR_ROLE)` → "Adjudicator", `hasRole(KEEPER_ROLE)` → "Keeper", else "Verifier" |
| 23 | `"3,840 0G"` total staked | `verifierSlashBps=0`; MVP registers with zero stake | `Σ getVerifier(a).stake` — expect `0 0G`, with the honest caption `"Staking disabled (slashBps 0)"` |
| 24 | `"Bounties settled 84.50 0G"` | The live contract holds **0.0094 0G** total escrow; `minBounty` is 0.0001 0G | `Σ RewardAllocated.amount` — real numbers are ~0.001–0.01 0G. Use 4 dp, not 2, or the whole column reads `0.00` |
| 25 | `"#1,945,822"` latest block | Galileo head is >52.3M | `eth_blockNumber` |
| 26 | Hero `"2 verifiers · 1 settlement"` + `"LIVE EVIDENCE GRAPH"` over a static PNG | The image is decorative and unconnected to any task | Either bind the caption to the selected task's real counts, or drop "LIVE" — a static PNG labelled "live" is the kind of claim the product exists to prevent |
| 27 | `.visual-corner` `"0G / PROOF-01"`, `"hash anchored"` | Decorative | `0G / ${shortTaskId}`; show "hash anchored" only when `manifestHash !== 0x0` |
| 28 | `"12 tasks"` in `Across 12 tasks`, `"28"` objects, `"18.4 MB"` | Plausible but invented magnitudes | All three are genuinely computable — they are listed here only because the demo numbers are ~10× the real ones and will not survive first contact |
| 29 | `/manus-storage/*` images (mark, paper texture, evidence graph) | The proxy needs `BUILT_IN_FORGE_API_KEY` and exists only in Vite dev; `server/index.ts` serves static files only | Vendor the three assets into `client/public/` before any deploy |
| 30 | `"IN REVIEW"` / `"VERIFIED"` as the only non-dispute states | The contract has 8 statuses × 4 outcomes; `Finalized+Conflict`, `Expired`, `Cancelled`, `NoQuorum` have nowhere to render | Extend the pill map and the filter tabs per §6.1 — otherwise a finalized **conflict** displays as VERIFIED, which is exactly the failure ProofRelay is built to prevent |

---

## 5. Wallet transactions vs API calls

### 5.1 Must be real wallet transactions (wagmi `useWriteContract` + `useWaitForTransactionReceipt`)

| UI trigger | Contract call | Args / value | Gate |
|---|---|---|---|
| `Create verification task` (`.primary-button`, both modals) | `createTask((uint32,uint32,uint32,uint32,bytes32,string,bytes32))` `0xc84cdccb` **payable** | `PrepareTaskResponse.createTaskArgs`; `value = bountyWei` | connected + `chainId===16602` + `!paused` + `bounty >= minBounty` |
| `Register verifier` (Verifier network) | `registerVerifier(bytes32,string)` `0x508450a9` **payable** | `metadataHash`, `metadataPointer` (API uploads the metadata artifact first); `value = optional stake` | connected + `!paused` |
| Verifier self-toggle (`.side-card-head` menu) | `setVerifierActive(bool)` `0x8a63f9b8` | `active` | `address === verifier.address` |
| `Open challenge` (task detail — **does not exist yet**) | `openChallenge(bytes32,bytes32,string)` `0xadac7b6e` **payable** | `taskId`, `evidenceHash`, `evidencePointer` from `PrepareChallengeResponse`; `value = bounty * challengeBondBps/10000` (10%) | `status==='Consensus'` && within dispute window && `!paused` |
| `Claim reward` | `claimReward(bytes32)` `0xf5414023` | `taskId` | `allocationOf(taskId, me) > 0`; auto-finalizes per RUNBOOK |
| `Withdraw` (user menu) | `withdraw()` `0x3ccfd60b` | — | `pendingWithdrawals(me) > 0` |
| `Refund` (creator, task detail) | `refundCreator(bytes32)` `0x372c9601` | `taskId` | `creator === me` && refund condition met |
| `Cancel task` (creator) | `cancelTask(bytes32)` `0xee8ca3b5` | `taskId` | `creator === me` && `committed === 0` |
| `Finalize` (permissionless rescue) | `finalizeTask(bytes32)` `0x4c720f77` | `taskId` | `status==='Consensus'` && dispute window elapsed — **anyone** |
| `Expire task` (permissionless rescue) | `expireTask(bytes32)` `0x5697a2ec` | `taskId` | `now > revealDeadline` — **anyone**. No grace period: bisected against historical state, the block whose timestamp equalled `revealDeadline` refused with `DeadlineNotPassed()` and the next second allowed it. |
| `Expire dispute` (permissionless rescue) | `expireDispute(bytes32)` `0x83f14c6c` | `taskId` | `now > dispute.deadline` (`adjudicationWindow` 7 d) — **anyone** |
| `Withdraw stake` (verifier) | `withdrawStake(uint256)` `0x25d5971f` | `amount` | registered verifier with free stake |

The three permissionless rescue buttons are the highest-value additions the UI does not have: they turn RUNBOOK `cast send` procedures into product, and they are exactly what makes "escrow can never be trapped" demonstrable to a judge.

### 5.2 Admin/role-gated — render only behind `hasRole`, never as generic buttons

`setVerifierApproval(address,bool)` `0x32f9610c` (DEFAULT_ADMIN), `pause()`/`unpause()` (PAUSER_ROLE `0x4df6ff9a…`), `grantRole`/`revokeRole`, `finalizeConsensus(bytes32,bytes32,uint8,address[],uint16)` `0xd779e0b2` (KEEPER_ROLE `0xd4d16a49…`), `resolveDispute(bytes32,bool,bytes32,string,address[],bytes32)` `0x52f89692` (ADJUDICATOR_ROLE `0xb4022bc6…`).

`commitReport` `0x454d8929` and `revealReport` `0x8d1bba6a` are **worker-only** and must never be callable from the browser — a reveal from a browser leaks the salt into a URL/log and breaks the commit/reveal independence guarantee (THREAT_MODEL, "A verifier copies another verifier's answer").

### 5.3 API calls, not transactions

`POST /v1/auth/nonce` → wallet `signMessage` (SIWE, personal_sign — **not** a transaction) → `POST /v1/auth/verify`; `POST /v1/tasks/prepare` (with `Idempotency-Key`); `POST /v1/tasks/{id}/challenge`; `POST /v1/tasks/{id}/sync`; every `GET`; export/bundle; artifact fetches.

### 5.4 Pure client, no network

Copy hash / address / pointer (`navigator.clipboard`), the JSON bundle download once fetched, filter/search state, `expanded`/`selected`/`active` section state, theme.

### 5.5 Chain-state guards every write path needs

1. **Chain mismatch** — `useChainId() !== 16602` → `switchChain` prompt; RUNBOOK notes wagmi persists a stale Anvil connection across reloads.
2. **Paused** — `paused()` true blocks `createTask`, `commitReport`, `openChallenge` but deliberately **not** finalize/expire/withdraw; the UI must reflect that asymmetry rather than disabling everything.
3. **Receipt lag** — DEPLOYMENT documents `TransactionReceiptNotFoundError` on Galileo; `useWaitForTransactionReceipt` needs `retryCount`/`pollingInterval` tuned to retry that specific error rather than surfacing it as a failure.
4. **Min priority fee** — Galileo rejects tips below 2 gwei; set `maxPriorityFeePerGas: max(eth_maxPriorityFeePerGas, 2n gwei)` on every write.
5. **Toasts → tx lifecycle.** Every `toast("… is simulated in this frontend preview")` becomes a four-state control: *signing* → *pending (`txHash` + explorer link)* → *confirmed (decoded event)* → *reverted (decoded custom error)*. There are 21 such placeholder toasts across the six pages.

---

## 6. Appendix — mappings the API and UI must share

### 6.1 Contract `status`/`outcome` → pill text and tone

| `status` | `outcome` | `displayState` | Pill | Tone | Filter group |
|---|---|---|---|---|---|
| Open | Pending | `IN REVIEW` | AWAITING COMMITS | sky | IN REVIEW |
| Revealing | Pending | `IN REVIEW` | REVEALING | sky | IN REVIEW |
| Consensus | Consensus | `IN REVIEW` | DISPUTE WINDOW | sky | IN REVIEW |
| Consensus | Conflict | `CONFLICT` | CONFLICT | coral | CONFLICT |
| Disputed | any | `DISPUTED` | DISPUTED | coral | DISPUTED |
| Finalized | Consensus | `VERIFIED` | VERIFIED | lime | VERIFIED |
| Finalized | Conflict | `CONFLICT` | CONFLICT | coral | CONFLICT |
| Finalized | NoQuorum | `EXPIRED` | NO QUORUM | ink | EXPIRED |
| Expired | any | `EXPIRED` | EXPIRED | ink | EXPIRED |
| Cancelled | — | `CANCELLED` | CANCELLED | ink | CANCELLED |

The numeric `uint8 status`/`outcome` values must be pinned by a cross-check test against the deployed bytecode before this table is wired (ARCHITECTURE §15 "Cross-check: `taskId` and commitment encodings pinned against the TypeScript client" — extend it to the enums).

### 6.2 Verdict → pill

`SUPPORTED` → lime, label `SUPPORTED`. `CONTRADICTED` → coral, label `CONTRADICTED` (**no branch exists today**; it currently renders lime). `INSUFFICIENT_EVIDENCE` → sky, label `INSUFFICIENT`.

### 6.3 Error codes the UI must render specifically

`PERSONAL_DATA_REJECTED` (create form, inline on the offending field), `CONTENT_HASH_MISMATCH` (409 — a red "artifact does not match its onchain hash" banner, never a silent fallback), `SOURCE_UNAVAILABLE` (per-source badge in the manifest preview), `SSRF_BLOCKED` (inline on the URL field), `RATE_LIMITED` (`RATE_LIMIT_MAX=120` / 60 s), `SYNC_REQUIRED` (show the chain value, offer `POST /v1/tasks/{id}/sync`), and `"source": "cache"` on `/v1/reports/{hash}` (a visible "served from index cache, storage gateway unreachable" chip).

### 6.4 Frontend config

`VITE_API_URL` (default `http://127.0.0.1:8080`), plus `VITE_CHAIN_ID=16602`, `VITE_PROOFRELAY_ADDRESS=0xc1E353cb44eA09729143f06Af97E51FB952b33D7`, `VITE_RPC_URL=https://evmrpc-testnet.0g.ai`, `VITE_EXPLORER_URL=https://chainscan-galileo.0g.ai`, `VITE_STORAGE_EXPLORER_URL=https://storagescan-galileo.0g.ai`. `CORS_ORIGINS` currently defaults to `http://localhost:5173` while this Vite app serves on **3000** — that mismatch blocks every API call on first run.