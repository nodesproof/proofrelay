# Verifying the contract

The deployment is **verified on Sourcify** with a full match on both the
creation and the runtime bytecode:

- <https://repo.sourcify.dev/16661/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1/>
- API: `https://sourcify.dev/server/v2/contract/16661/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1`

```
match          match
creationMatch  match     ← the deploy calldata compiles to exactly this source
runtimeMatch   match     ← so does the code living at the address
compiler       0.8.24+commit.e11b9ed9
```

That was submitted programmatically and needs nothing further:

```bash
curl -X POST https://sourcify.dev/server/v2/verify/16661/0xD3101C19175b50fD47C9e0B14A2dc63485f527D1 \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{ "stdJsonInput": <contents of standard-json-input.json>,
  "compilerVersion": "0.8.24+commit.e11b9ed9",
  "contractIdentifier": "src/ProofRelay.sol:ProofRelay" }
JSON
```

## The explorer badge still needs a browser

Neither 0G explorer reads Sourcify, so the "Verified" badge there is separate
work — and it cannot be scripted:

| Explorer | Verification |
|---|---|
| `chainscan.0g.ai` | No verification feature. Its own UI strings for it read `"tip": "To be defined."`, and its `/v1/contract/…` record exposes only `verify.exactMatch`, which nothing can set from outside. |
| `explorer.0g.ai` | Has a real form at `/mainnet/verify-contract`, but the endpoints behind it (`/api/contract/verify/single-file`, `…/json`) sit on an origin-restricted host that answers **403** to anything but its own frontend, and the form is gated by Cloudflare Turnstile. A human has to submit it. |

## Everything that form asks for

Open <https://explorer.0g.ai/mainnet/verify-contract> and use these exactly.

| Field | Value |
|---|---|
| Contract address | `0xD3101C19175b50fD47C9e0B14A2dc63485f527D1` |
| Compiler type | Solidity (single file) — the source has no imports |
| Compiler version | `v0.8.24+commit.e11b9ed9` |
| Open source license | MIT |
| Optimization | **Yes**, runs **200** |
| EVM version | `shanghai` |
| Metadata bytecode hash | `none` — set in `foundry.toml` as `bytecode_hash = "none"` |
| Source file | `ProofRelay.flat.sol` in this folder (identical to `contracts/src/ProofRelay.sol`) |
| Constructor arguments | `000000000000000000000000a7d6b126d6dcbc75319f7c1b7b43524cc791e02d000000000000000000000000f4f7126769bcbf85a7f6010ba1daa54a69b4759e000000000000000000000000113fd9d5b9345ea960111b7de562fcb2622560a9` |

Those three constructor words are admin, keeper and adjudicator, recovered from
the deployment transaction rather than retyped from the runbook:

```
0xa7d6b126d6dcbc75319f7c1b7b43524cc791e02d   admin
0xf4f7126769bcbf85a7f6010ba1daa54a69b4759e   keeper
0x113fd9d5b9345ea960111b7de562fcb2622560a9   adjudicator
```

If the form offers "Standard JSON Input" instead, upload
`standard-json-input.json` and skip the optimizer and EVM-version fields — the
JSON already carries them, which removes the chance of a typo failing the match.

## Files here

| File | What it is |
|---|---|
| `standard-json-input.json` | The exact solc input, from `forge verify-contract --show-standard-json-input` |
| `ProofRelay.flat.sol` | The single source file, for a single-file submission |

Independently of any explorer, `npm run verify-abi` proves the deployed runtime
is byte-for-byte what this repository compiles to, and prints the 45 function
selectors and 17 event topics it checked against real logs.
