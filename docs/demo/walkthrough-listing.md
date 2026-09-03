# Title

ProofRelay — an onchain evidence market for AI claims, live on 0G mainnet

*Shorter, if the field is tight:*
ProofRelay: making an AI answer auditable, on 0G mainnet

# Description

A walkthrough of ProofRelay running on 0G mainnet — every screen is the live
deployment, not a mockup.

ProofRelay turns an AI answer into auditable work. You post a claim and a
bounty; independent verifiers fetch the same snapshotted sources, build a
claim–evidence graph, and commit their answers as hashes before any of them can
see another's. 0G Storage holds the artifacts, 0G Compute runs the verification,
and a contract on 0G Chain settles it — paying on agreement and withholding on
conflict.

It does not claim to know the truth. It makes the basis of an answer
inspectable: which bytes were read, when they were read, which model read them,
what each verifier concluded, and exactly where they disagreed.

What the tour covers:

- The verifier directory — two independent operators, their agreement rate,
  uptime, and the model each one signed its last report with
- A settled task end to end — bounty escrowed, 2 of 2 verifiers agreeing, the
  dispute window closed with no challenge opened
- Evidence, claim by claim — the quoted span, its sha256, and the 0G Storage
  pointer the report cited
- Commit and reveal — each verifier's report hash, and the model behind it
- What the contract holds — manifest pointer, result hash, the block it landed
  in, and the payout allocated to each verifier
- The artifact store — every source snapshot, manifest, report and consensus
  record, content-addressed
- Verifier registration — what an operator signs to join, and why approval is
  still required after it
- The protocol docs, including the settlement rules
- The contract on the 0G block explorer

Live deployment:

- App — https://proofrelay.nectiq.xyz
- API — https://api-proofrelay.nectiq.xyz/health
- Contract — 0xD3101C19175b50fD47C9e0B14A2dc63485f527D1 (0G mainnet, 16661)

Built on 0G Chain, 0G Storage and 0G Compute. Solidity with Foundry, TypeScript
end to end, and a contract whose deployed runtime is byte-for-byte the code the
repository compiles to.

# Chapters

Derived from sampling the recording every 20 seconds, so treat them as close
rather than exact.

0:00  Verifier network — the independent operators
0:25  Overview — the ledger, wallet connected
0:50  A settled task — evidence, commit and reveal, consensus
1:15  Verifier metadata, read live from the contract
2:05  Artifacts — the content-addressed store
2:30  Activity log — the chain event stream
2:55  Protocol docs — what it is
3:20  Protocol docs — settlement rules
3:40  Back to the overview
3:58  Verifier registration
