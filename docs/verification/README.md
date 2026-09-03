# Verifying the contract

The deployment is verified in both places that matter, and both were done from
the command line.

## 0G ChainScan — the explorer badge

`exactMatch: true`, with the source and ABI published:
<https://chainscan.0g.ai/address/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1>

ChainScan exposes an Etherscan-compatible API under `/open` — documented at
<https://chainscan.0g.ai/open/doc> — so `forge` can talk to it directly. The
only thing that is not obvious is `--verifier custom`: with `--verifier
etherscan` foundry refuses with *"No known Etherscan API URL for chain 16661"*
before it ever reads `--verifier-url`.

```bash
forge verify-contract --root contracts \
  --chain-id 16661 \
  --verifier custom \
  --verifier-url https://chainscan.0g.ai/open/api \
  --verifier-api-key none \
  --compiler-version 0.8.24+commit.e11b9ed9 \
  --num-of-optimizations 200 \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
      $ADMIN_ADDRESS $KEEPER_ADDRESS $ADJUDICATOR_ADDRESS) \
  0xD3101C19175b50fD47C9e0B14A2dc63485f527D1 src/ProofRelay.sol:ProofRelay
```

No API key is needed — `none` is accepted. Poll the result with the GUID it
returns:

```bash
curl "https://chainscan.0g.ai/open/api?module=contract&action=checkverifystatus&guid=<GUID>"
# {"status":"1","message":"OK","result":"Pass - Verified"}
```

What the explorer now reports back:

```
ContractName       ProofRelay
CompilerVersion    0.8.24+commit.e11b9ed9
OptimizationUsed   1          Runs  200
EVMVersion         shanghai
SourceCode         53,099 chars       ABI  present
```

## Sourcify — the chain-independent record

A full match on both bytecodes, which is a stronger statement than an explorer
badge because it is reproducible by anyone with the source:

<https://repo.sourcify.dev/16661/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1/>

```
match          match
creationMatch  match     ← the deploy calldata compiles to exactly this source
runtimeMatch   match     ← so does the code living at the address
```

```bash
curl -X POST https://sourcify.dev/server/v2/verify/16661/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1 \
  -H 'content-type: application/json' \
  -d '{"stdJsonInput": <standard-json-input.json>,
       "compilerVersion": "0.8.24+commit.e11b9ed9",
       "contractIdentifier": "src/ProofRelay.sol:ProofRelay"}'
# then GET https://sourcify.dev/server/v2/verify/<verificationId>
```

## The inputs, if either has to be redone by hand

| Field | Value |
|---|---|
| Address | `0xD3101C19175b50fD47C9e0B14A2dc63485f527D1` |
| Compiler | `v0.8.24+commit.e11b9ed9` |
| Optimization | Yes, 200 runs |
| EVM version | `shanghai` |
| Metadata bytecode hash | `none` (`bytecode_hash = "none"` in `foundry.toml`) |
| Sources | one file, no imports — `ProofRelay.flat.sol` here |
| Constructor args | `000000000000000000000000a7d6b126d6dcbc75319f7c1b7b43524cc791e02d000000000000000000000000f4f7126769bcbf85a7f6010ba1daa54a69b4759e000000000000000000000000113fd9d5b9345ea960111b7de562fcb2622560a9` |

Those three words are admin, keeper and adjudicator, recovered from the
deployment transaction's calldata rather than retyped from the runbook.

`explorer.0g.ai/mainnet/verify-contract` also has a form, but it cannot be
scripted: the endpoints behind it answer 403 to anything but their own frontend
and the form is gated by Cloudflare Turnstile. It is unnecessary now.

## Files here

| File | What it is |
|---|---|
| `standard-json-input.json` | The exact solc input, from `forge verify-contract --show-standard-json-input` |
| `ProofRelay.flat.sol` | The single source file |

Independently of any explorer, `npm run verify-abi` proves the deployed runtime
is byte-for-byte what this repository compiles to.
