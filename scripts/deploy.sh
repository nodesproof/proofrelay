#!/usr/bin/env bash
# Deploy ProofRelay to whichever 0G network CHAIN_ID names — Galileo or mainnet.
#
# Simulates by default; pass --broadcast to actually send. It refuses to run
# against the wrong chain, refuses an unfunded deployer, and runs the full
# contract test suite before broadcasting — a bad deployment on a public chain
# is permanent, and the test suite takes a second.
#
# On mainnet it additionally asks for a typed confirmation before broadcasting,
# because there the deployer is spending real value and there is no faucet to
# undo a mistake. Pass --yes to skip that prompt in a non-interactive run.
set -euo pipefail

cd "$(dirname "$0")/.."

BROADCAST=""
ASSUME_YES=""
for arg in "$@"; do
  case "$arg" in
    --broadcast) BROADCAST="--broadcast" ;;
    --yes|-y) ASSUME_YES="1" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# .env.local wins over .env for the services, so it must win here too or the
# script would deploy against a different chain than the API talks to.
set -a
[[ -f .env ]] && . ./.env
[[ -f .env.local ]] && . ./.env.local
set +a

: "${OG_RPC_URL:?OG_RPC_URL is not set}"
: "${PRIVATE_KEY:?PRIVATE_KEY is not set — run npm run wallets}"
EXPECTED_CHAIN="${CHAIN_ID:-16602}"

ACTUAL_CHAIN=$(cast chain-id --rpc-url "$OG_RPC_URL")
if [[ "$ACTUAL_CHAIN" != "$EXPECTED_CHAIN" ]]; then
  echo "refusing to deploy: CHAIN_ID=$EXPECTED_CHAIN but $OG_RPC_URL is chain $ACTUAL_CHAIN" >&2
  exit 1
fi

# Every network-specific string in this script comes from here, so adding a
# network is one case arm rather than a hunt through the output.
case "$ACTUAL_CHAIN" in
  16602) NETWORK="0G Galileo testnet"; EXPLORER="https://chainscan-galileo.0g.ai"; FAUCET="https://faucet.0g.ai" ;;
  16661) NETWORK="0G mainnet";         EXPLORER="https://chainscan.0g.ai";         FAUCET="" ;;
  *)     NETWORK="chain $ACTUAL_CHAIN"; EXPLORER="";                               FAUCET="" ;;
esac

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$OG_RPC_URL")
echo "network   $NETWORK"
echo "chain     $ACTUAL_CHAIN"
echo "rpc       $OG_RPC_URL"
echo "deployer  $DEPLOYER"
echo "balance   $(cast from-wei "$BALANCE") 0G"

# ~2.9M gas at 4 gwei is ~0.0116 0G; refuse well before that runs out.
#
# Compared through awk, not bash. Bash arithmetic is 64-bit signed, and wei
# overruns it past ~9.2 0G — so `[[ "$BALANCE" -lt ... ]]` wrapped negative and
# refused to deploy from a deployer holding 10 0G, which is the opposite of what
# the guard is for.
if awk -v balance="$BALANCE" 'BEGIN { exit !(balance + 0 < 20000000000000000) }'; then
  if [[ -n "$FAUCET" ]]; then
    echo "refusing to deploy: the deployer needs at least 0.02 0G. Fund it at $FAUCET" >&2
  else
    echo "refusing to deploy: the deployer needs at least 0.02 0G. $NETWORK has no faucet — send real 0G to $DEPLOYER" >&2
  fi
  exit 1
fi

echo
echo "running the contract test suite"
forge test --root contracts

# Both 0G networks enforce a minimum tip and reject anything below it with
# "transaction gas price below minimum: gas tip cap 1" — 2 gwei on Galileo,
# 4 gwei on mainnet. Foundry's own estimator produces a 1 wei tip against these
# nodes, so read the chain's own suggestion and floor it at the lower of the two
# minimums; the chain's answer is what actually raises it on mainnet.
TIP=$(cast rpc eth_maxPriorityFeePerGas --rpc-url "$OG_RPC_URL" | tr -d '"')
TIP_DEC=$(cast to-dec "$TIP" 2>/dev/null || echo 0)
MIN_TIP=2000000000
[[ "$TIP_DEC" -lt "$MIN_TIP" ]] && TIP_DEC="$MIN_TIP"
echo
echo "priority fee $(cast from-wei "$TIP_DEC") 0G/gas"

if [[ -n "$BROADCAST" && -z "$FAUCET" && -z "$ASSUME_YES" ]]; then
  echo
  echo "About to broadcast to $NETWORK with real value at stake."
  echo "  deployer     $DEPLOYER"
  echo "  admin        ${ADMIN_ADDRESS:-$DEPLOYER}"
  echo "  keeper       ${KEEPER_ADDRESS:-$DEPLOYER}"
  echo "  adjudicator  ${ADJUDICATOR_ADDRESS:-$DEPLOYER}"
  if [[ "${ADMIN_ADDRESS:-$DEPLOYER}" == "${KEEPER_ADDRESS:-$DEPLOYER}" \
     || "${ADMIN_ADDRESS:-$DEPLOYER}" == "${ADJUDICATOR_ADDRESS:-$DEPLOYER}" ]]; then
    echo "  WARNING: these roles share a key. Deploy.s.sol calls that acceptable on"
    echo "           testnet and not for mainnet; separating them is what bounds a"
    echo "           compromised key."
  fi
  # Without a terminal there is nobody to answer, and `read` returns EOF
  # instantly — which looked exactly like a silent abort after a two-minute
  # test run. Say what happened and name the flag that skips the prompt.
  if [[ ! -t 0 ]]; then
    echo "aborted: this is a mainnet broadcast and stdin is not a terminal, so the" >&2
    echo "confirmation cannot be typed. Re-run from an interactive shell, or pass" >&2
    echo "--yes if you have already read the network and roles printed above." >&2
    exit 1
  fi
  read -r -p "Type the chain id ($ACTUAL_CHAIN) to continue: " CONFIRM
  [[ "$CONFIRM" == "$ACTUAL_CHAIN" ]] || { echo "aborted" >&2; exit 1; }
fi

DEPLOY_BLOCK_BEFORE=$(cast block-number --rpc-url "$OG_RPC_URL")

ADMIN_ADDRESS="${ADMIN_ADDRESS:-$DEPLOYER}" \
KEEPER_ADDRESS="${KEEPER_ADDRESS:-$DEPLOYER}" \
ADJUDICATOR_ADDRESS="${ADJUDICATOR_ADDRESS:-$DEPLOYER}" \
# The key is on the command line here, which /proc exposes to any process of the
# same user for as long as forge runs. Deploy.s.sol reads PRIVATE_KEY from the
# environment itself; this flag is what forge signs the broadcast with, and it
# has no environment equivalent. Deploy from a machine you trust, or use a
# keystore (`--account`) instead.
# The path is relative to the repo root, not to --root. `forge script
# script/Deploy.s.sol --root contracts` resolves the script against the current
# directory and fails with "No such file or directory" on forge 1.5 — after the
# balance check and the whole test suite have already run. `forge test --root`
# does accept the short form, which is what made this look consistent.
forge script contracts/script/Deploy.s.sol:Deploy \
  --root contracts \
  --rpc-url "$OG_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --priority-gas-price "$TIP_DEC" \
  $BROADCAST -vvv

if [[ -z "$BROADCAST" ]]; then
  echo
  echo "simulation only. Re-run with --broadcast to deploy."
  exit 0
fi

ADDRESS=$(jq -r '.transactions[0].contractAddress' \
  "contracts/broadcast/Deploy.s.sol/$ACTUAL_CHAIN/run-latest.json")
BLOCK=$(jq -r '.receipts[0].blockNumber' \
  "contracts/broadcast/Deploy.s.sol/$ACTUAL_CHAIN/run-latest.json" | xargs -I{} cast to-dec {})

cat <<EOF

deployed  $ADDRESS
block     $BLOCK
network   $NETWORK
explorer  $EXPLORER/address/$ADDRESS

Record these in .env exactly as printed. PROOFRELAY_DEPLOY_BLOCK is not optional
on a public chain: without it the indexer scans from block 0, which on either 0G
network is tens of millions of blocks, and the API refuses to start rather than
attempt it.

    CHAIN_ID=$ACTUAL_CHAIN
    OG_RPC_URL=$OG_RPC_URL
    PROOFRELAY_ADDRESS=$ADDRESS
    PROOFRELAY_DEPLOY_BLOCK=$BLOCK

The web UI needs the same two values at build time:

    VITE_CHAIN_ID=$ACTUAL_CHAIN
    VITE_PROOFRELAY_ADDRESS=$ADDRESS

Then approve the verifiers:  npm run approve-verifiers
EOF
