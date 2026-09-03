# Deploying ProofRelay to 0G

## Current deployment

| | |
|---|---|
| Contract | `0xD3101C19175b50fD47C9e0B14A2dc63485f527D1` |
| Chain | 0G mainnet, 16661 |
| Deployed at block | `43394193` — the indexer starts here, not at genesis |
| Explorer | https://chainscan.0g.ai/address/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1 |
| Deploy cost | 0.018764 0G at 4 gwei, read off the receipt |

## Things 0G does differently

Three chain behaviours cost real debugging time. All three are handled in the
scripts and the chain client now, but they are worth knowing if you deploy by
hand — each one produces an error message that points somewhere else.

**A minimum priority fee is enforced.** 0G rejects transactions below a
2 gwei tip with `transaction gas price below minimum: gas tip cap 1`. Foundry's
own estimator produced a 1 wei tip here, so `deploy.sh` reads
`eth_maxPriorityFeePerGas` from the chain and floors it at 2 gwei.

**Receipts lag block production.** The node reports a block before the receipts
for its transactions are queryable, which viem raises as
`TransactionReceiptNotFoundError`. Treating that as failure abandons
transactions that actually succeeded, so `waitForReceipt` in the chain client
retries that specific error until a deadline.

**A simulation without an explicit gas limit is priced at the block gas limit.**
Send a transaction with no `gas` set and the node checks affordability against
`blockGasLimit * gasPrice`, so a wallet holding 0.016 0G is told

    The total cost (gas * gas fee + value) of executing this transaction
    exceeds the balance of the account.

for a transaction that really costs 0.0018 0G. The message points at the wallet,
which is the wrong place to look. `ChainClient.send` estimates gas first and
passes the estimate plus 25%, so the affordability check is made against the
real cost.

## Network

| | |
|---|---|
| Chain | 0G mainnet |
| Chain ID | **16602** |
| RPC | `https://evmrpc-testnet.0g.ai` |
| Explorer | `https://chainscan.0g.ai` |
| Storage explorer | `https://storagescan.0g.ai` |
| Storage indexer | `https://indexer-storage-turbo.0g.ai` |
| Compute router | `https://router-api-testnet.integratenetwork.work/v1` (API key from `pc.testnet.0g.ai`) |
| Compute model | `qwen2.5-omni` — the only chat model on the testnet router |
| Faucet | `https://faucet.0g.ai` — 0.1 0G per wallet per day |
| Native token | 0G |

## Keys

Four roles, deliberately separated (architecture doc §16):

| Role | Holds | Can do | Cannot do |
|---|---|---|---|
| Deployer / admin | `PRIVATE_KEY` | approve verifiers, set params, pause | move escrow |
| Keeper | `KEEPER_PRIVATE_KEY` | `finalizeConsensus` | choose payout amounts, withdraw |
| Adjudicator | `ADJUDICATOR_PRIVATE_KEY` | `resolveDispute` | move escrow outside the state machine |
| Verifier A / B | `VERIFIER_*_PRIVATE_KEY` | commit, reveal, claim their own reward | anything else |
| Storage | `STORAGE_PRIVATE_KEY` | pay 0G Storage fees | nothing onchain — it holds no role |

Keep the keeper balance small. It is an availability role, not a custody role:
if it goes offline, `expireTask` still pays the verifiers after the grace period
and `finalizeTask` is permissionless once the dispute window closes.

Use a multisig for `admin` beyond a testnet demo.

### Checking and rotating them

Separation is a property of the deployment, not of the config file, so it is
worth reading off the chain rather than off `.env`:

```bash
npm run roles              # audit: who holds what, and which key is where
npm run roles:separate     # mint a distinct key for any slot sharing one
npm run roles:apply        # grant/revoke onchain until it matches .env
```

`approve-verifiers` grants and never revokes, which is why a deployment that
started on one key could not move off it: granting the successor left the
predecessor holding the role too, and two keys that both still work are not
separated. `roles:apply` is the missing half, and it grants before it revokes so
the role is never briefly unheld.

**A key is not where you think it is.** `loadEnv` resolves one winner per
process — `.env.<role>` beats `.env.local`, which beats `.env` — and the winner
depends on which role that process runs as. A rotation written only to `.env` is
silently overridden by an older copy in `.env.local` or `.env.adjudicator`: the
addresses change, every service keeps signing with the key it had, and an audit
reading `.env` reports a separation that never happened. `npm run roles` reads
every dotenv file rather than only the one it loaded, and names the file each key
came from; `roles:separate` writes to all of them.

**Order for handing over admin.** The contract refuses to let an admin revoke
its own `DEFAULT_ADMIN_ROLE` — on a single-admin deployment that would be a
one-way door with no recovery at any price. Grant the successor first, then have
the *successor* revoke the predecessor. `roles:apply` refuses to revoke an admin
until another address demonstrably holds the role.

`PAUSER_ADDRESS` is optional. The constructor grants `PAUSER_ROLE` to the admin;
setting this and running `roles:apply` grants it to a second address as well, so
an incident can be stopped without reaching for the admin key.

### Which of them needs a balance

Not all of them, and the ones that do fail differently. Costs are measured
receipts at the 4 gwei both networks settle at (see the table in the README).

| Key | Needs gas | Per unit | If it runs dry |
|---|---|---|---|
| Admin | yes | 0.0188 to deploy, 0.0002 per `grantRole` | No verifier can be approved, no param set, no pause. Anything already running keeps running. |
| Keeper | **yes, continuously** | 0.00078 per task | **Not neutral.** Tasks fall past the grace period to permissionless `expireTask`, which pays revealers `conflictRateBps` — half the bounty — and lands a terminal `Expired`/`Conflict` status that forecloses the dispute window. |
| Adjudicator | only when challenged | 0.0007 per dispute | `expireDispute` opens to anyone after the window: half the challenger's bond is forfeited to the verifiers, the rest returned, and the challenge is never decided on its merits. |
| Verifier A / B | **yes, continuously** | 0.0014 per task, plus 0.00069 once to register | It cannot commit, so the task runs short of its verifier set and expires. Rewards accrue onchain and are claimable later, so nothing is lost — but the verifier earns nothing while it is empty. |
| Storage | **yes, continuously** | 0.001182 per object, up to 21 per `prepare` | `POST /v1/tasks/prepare` fails outright. This is the key that empties fastest. |
| Creator | only to post tasks from the CLI | 0.001 plus the bounty | `npm run seed` and `npm run demo` cannot post. Real users pay from their own wallets and never touch this key. |
| Compute | only under `COMPUTE_DRIVER=zerog-broker` | ~0.1 buys ~10,000 requests | The verifier fails at `acknowledgeProviderSigner` with `insufficient funds`. Unused under `zerog-router`, which bills an API key instead. |

The keeper row is the one that surprises people. It is described as an
availability role because the *system* survives without it — but the task
economics do not: a verifier that did the work is paid half. Fund it, alert on
it, and keep the balance small for the separate reason that it is a hot key.

`npm run doctor` reads every one of these balances against a floor and names
`npm run fund` when one is short.

## Step 1 — generate and fund the wallets

```bash
npm run wallets
```

Writes `.env` (gitignored) with a freshly generated key per role and prints the
addresses. Existing keys in `.env` are preserved, so re-running it is safe.

The faucet drips per address, which would mean one visit per role wallet across
several days. Instead only the **operator** needs the faucet, and it spreads gas
to the rest:

```bash
# fund the printed operator address at https://faucet.0g.ai
npm run fund
```

### What it actually costs

At the 4 gwei both 0G networks charge, a full cycle costs:

| Operation | Gas | Cost |
|---|---:|---:|
| Deploy ProofRelay | ~2.9M | ~0.0116 0G |
| `registerVerifier` × 2 | ~120k each | ~0.0010 0G |
| `setVerifierApproval` × 2 | ~50k each | ~0.0004 0G |
| `createTask` | ~210k | ~0.0008 0G |
| `commitReport` × 2 | ~150k each | ~0.0012 0G |
| `revealReport` × 2 | ~120k each | ~0.0010 0G |
| `finalizeConsensus` | ~200k | ~0.0008 0G |
| `claimReward` × 2 | ~60k each | ~0.0005 0G |
| **One task, end to end** | | **~0.017 0G** |

Bounties are on top and are yours to choose; 0.001 0G per task is enough to
demonstrate settlement.

## Step 2 — deploy

```bash
npm run deploy             # or: bash scripts/deploy.sh  (simulate only)
```

Do **not** `cp .env.example .env` here — Step 1 already wrote `.env` with your
generated role keys, and copying the template over it wipes them. The very next
command would then abort with `PRIVATE_KEY is not set`, and `STORAGE_DRIVER`
would quietly revert from `zerog` to `local`.

The script refuses to run against the wrong chain, refuses an unfunded deployer,
and runs the full contract test suite before broadcasting. It prints the
deployed address and the explorer link.

Record in `.env` exactly what the script prints:

```
CHAIN_ID=16602
OG_RPC_URL=https://evmrpc-testnet.0g.ai
PROOFRELAY_ADDRESS=0x...
PROOFRELAY_DEPLOY_BLOCK=...   # the indexer starts here instead of at genesis
```

`PROOFRELAY_DEPLOY_BLOCK` is not optional on a public chain: without it the
indexer would scan from block 0, which on either 0G network is tens of millions
the API refuses to start rather than attempt it.

### `.env.local` overrides all of this

`npm run seed` and `npm run demo` both write `.env.local`, and the services read
it **ahead of** `.env`. That is what makes a machine's deployed address and
throwaway database stick — but it also means a `.env.local` left behind by
`npm run demo` keeps every service on chain 31337 no matter what `.env` says.

If a service reports the wrong chain, check that file first:

```bash
grep -E 'CHAIN_ID|PROOFRELAY_ADDRESS' .env.local
```

Deleting it is safe; re-running `npm run seed` regenerates it. The API also
prints its resolved chain and contract on startup, and `/health` reports both.

## Step 3 — approve the verifiers

The MVP uses an admin allow-list as the sybil mitigation (PRD §15). A verifier
must self-register *and* be approved before it can commit.

```bash
PROOFRELAY_ADDRESS=0x... VERIFIER_ADDRESS=0x... \
  forge script script/Deploy.s.sol:ApproveVerifier \
  --rpc-url https://evmrpc-testnet.0g.ai --broadcast
```

Verifiers self-register on first start (`ensureRegistered`), so run each worker
once before approving, or approve first and let registration follow.

## Step 4 — switch on the real 0G services

```
STORAGE_DRIVER=zerog
STORAGE_PRIVATE_KEY=0x...                 # funded; pays 0G Storage fees
STORAGE_INDEXER_RPC=https://indexer-storage-turbo.0g.ai

COMPUTE_DRIVER=zerog-router
COMPUTE_API_KEY=sk-...                    # from https://pc.testnet.0g.ai
```

`COMPUTE_BASE_URL` and `COMPUTE_MODEL` default from `CHAIN_ID`, so on Galileo
setting the driver and the key is enough.

The router is **per network** and the two catalogs do not overlap. Galileo's
lives on a third-party host — `router-api-testnet.0g.ai` does not resolve, so do
not "correct" it — and a key issued on one network is rejected by the other.
`llama-3.3-70b-instruct`, which earlier drafts of this file named, is on neither
catalog; every request with it would have failed.

Getting a key needs a browser: connect a wallet at `pc.testnet.0g.ai`, deposit
0G into the payment layer, and create the key. It is shown once. A key is an
`sk-` inference credential and has **no** scope for `/v1/account/*`, so the
health probe reads the public `GET /v1/models` instead of the balance.

At `qwen2.5-omni`'s testnet price a three-claim task with two verifiers costs
about 0.0024 0G in inference — roughly seven full demo tasks per faucet drip.

For the direct SDK path instead of the router:

```
COMPUTE_DRIVER=zerog-broker
COMPUTE_PRIVATE_KEY=0x...                 # funds the ledger AND signs requests
COMPUTE_MODEL=qwen2.5-omni                # must exist in the on-chain registry
COMPUTE_PROVIDER_ADDRESS=0x...            # optional: pin one provider
```

There is no API key on this path and no account at `pc.0g.ai`. The SDK signs a
set of billing headers per request with `COMPUTE_PRIVATE_KEY`, and those headers
are themselves the settlement proof the provider redeems on chain. That suits a
verifier better than a shared `sk-` credential does: a verifier already is an
on-chain identity, so it can pay for its own inference out of its own ledger.

What the key must cover: gas for one `acknowledgeProviderSigner` transaction per
provider, plus a funded ledger for the inference itself. The SDK's own quickstart
deposits with `broker.ledger.depositFund(n)` and its docs quote 0.1 OG as roughly
10,000 requests. An unfunded key gets as far as the registry and then fails on
acknowledgement with `insufficient funds` — verified against Galileo.

The trade is catalogue size, not capability: the on-chain registry listed 12
models on mainnet against the router's 32 when this was written. `listService()`
is the authority — a refusal names every model the registry does offer.

Verify both before running a task:

```bash
curl -s localhost:8080/health | jq '.dependencies'
```

`storage.ok` and `compute.ok` must both be true. A false value carries the
reason in `detail`.

## Step 5 — run the services

```bash
docker compose -f infra/docker-compose.yml --env-file .env up --build
```

Brings up Postgres, the API (with indexer and keeper), both verifier workers,
and the UI on `:8081`. Only the 0G calls leave the compose network.

Without Docker:

```bash
npm run build
node apps/api/dist/server.js
VERIFIER_PROFILE=a node workers/verifier/dist/main.js
VERIFIER_PROFILE=b node workers/verifier/dist/main.js
npm run build:web && npx serve apps/web/dist
```

### Under PM2, restarting with the machine

`ecosystem.config.cjs` defines all five services. It runs compiled output, so a
build has to come first — `npm run pm2:start` does both:

```bash
npm run pm2:start          # build, start all five, save the process list
pm2 logs /proofrelay-/     # all five, interleaved
npm run pm2:reload         # rebuild and reload after a code change
```

Surviving a reboot takes two things, and only the second is per-project:

```bash
pm2 startup                # once per machine; run the sudo line it prints
pm2 save                   # after any change to which processes run
```

`pm2 save` writes `~/.pm2/dump.pm2` and `pm2 resurrect` replays it at boot. What
it replays is a *snapshot*, not this file — editing `ecosystem.config.cjs` and
skipping `pm2 save` leaves the boot behaviour on the old definition. `npm run
pm2:start` saves for you; a bare `pm2 restart` does not.

The interpreter is pinned to an absolute path (`process.execPath`, the node
running the pm2 CLI) rather than left to `PATH`. The systemd unit `pm2 startup`
generates carries whatever `PATH` existed when it was created, which under nvm
is routinely a node version that has since been replaced — the classic way a
stack that runs by hand fails to come back after a reboot.

What each process needs, and what it does when it does not have it:

| Service | Port | Depends on |
|---|---|---|
| `proofrelay-api` | `API_PORT` (8080) | Postgres, the chain RPC. Exits and is restarted with backoff until both answer. |
| `proofrelay-verifier-a` / `-b` | — | The API's dispatcher and its own `.env.verifier-<x>`. |
| `proofrelay-adjudicator` | — | `ADJUDICATOR_PRIVATE_KEY` holding `ADJUDICATOR_ROLE`. |
| `proofrelay-web` | `WEB_PORT` (3005) | Nothing at boot; serves `proofrelay-frontend/dist/public`. |

`NODE_ENV=production` is set for every one of them, and for the API it changes
behaviour rather than decorating it: below production the CORS layer accepts any
loopback origin, and at it only `CORS_ORIGINS` is accepted. A deployed UI that
is not in that list gets a page that loads and then sits on skeletons.

The UI is served by `proofrelay-frontend/server`, not by the Vite dev server. A
dev server exposes source and an HMR socket, and its port floats when the
configured one is busy — which is exactly what a tunnel or reverse proxy in
front of it cannot tolerate.

## Step 6 — verify the deployment

```bash
# contract is live and unpaused
cast call $PROOFRELAY_ADDRESS "paused()(bool)" --rpc-url $OG_RPC_URL

# verifiers are approved
cast call $PROOFRELAY_ADDRESS "getVerifier(address)" $VERIFIER_A --rpc-url $OG_RPC_URL

# keeper holds its role and nothing more
cast call $PROOFRELAY_ADDRESS "hasRole(bytes32,address)(bool)" \
  $(cast keccak "PROOFRELAY_KEEPER") $KEEPER_ADDRESS --rpc-url $OG_RPC_URL
```

Then post one task through the UI and confirm the full path: manifest hash on
0G Storage, two commitments, two reveals, a consensus transaction, and a
withdrawal.

## Definition of done (architecture doc §24)

- [ ] Contract deployed to 16602; address and chain ID documented above
- [ ] Verifier A and B registered and approved
- [ ] One task created from the UI; escrow visible on the explorer
- [ ] Manifest and both reports retrievable from 0G Storage by pointer
- [ ] At least one successful 0G Compute call recorded in a report's trace
- [ ] Two verifiers produced output; hashes verify against the chain
- [ ] A conflict is visible in the UI and did not pay out in full
- [ ] Payout and refund both exercised
- [ ] Every failure path returns a message an operator can act on
