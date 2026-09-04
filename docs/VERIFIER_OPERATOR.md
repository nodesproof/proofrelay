# Running a verifier

A verifier is an independent operator in ProofRelay's market. It reads each
task's snapshotted sources from 0G Storage, scores the claims through 0G
Compute, commits a hash of its report before it can see anyone else's, reveals
it, and is paid from the bounty when the verifiers agree. It needs a machine, a
key with a little 0G on it, and a compute credential. It does not need the
deployment's API, its database, or its web app — and it must not have the
deployment's keys.

Contract: `0xD3101C19175b50fD47C9e0B14A2dc63485f527D1` on 0G mainnet (chain 16661), verified on
[ChainScan](https://chainscan.0g.ai/address/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1) and
[Sourcify](https://repo.sourcify.dev/16661/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1/).

## 1. Configure

```bash
cp .env.verifier-standalone.example .env
```

Fill in `VERIFIER_A_PRIVATE_KEY` and a compute credential. That file is the
entire configuration; everything network-shaped is defaulted from `CHAIN_ID`.

## 2. Fund the key

Read off real receipts at the 4 gwei the network settles at:

| | 0G |
|---|---|
| `registerVerifier`, once | 0.00069 |
| per task: `commitReport` + `revealReport` | 0.00134 |
| per task: the report body into 0G Storage | 0.00118 |
| collecting rewards, batched (see `VERIFIER_MIN_COLLECT_WEI`) | ~0.0002 per batch |

Roughly **0.0025 0G per task**. 0.1 0G runs about forty; there is no faucet on
mainnet, so buy it. Compute is billed separately — through the router's
credential, or from your own ledger on the broker path — at fractions of a
cent per task on the default model.

## 3. Run

```bash
docker compose -f infra/docker-compose.verifier.yml up --build
```

Or without Docker, from a checkout with Node 22:

```bash
npm ci -w workers/verifier --include-workspace-root
npx tsc -b workers/verifier
node workers/verifier/dist/main.js
```

On first start the worker calls `registerVerifier` with your key. Watch for
`registered verifier` in the log with a transaction hash.

The image writes its **commit journal** to `/app/.proofrelay`. A verifier that
loses it cannot reveal what it already committed to and forfeits that task's
reward — compose mounts a named volume there; do the same if you run it another
way.

## 4. Get approved

This MVP's sybil defence is an allow-list. After you register, the directory
lists you as **PENDING** and the dispatcher will not assign you work until a
holder of `DEFAULT_ADMIN_ROLE` calls `setVerifierApproval(you, true)`. Send
your address to the deployment's admin; approval is one transaction on their
side. Nothing in the protocol lets an operator approve itself, and that is
deliberate.

## 5. What it earns, and how to collect

When the revealed verdicts reach consensus, the bounty is split among the
verifiers in the agreeing set — a dissenting reveal on a task that still
reaches consensus earns nothing for that task. When they conflict, every
verifier that revealed is paid the reduced conflict rate (half the bounty,
shared) and the rest returns to the creator. A verifier that commits but never
reveals earns nothing either way. Rewards accrue onchain
per task and are pulled with `claimReward` then `withdraw`, which the worker
does for you once the unclaimed total clears `VERIFIER_MIN_COLLECT_WEI` —
collecting eagerly would spend more in gas than a minimum-bounty task pays.

## What the verifier reads, and does not

| Reads | Never touches |
|---|---|
| the contract, over `OG_RPC_URL` | the deployment's API |
| 0G Storage, over the indexer | its Postgres database |
| 0G Compute, router or broker | its `.env`, or any key that is not yours |

That boundary is asserted by `workers/architecture.test.ts`, which fails the
build on the first import that crosses it.
