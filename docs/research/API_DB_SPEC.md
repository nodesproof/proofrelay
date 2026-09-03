| `dispute_opened_total` | counter | — | **Indexer**, `ChallengeOpened` projector. |
| `payout_total` | counter | `kind` = `allocated\|claimed\|refunded` | `allocated` — **Indexer**, `RewardAllocated` projector, incremented by the wei amount. `claimed` — the `pendingWithdrawals` reconciler when an allocation flips to consumed. `refunded` — the reconciliation sweep when `getTask` reaches `Expired` with a creator refund allocation. Unit is **wei**; a companion `payout_count_total{kind}` counts events. |
| `job_retry_total` | counter | `job_type`, `error_code` | **Orchestrator**, in the transition to `FAILED_RETRYABLE` (one increment per failed attempt, before the backoff sleep). Also incremented by the keeper on a replacement broadcast with `job_type="KEEPER_SUBMISSION"`. |
| `chain_sync_lag_blocks` | gauge | — | **Indexer**, set at the end of every pass to `head_block - last_block`; also set by the reconciliation sweep so the gauge does not go stale when `eth_getLogs` returns nothing. This is the same number served as `indexer.lagBlocks` in `/health`, and the RUNBOOK alert fires above 20. |
| `compute_request_latency_ms` | histogram | `provider`, `operation`, `outcome` | **Orchestrator** hydration of `verifier-report.compute[]` — one `observe(latencyMs)` per `ComputeTrace` ingested, labelled from `provider` and `operation`. Also observed directly by the adjudicator module for its own calls. Buckets: `10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 45000` (the last aligned to `COMPUTE_TIMEOUT_MS`). |
| `storage_upload_latency_ms` | histogram | `driver`, `kind`, `outcome` | **Storage adapter**, wrapping every `put` — `SOURCE_SNAPSHOT`, `MANIFEST_UPLOAD`, `CONSENSUS_EVALUATION`, the challenge preparer, and the adjudicator. `outcome` = `ok\|error`, so a retry storm is visible without reading logs. Buckets: `25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000`. |
| `http_request_latency_ms` | histogram | `method`, `route`, `status` | **Fastify `onResponse` hook**, one observation per request. `route` is the *registered* path template (`/v1/tasks/:taskId`), never the concrete path — a per-taskId label would be an unbounded cardinality bomb. `/metrics` and `/health/live` are excluded from the histogram to keep probe traffic out of the p95. Buckets: `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000`. |

### 7.1 Supporting series (not in the RUNBOOK list, safe to add)

These exist because the RUNBOOK's alert table needs them; they never replace a named metric above.

| Metric | Type | Labels | Where |
|---|---|---|---|
| `job_queue_depth` | gauge | `status`, `job_type` | Orchestrator, refreshed every 5 s from `SELECT status, job_type, count(*) FROM jobs GROUP BY 1,2`. Backs the "Queue backlog" alert and `/health`'s `queue`. |
| `job_duration_ms` | histogram | `job_type`, `outcome` | Orchestrator, on every attempt completion. |
| `dependency_up` | gauge (0/1) | `dependency` = `database\|storage\|compute\|chain` | `/health` probe cache writer. Lets the "Chain RPC down" / "Storage errors" / "Compute errors" alerts be expressed without scraping JSON. |
| `indexer_events_processed_total` | counter | `event_name` | Indexer, per projected log. |
| `indexer_reorgs_total` | counter | `depth_bucket` | Indexer, on a block-hash mismatch. |
| `chain_head_block` / `indexer_last_block` | gauge | — | Indexer pass. |
| `contract_balance_wei` / `contract_liabilities_wei` | gauge | — | Keeper tick, from `eth_getBalance` and `totalLiabilities()`. Backs the "Contract underfunded" P0 alert: `contract_balance_wei < contract_liabilities_wei`. |
| `keeper_balance_wei` | gauge | `address` | Keeper tick. |
| `keeper_submissions_total` | counter | `action`, `state` | Keeper, on every `keeper_submissions` state change (`SENT`, `CONFIRMED`, `REVERTED`, `ABANDONED`). |
| `auth_verify_total` | counter | `result` = `ok\|signature_invalid\|nonce_expired\|nonce_consumed\|chain_mismatch\|domain_mismatch` | `/v1/auth/verify` handler. A spike in `nonce_consumed` is a replay attempt. |
| `rate_limit_rejections_total` | counter | `bucket` | Rate limiter, on each 429. |
| `source_fetch_total` | counter | `outcome` = `ok\|truncated\|unavailable\|blocked`, `reason` | Source fetcher. `blocked` with a `reason` label is the SSRF attempt counter. |
| `artifact_hash_mismatch_total` | counter | `kind` | Every place a retrieved artifact fails its keccak check — `/v1/reports/:hash`, `/v1/artifacts/:hash`, the reveal hydration job. This is the one counter that should always be zero; any non-zero value is either a corrupted gateway or a lying verifier, and both need a human. |

### 7.2 Alert expressions

Direct translations of the RUNBOOK table, so the runbook and the rules file cannot drift:

```promql
# Chain RPC down            → switch OG_RPC_URL
dependency_up{dependency="chain"} == 0

# Indexer lag               → check indexer.lastError; POST /v1/tasks/{id}/sync
chain_sync_lag_blocks > 20

# Compute errors            → check ledger balance; consider COMPUTE_DRIVER=local
increase(job_retry_total{job_type=~"CONSENSUS_EVALUATION|VERIFIER_DISPATCH"}[10m]) > 5
  or dependency_up{dependency="compute"} == 0

# Storage errors            → check storage wallet balance and the indexer endpoint
dependency_up{dependency="storage"} == 0
  or rate(storage_upload_latency_ms_count{outcome="error"}[5m])
     / rate(storage_upload_latency_ms_count[5m]) > 0.10

# Queue backlog             → look for FAILED_FINAL and last_error_code in jobs
job_queue_depth{status="PENDING"} > 50
  or job_queue_depth{status="FAILED_FINAL"} > 0

# Contract underfunded      → P0 contract bug
contract_balance_wei < contract_liabilities_wei

# Integrity (not in the runbook table, but the highest-severity signal here)
increase(artifact_hash_mismatch_total[1h]) > 0
```

---

## 8. Configuration surface

Everything the API reads, with precedence `process.env` → `.env.local` → `.env` (DEPLOYMENT.md; `.env.local` winning is what causes the "wrong chain" failure mode, so the resolved values are logged at boot and echoed by `/health`).

| Variable | Default | Used by |
|---|---|---|
| `CHAIN_ID` | `16602` | boot assertion, SIWE, every response header |
| `OG_RPC_URL` | `https://evmrpc-testnet.0g.ai` | chain client |
| `PROOFRELAY_ADDRESS` | — | boot assertion (code must exist at the address) |
| `PROOFRELAY_DEPLOY_BLOCK` | — | indexer floor; boot refuses `0` off-anvil |
| `API_HOST` / `API_PORT` | `0.0.0.0` / `8080` | server |
| `DATABASE_URL` | — | pg pool (min 2, max 10) |
| `CORS_ORIGINS` | `http://localhost:5173` | CORS allow-list (never `*` with credentials) |
| `LOG_LEVEL` | `info` | pino, structured JSON |
| `SESSION_TTL_SEC` | `3600` | sessions |
| `AUTH_DOMAIN` / `AUTH_URI` / `AUTH_NONCE_TTL_SEC` | — / — / `300` | SIWE |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `120` / `60000` | global bucket |
| `PRODUCER_ID` | `proofrelay-api/1.0.0` | every artifact's `producer` |
| `STORAGE_DRIVER` / `STORAGE_ROOT` / `STORAGE_INDEXER_RPC` / `STORAGE_PRIVATE_KEY` | `local` / `.proofrelay/storage` / turbo indexer / — | storage adapter |
| `STORAGE_FALLBACK_GATEWAYS` | *(new)* comma-separated | `/v1/reports/:hash` gateway chain before `source:"cache"` |
| `COMPUTE_DRIVER` / `COMPUTE_BASE_URL` / `COMPUTE_API_KEY` / `COMPUTE_MODEL` / `COMPUTE_PRIVATE_KEY` / `COMPUTE_TIMEOUT_MS` | `local` / router / — / `llama-3.3-70b-instruct` / — / `45000` | compute adapter, `/health` |
| `FETCH_MAX_BYTES` / `FETCH_TIMEOUT_MS` / `FETCH_ALLOW_PRIVATE` | `524288` / `15000` / `0` | source fetcher (§6.4) |
| `FETCH_MAX_REDIRECTS` | *(new)* `3` | source fetcher |
| `INDEXER_ENABLED` / `INDEXER_POLL_MS` / `INDEXER_CONFIRMATIONS` / `INDEXER_START_BLOCK` / `INDEXER_BATCH_SIZE` | `true` / `2000` / `2` / `0` / `2000` | indexer |
| `INDEXER_RECONCILE_MS` | *(new)* `60000` | reconciliation sweep |
| `ORCHESTRATOR_ENABLED` / `ORCHESTRATOR_POLL_MS` | `true` / `1500` | job runner |
| `KEEPER_PRIVATE_KEY` / `KEEPER_ADDRESS` | — | keeper signer |
| `KEEPER_POLL_MS` / `KEEPER_MIN_BALANCE_WEI` / `KEEPER_MAX_TX_PER_TICK` / `KEEPER_RECEIPT_DEADLINE_MS` | *(new)* `5000` / `2e16` / `2` / `180000` | keeper |
| `ADJUDICATOR_PRIVATE_KEY` | — | adjudicator module (separate signer) |
| `REDIS_URL` | — | rate limiter + queue when present |
| `METRICS_TOKEN` | — | `/metrics` bearer guard |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_SECRET` | — | `NOTIFICATION` job |
| `TRUST_PROXY_HOPS` | `0` | client IP resolution |

`INDEXER_START_BLOCK` and `PROOFRELAY_DEPLOY_BLOCK` are both present in `.env.local` at `52352124`; the indexer uses `max(INDEXER_START_BLOCK, PROOFRELAY_DEPLOY_BLOCK)` and refuses `0` when `CHAIN_ID !== 31337`.

---

## 9. Module layout for `apps/api`

```
apps/api/src/
├── server.ts                 # Fastify bootstrap; boot assertions; graceful shutdown
├── config/
│   ├── env.ts                # zod-parsed env, .env.local-over-.env precedence, resolved-config log
│   └── constants.ts          # MIN_WINDOW, MAX_VERIFIERS, BPS_DENOMINATOR, MAX_POINTER_BYTES
├── http/
│   ├── plugins/              # requestId, cors, bodyLimit(2MB), rateLimit, idempotency, errorMapper
│   ├── routes/
│   │   ├── health.ts         # /health, /health/live, /health/ready
│   │   ├── metrics.ts
│   │   ├── auth.ts           # nonce, verify, session, logout
│   │   ├── tasks.ts          # list, prepare, detail, sync, challenge
│   │   ├── reports.ts        # /v1/reports/:reportHash
│   │   ├── verifiers.ts
│   │   ├── artifacts.ts
│   │   ├── activity.ts
│   │   └── stats.ts
│   └── schemas/              # zod request/response contracts, exported for the web client
├── domain/
│   ├── manifest.ts           # task-manifest assembly + PII/safety scan
│   ├── challenge.ts          # challenge-evidence assembly + bond quote
│   ├── consensus.ts          # thin wrapper over packages/consensus
│   ├── safety.ts             # PERSONAL_DATA_REJECTED matchers
│   └── views.ts              # TaskSummary / Verifier / Artifact / ActivityItem projections
├── fetcher/
│   ├── sourceFetcher.ts      # §6.4, DNS-pinned agent, per-hop revalidation
│   ├── ipRules.ts            # the reserved-range table, unit-tested directly
│   └── sanitize.ts           # script/style stripping → text
├── chain/
│   ├── abi.ts                # the recovered ABI, one exported const
│   ├── topics.ts             # topic0 computation + recon-prefix assertions
│   ├── enums.ts              # TASK_STATUS / TASK_OUTCOME + startup self-check
│   ├── client.ts             # viem public client, waitForReceipt retry, 2 gwei tip floor
│   └── params.ts             # cached params(), invalidated by 0x530312ca…
├── indexer/
│   ├── indexer.ts            # the pass loop, batching, reorg rewind
│   ├── projectors/           # one file per event, each idempotent
│   └── reconcile.ts          # getTask/getReport/getDispute sweep
├── keeper/
│   ├── keeper.ts             # eligibility scan + tick ordering
│   ├── checks.ts             # the 15 pre-submit safety checks
│   ├── allowlist.ts          # the four permitted selectors
│   └── submitter.ts          # nonce discipline, replacement, receipt patience
├── orchestrator/
│   ├── runner.ts             # lease/claim, backoff, reaper
│   └── handlers/             # one file per job type
├── db/
│   ├── pool.ts
│   ├── migrations/           # → infra/migrations
│   └── repositories/
├── observability/
│   ├── metrics.ts            # the registry; names from §7
│   └── logger.ts             # taskId/requestId/verifierId/txHash/errorCode fields
└── adapters/                 # re-exports of packages/storage-adapter, compute-adapter, chain-client
```

---

## 10. Test obligations for this surface

| Class | What must be covered |
|---|---|
| Canonicalization | Round-trip every one of the 84 surviving artifacts: parse → `canonicalize` → assert the bytes are identical to the file, and `keccak256` equals the filename. This is the single test that proves the rebuild is compatible with the live deployment. |
| Hash discipline | `contentHash` is `sha256:` over fetched bytes; `manifestHash`/`reportHash`/`resultHash` are `0x` keccak over canonical bytes. A test that swaps them must fail. |
| SSRF | Each rejected range gets a case, `169.254.169.254` by name; a redirect chain `public → 169.254.169.254` must be blocked at hop 2; a DNS-rebind fixture must be blocked by the pinned connect. THREAT_MODEL says this is "Tested directly" — keep it that way. |
| Auth | Replay of a consumed nonce with a *valid* signature returns 401; wrong chainId, wrong domain, expired, address mismatch each get a case; the consume-after-verify ordering is asserted by a concurrent double-submit test where exactly one succeeds. |
| Idempotency | Same key + same body → identical bytes and `x-idempotent-replay`; same key + different body → 409; crashed `IN_FLIGHT` older than 60 s is re-runnable. |
| Indexer | `(chainId, txHash, logIndex)` double-ingest is a no-op; a full replay from the deploy block produces byte-identical `tasks`/`reports`/`consensus_results` rows; a simulated reorg rewinds and reconverges. |
| Keeper | Every one of the 15 checks has a negative test; specifically, a `beneficiaries` array containing a non-revealer must be refused **by the keeper** before the contract sees it, and a selector outside the allowlist must be refused by the signer. |
| `/v1/reports/:hash` | A tampered cached body returns 409 `CONTENT_HASH_MISMATCH` and never 200; a gateway outage with a good cache returns 200 with `source:"cache"`; both are named behaviours in the RUNBOOK. |
| Orchestrator | A compute failure exhausts 3 attempts → `FAILED_RETRYABLE` → `FAILED_FINAL`, and the task's status is **unchanged** throughout — the "never auto-verified on compute failure" invariant. |
| Contract cross-check | `computeCommitment(taskId, verifier, reportHash, salt)` from the chain equals the TypeScript encoding, and the predicted `expectedTaskId` matches a real `TaskCreated` log. THREAT_MODEL already counts 2 cross-check tests; these are them. |

---

## 11. Open items the rebuild must resolve against the live chain

Stated plainly rather than guessed at, because each one is a place where a confident-looking wrong answer would propagate into the UI:

1. **`TaskStatus` / `Outcome` ordinals.** The recon pinned `getTask`'s *shape*, not the enum values. `chain/enums.ts` must self-check at boot against the live finalized task and fail with `CHAIN_ENUM_MISMATCH` rather than mislabel.
2. **`createTask` tuple field order.** `(uint32,uint32,uint32,uint32,bytes32,string,bytes32)` maps cleanly onto `verifierCount / commitWindowSec / revealWindowSec / disputeWindowSec / manifestHash / manifestPointer / ruleId`, and the manifest `policy` block corroborates the four windows — but the order of the four `uint32`s must be confirmed by decoding one of the four real `createTask` calldatas the recon already found before any user signs one.
3. **`taskId` derivation.** `creatorNonce(address)` exists, so the id is derived from `(creator, nonce, …)`. The exact preimage must be recovered by matching a known `TaskCreated` topic against candidate encodings; until then `expectedTaskId` stays advisory and the UI reconciles on the event.
4. **`params()` slots 2, 3, 6, 9.** Surfaced positionally, unnamed.
5. **No `RewardClaimed`/`Withdrawn` topic0 in the recon.** Claim state is polled from `pendingWithdrawals` / `allocationOf`. If a claim event exists under a topic the recon missed, the unknown-event capture in §3.1 will surface it in `chain_events` with its raw topic0 — at which point it should be promoted to a named projector rather than left to polling.
6. **`0x530312ca…` event name.** Recorded and displayed by topic0 only.

---

**Files referenced (absolute paths):**
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/docs/ARCHITECTURE.md`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/docs/PRD.md`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/docs/RUNBOOK.md`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/docs/THREAT_MODEL.md`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/docs/DEPLOYMENT.md`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/docs/recon/RECOVERED_ABI.md`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/.env.example`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/.env.local`,
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/.proofrelay/storage/` (84 artifacts; schemas pinned from `29/ff/29ff00f5…` task-manifest, `e0/9f/e09f45d9…` + `ef/54/ef54fc0d…` source-snapshots, `19/32/1932c84e…` verifier-report, `17/aa/17aaec5e…` + `ac/d4/acd43e62…` consensus-results, `2f/6f/2f6f5653…` challenge-evidence, `5a/ef/5aef4417…` adjudication-report),
`/home/mdlog/Project-MDlabs/Akindo/ProofRelay/proofrelay-frontend/client/src/pages/` (Overview, VerificationTasks, VerifierNetwork, Artifacts, ActivityLog — the source of the five new endpoints' field lists).