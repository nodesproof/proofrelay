// Evidence Ledger design: protocol documentation reads like a field guide—precise, navigable, and connected to real proof states.
//
// Every number on this page is the number the deployed contract actually runs.
// The parameter tables were read back from `params()` on the live deployment and
// the field limits from `PrepareTaskRequest`, because a reference that drifts
// from the code it describes is worse than no reference: it is a confident lie.
// The deployment section reads `/health` at request time rather than hardcoding,
// so it can never describe a contract this UI is not talking to. The report
// example is a real mainnet report with its hashes elided, not an invented one.
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { ArrowUpRight, BookOpen, Check, ChevronRight, Code2, Coins, Database, FileCheck2, Fingerprint, Gavel, GitBranch, Info, Layers3, Network, Server, ShieldCheck, Sparkles, Terminal, Users, Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useHealth } from "@/hooks/useProofRelay";
import { ACTIVE_CHAIN_ID, EXPLORER_URL, NETWORK_NAME } from "@/lib/wagmi";

const sections = [
  "What it is",
  "How it works",
  "Who does what",
  "Create a task",
  "Run a verifier",
  "Built on 0G",
  "Artifacts and hashes",
  "Settlement rules",
  "Live deployment",
];

/** `TaskStatus` in declaration order, minus `None` — that is the zero value for
 *  a task the contract has never seen, not a state anything reaches. */
const taskStates: [string, string][] = [
  ["Open", "funded, no commit yet"],
  ["Committing", "hashes arriving"],
  ["Revealing", "reports opening"],
  ["Consensus", "verdict agreed"],
  ["Disputed", "challenge bonded"],
  ["Adjudication", "under review"],
  ["Finalized", "paid out"],
  ["Expired", "deadline passed"],
  ["Cancelled", "withdrawn by creator"],
];

const reportShape = `{
  "kind": "verifier-report",
  "schemaVersion": "1.0.0",
  "taskId": "0xff4d4c2f…b98e8a3",
  "manifestHash": "0x39d4e6eb…cd6096b",
  "verifier": {
    "address": "0xE51DB467…f117Cca",
    "verifierId": "verifier-b",
    "modelId": "zerog-router/deepseek-v4-flash",
    "pipelineVersion": "0.1.0"
  },
  "claims": [{
    "claimId": "claim-001",
    "verdict": "SUPPORTED",
    "confidence": 1,
    "reasoningSummary": "The span explicitly states…",
    "sources": [{
      "contentHash": "sha256:e08839ab…06f6dfe",
      "quotedSpan": "0G Storage can be used completely standalone…"
    }]
  }],
  "summary": { "supported": 2, "contradicted": 0, "insufficient": 0, "meanConfidence": 1 },
  "compute": [{
    "operation": "evidence-scoring",
    "provider": "zerog-router:0xd9966e13…8C471C",
    "modelId": "zerog-router/deepseek-v4-flash",
    "verified": true,
    "attestation": {
      "verifiability": "TeeTLS",
      "teeType": "TDX",
      "teeVerifier": "dstack",
      "source": "router-directory"
    },
    "inputHash": "0xca80cc1b…b0763cc0",
    "outputHash": "0x422e1f22…f373e73877"
  }]
}`;

const verifierEnv = `# .env — one verifier, and nothing else
CHAIN_ID=16661
OG_RPC_URL=https://evmrpc.0g.ai
PROOFRELAY_ADDRESS=0xD3101C19175b50fD47C9e0B14A2dc63485f527D1

# Your onchain identity: it registers, commits, reveals and
# collects, and writes reports to 0G Storage.
VERIFIER_PROFILE=a                # a = depth 2 / 0.55, b = depth 3 / 0.50
VERIFIER_A_PRIVATE_KEY=0x…        # never commit this
STORAGE_DRIVER=zerog

# A key from https://pc.0g.ai. Without it the worker scores
# evidence with the local deterministic engine and says so in
# every report.
COMPUTE_DRIVER=zerog-router
COMPUTE_API_KEY=sk-…
COMPUTE_VERIFY_TEE=true

# Rewards are pull-based, so collecting costs gas. Nothing is
# claimed until the unclaimed total clears this floor (0.002 0G).
VERIFIER_MIN_COLLECT_WEI=2000000000000000`;

export default function ProtocolDocs() {
  const [, navigate] = useLocation();
  const [active, setActive] = useState(sections[0]);
  const health = useHealth();
  const explorer = health.data?.explorer || EXPLORER_URL;
  const contract = health.data?.contract ?? null;

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    toast.success(`${label} copied`);
  };

  return <DashboardLayout eyebrow="Builder reference" title="Protocol docs">
    <div className="docs-layout">
      <aside className="docs-nav">
        <div className="docs-nav-heading"><BookOpen size={16} /><span>ON THIS PAGE</span></div>
        {sections.map((section, index) => <button key={section} className={active === section ? "active" : ""} onClick={() => setActive(section)}><span>0{index + 1}</span>{section}<ChevronRight size={14} /></button>)}
        <div className="docs-tip"><Sparkles size={15} /><strong>Built for 0G</strong><span>Storage for artifacts, Compute for verification, Chain for settlement.</span></div>
      </aside>

      <article className="docs-article">
        <div className="docs-kicker"><span className="overline-mark" />PROOFRELAY / V1 ON {NETWORK_NAME.toUpperCase()}</div>
        <h2>{active}</h2>

        {active === "What it is" && <>
          <p className="docs-lead">ProofRelay is an onchain evidence market for AI claims. It turns a question into a funded task, has independent verifiers answer it from the same snapshotted sources without seeing each other's work, and settles the result on 0G Chain.</p>
          <p className="docs-body">An AI answer usually arrives with no way to check it. You cannot see which pages it read, when it read them, which model produced the reading, or whether anyone else looking at the same pages would reach the same conclusion. ProofRelay does not try to fix the model. It makes the basis of an answer inspectable and puts money behind agreement.</p>
          <div className="docs-callout"><ShieldCheck size={18} /><div><strong>Evidence before confidence</strong><p>ProofRelay does not claim to know the truth. It records which bytes were read, when they were read, which model read them, what each verifier concluded, and exactly where they disagreed — then lets a human decide what that is worth.</p></div></div>
          <h3>What the protocol actually guarantees</h3>
          <div className="docs-card-grid">
            <div><Database size={17} /><strong>The same bytes</strong><span>Sources are fetched once, hashed, and pinned to 0G Storage. Every verifier reads that snapshot, not the live page.</span></div>
            <div><Fingerprint size={17} /><strong>Blind reports</strong><span>A verifier publishes a hash before it can see any other report, so agreement cannot be manufactured by copying.</span></div>
            <div><Network size={17} /><strong>Settled in public</strong><span>Escrow, verdict, dispute and payout are contract state. Anyone can replay how a result was reached.</span></div>
          </div>
          <div className="docs-note"><Info size={16} /><div><strong>What it is not</strong><p>Agreement between verifiers is evidence that two independently configured pipelines read the same snapshot and reached the same verdict. It is not a proof of fact, and the protocol never presents it as one.</p></div></div>
        </>}

        {active === "How it works" && <>
          <p className="docs-lead">A task moves through explicit states, and each transition is a transaction anyone can read back. The shape is commit–reveal: answers are locked in as hashes first, then opened.</p>
          <div className="docs-lifecycle">
            {([
              ["01", "Manifest", "Sources are fetched, hashed and pinned to 0G Storage. The manifest hash and pointer go onchain with the bounty.", Database, "lime"],
              ["02", "Commit", "Each verifier publishes keccak256(taskId, verifier, reportHash, salt). The verdict stays hidden; only the commitment is public.", GitBranch, "sky"],
              ["03", "Reveal", "The verifier publishes the report pointer and salt. The contract recomputes the commitment and rejects anything that does not match.", FileCheck2, "lime"],
              ["04", "Settle", "Matching verdicts finalize and allocate the bounty. A disagreement, or a bonded challenge, opens the dispute path instead.", ShieldCheck, "coral"],
            ] as [string, string, string, React.ComponentType<{ size?: number }>, string][]).map(([number, title, text, Icon, tone]) =>
              <div className="docs-lifecycle-row" key={number}><span className={`docs-number docs-${tone}`}>{number}</span><Icon size={18} /><div><strong>{title}</strong><p>{text}</p></div></div>)}
          </div>
          <h3>Why commit before reveal</h3>
          <p className="docs-body">If verifiers could see each other's answers, the cheapest winning strategy would be to copy the first one. Consensus would then measure who published first, not whether the evidence supports the claim. Committing a hash first makes copying impossible, and the salt keeps the commitment from being brute-forced back into a verdict — there are only three of them.</p>
          <div className="code-block">
            <div className="code-head"><span><Code2 size={13} />commitment</span><button onClick={() => copy("keccak256(abi.encode(taskId, verifier, reportHash, salt))", "Commitment formula")}>Copy</button></div>
            <pre>{`commitment = keccak256(abi.encode(\n  taskId,      // bytes32\n  verifier,    // address — binds the commit to one sender\n  reportHash,  // bytes32 — hash of the canonical report bytes\n  salt         // bytes32 — 32 random bytes, per report\n))`}</pre>
          </div>
          <h3>Task states</h3>
          <div className="docs-states">{taskStates.map(([name, note]) => <span className="docs-state" key={name}>{name}<em>{note}</em></span>)}</div>
        </>}

        {active === "Who does what" && <>
          <p className="docs-lead">Five parties touch a task. Only two of them need to exist for a task to settle: a creator to fund it and verifiers to answer it.</p>
          <div className="docs-card-grid">
            <div><Coins size={17} /><strong>Creator</strong><span>Funds the task, sets the windows, and may cancel before any reveal or challenge a result they believe is wrong.</span></div>
            <div><Server size={17} /><strong>Verifier</strong><span>A worker that fetches the snapshot, scores the claims, commits, reveals, and later collects its reward.</span></div>
            <div><Users size={17} /><strong>Keeper</strong><span>Calls finalize once reveals close. Permissionless after a grace period, so a stalled keeper cannot trap a bounty.</span></div>
          </div>
          <div className="docs-card-grid">
            <div><Gavel size={17} /><strong>Adjudicator</strong><span>Rules on a bonded challenge and publishes the reasoning as an artifact. Never a beneficiary of the outcome.</span></div>
            <div><ShieldCheck size={17} /><strong>Challenger</strong><span>Anyone who posts the bond and evidence during the dispute window. Cannot be the adjudicator on their own case.</span></div>
            <div><Layers3 size={17} /><strong>Admin</strong><span>Approves verifiers, pauses the contract, grants roles. Cannot revoke its own admin role and lock the contract out.</span></div>
          </div>
          <h3>Who may call what</h3>
          <div className="docs-table-wrap"><table className="docs-table">
            <thead><tr><th>Function</th><th>Caller</th><th>Gate</th></tr></thead>
            <tbody>
              <tr><td>createTask</td><td>anyone</td><td>bounty ≥ minimum, contract not paused</td></tr>
              <tr><td>commitReport</td><td>verifier</td><td>registered, approved and active</td></tr>
              <tr><td>revealReport</td><td>verifier</td><td>commitment must recompute exactly</td></tr>
              <tr><td>finalizeTask</td><td>keeper, then anyone</td><td>reveals closed</td></tr>
              <tr><td>openChallenge</td><td>anyone</td><td>bond paid, dispute window open</td></tr>
              <tr><td>resolveDispute</td><td>adjudicator</td><td>not the challenger on this task</td></tr>
              <tr><td>expireTask</td><td>anyone</td><td>past reveal deadline plus grace</td></tr>
              <tr><td>claimReward / withdraw</td><td>beneficiary</td><td>pull-based, always self-service</td></tr>
            </tbody>
          </table></div>
          <div className="docs-note"><Info size={16} /><div><strong>The verifier set is permissioned today</strong><p>Registration is open, but a verifier cannot commit until an admin approves it. That is a deliberate choice for this deployment: with slashing set to zero there is currently no economic penalty for a bad report, so entry is gated instead.</p></div></div>
        </>}

        {active === "Create a task" && <>
          <p className="docs-lead">You need a wallet on {NETWORK_NAME} with enough balance for the bounty and gas. Everything else happens in the browser.</p>
          <div className="docs-steps">
            <div className="docs-step"><div><strong>Connect a wallet</strong><p>The header button connects and switches you to {NETWORK_NAME}, chain ID {ACTIVE_CHAIN_ID}, if you are on another network — adding it to MetaMask first if the wallet has never seen it.</p></div></div>
            <div className="docs-step"><div><strong>Describe what to check</strong><p>Give a question, the claims to test, and the sources to test them against. A source can be a URL or text you paste directly.</p></div></div>
            <div className="docs-step"><div><strong>The API snapshots the sources</strong><p>Each source is fetched once, stripped of active markup, hashed, and pinned to 0G Storage. You get back a manifest hash and pointer — the exact bytes every verifier will read.</p></div></div>
            <div className="docs-step"><div><strong>Sign the transaction</strong><p>Your wallet sends <code>createTask</code> with the bounty as value. Before it asks you to sign, the browser re-checks that the prepared manifest matches what you typed and refuses if it does not.</p></div></div>
            <div className="docs-step"><div><strong>Watch it settle</strong><p>Verifiers commit, then reveal. The task page shows each report, its evidence graph, and where the verifiers agreed.</p></div></div>
            <div className="docs-step"><div><strong>Challenge it, if you disagree</strong><p>During the dispute window anyone may post the bond with counter-evidence. An upheld challenge returns the bond plus a reward and blocks the payout.</p></div></div>
          </div>
          <h3>What the form accepts</h3>
          <div className="docs-table-wrap"><table className="docs-table">
            <thead><tr><th>Field</th><th>Range</th><th>Default</th></tr></thead>
            <tbody>
              <tr><td>Verifiers</td><td>2 – 16</td><td className="num">2</td></tr>
              <tr><td>Claims</td><td>1 – 50 per task</td><td className="num">—</td></tr>
              <tr><td>Sources</td><td>up to 20, URL or pasted text</td><td className="num">—</td></tr>
              <tr><td>Commit window</td><td>30 s – 30 days</td><td className="num">15 min</td></tr>
              <tr><td>Reveal window</td><td>30 s – 30 days</td><td className="num">15 min</td></tr>
              <tr><td>Dispute window</td><td>30 s – 30 days</td><td className="num">15 min</td></tr>
              <tr><td>Bounty</td><td>at least 0.0001 0G</td><td className="num">—</td></tr>
            </tbody>
          </table></div>
          <div className="docs-note"><Info size={16} /><div><strong>Windows are per task, not global</strong><p>You choose them at creation and they are pinned into contract state. Short windows settle fast but give a slow verifier no room; the defaults are a reasonable starting point.</p></div></div>
        </>}

        {active === "Run a verifier" && <>
          <p className="docs-lead">A verifier is a long-running worker. It watches the chain for open tasks, reads the snapshot from 0G Storage, scores the claims, and publishes a report on its own key.</p>
          <div className="docs-steps">
            <div className="docs-step"><div><strong>Fund a wallet</strong><p>A dedicated key with a small 0G balance. Measured on mainnet at 4 gwei: registering costs about 0.0007 0G once, and each task about 0.0025 0G — 0.0006 to commit, 0.0007 to reveal and 0.0012 to write the report to 0G Storage on the same key.</p></div></div>
            <div className="docs-step"><div><strong>Register onchain</strong><p><code>registerVerifier</code> records your metadata hash and pointer. Registration alone does not let you commit.</p></div></div>
            <div className="docs-step"><div><strong>Get approved</strong><p>An admin calls <code>setVerifierApproval</code>. Until then <code>commitReport</code> reverts with <code>VerifierNotActive</code>.</p></div></div>
            <div className="docs-step"><div><strong>Write the env file</strong><p>Copy <code>.env.verifier-standalone.example</code>. It is the whole configuration — no database, no API, no operator keys — and two verifiers never share a key, a profile, or a compute quota.</p></div></div>
            <div className="docs-step"><div><strong>Start the worker</strong><p>It polls, commits, reveals, and batches reward collection on its own. It talks to the contract, 0G Storage and 0G Compute directly — never to this site or its API — so nothing else is required to keep it running.</p></div></div>
          </div>
          <div className="code-block">
            <div className="code-head"><span><Code2 size={13} />.env</span><button onClick={() => copy(verifierEnv, "Verifier config")}>Copy</button></div>
            <pre>{verifierEnv}</pre>
          </div>
          <div className="code-block">
            <div className="code-head"><span><Terminal size={13} />run</span><button onClick={() => copy("cp .env.verifier-standalone.example .env\ndocker compose -f infra/docker-compose.verifier.yml up --build", "Run command")}>Copy</button></div>
            <pre>{`cp .env.verifier-standalone.example .env   # then fill in the two keys\ndocker compose -f infra/docker-compose.verifier.yml up --build`}</pre>
          </div>
          <h3>Two verifiers, deliberately unalike</h3>
          <p className="docs-body">The reference deployment runs profile A at evidence depth 2 and support threshold 0.55, and profile B at depth 3 and 0.50. That is the point: agreement has to mean two differently configured pipelines reached the same verdict, not that one pipeline ran twice.</p>
          <div className="docs-note"><Info size={16} /><div><strong>Rewards are pulled, not pushed</strong><p>The contract allocates your share but never sends it. The worker calls <code>claimReward</code> then <code>withdraw</code> — and holds until the unclaimed total clears a floor, because on small bounties the gas to collect can exceed the reward itself.</p></div></div>
        </>}

        {active === "Built on 0G" && <>
          <p className="docs-lead">ProofRelay uses 0G as three separate surfaces. Large artifacts live in Storage, inference runs on Compute, and only the compact settlement state touches the Chain.</p>
          <div className="og-integration-grid">
            <div><Database size={20} /><span>0G Storage</span><strong>Artifacts</strong><small>Manifests, source snapshots, reports and adjudications, addressed by content hash.</small></div>
            <div><Zap size={20} /><span>0G Compute</span><strong>Verification</strong><small>Claim extraction and evidence scoring on a TEE-attested provider, through the 0G Compute router.</small></div>
            <div><Layers3 size={20} /><span>0G Chain</span><strong>Settlement</strong><small>Escrow, commitments, reveals, disputes and payouts as public contract state.</small></div>
          </div>
          <h3>What a compute call records</h3>
          <p className="docs-body">Every report carries the trace of the inference that produced it: which provider served the request, which model, whether the router affirmed the TEE attestation for that response, and what kind of enclave the provider runs. The reference deployment scores evidence with <code>deepseek-v4-flash</code> on a provider attested as TeeTLS over Intel TDX, verified by dstack — a model chosen because every mainnet provider serving it accepts a seed, which this pipeline sends on every completion and refuses to run without.</p>
          <div className="docs-table-wrap"><table className="docs-table">
            <thead><tr><th>Trace field</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td>provider</td><td>The address that actually served the completion, as reported by the router.</td></tr>
              <tr><td>modelId</td><td>The model that ran. Reads <code>zerog-router(fallback:local)</code> if the router was unreachable.</td></tr>
              <tr><td>verified</td><td>Whether the router affirmed the TEE attestation for <em>this</em> response.</td></tr>
              <tr><td>attestation</td><td>What kind of enclave the provider runs, from the router's directory.</td></tr>
              <tr><td>inputHash / outputHash</td><td>Hashes of what went in and came out, so a report can be replayed.</td></tr>
            </tbody>
          </table></div>
          <div className="docs-note"><Info size={16} /><div><strong>Attribution is not verification</strong><p><code>verified</code> is a per-response claim; <code>attestation</code> is a claim about the provider, read from the router's directory and possibly at a different moment. The two are recorded separately on purpose, and a reader should weigh them differently.</p></div></div>
          <div className="docs-note"><Info size={16} /><div><strong>Compute is optional</strong><p>A verifier with no compute key falls back to a local deterministic engine. It still produces a valid report — the trace simply names the fallback instead of a provider, so nothing is ever passed off as model output that a model did not produce.</p></div></div>
        </>}

        {active === "Artifacts and hashes" && <>
          <p className="docs-lead">Everything of size lives off-chain as a canonical JSON artifact. The chain stores its hash and a pointer, so a copy that has been altered stops matching and is rejected.</p>
          <div className="docs-table-wrap"><table className="docs-table">
            <thead><tr><th>Artifact</th><th>Written by</th><th>Anchored as</th></tr></thead>
            <tbody>
              <tr><td>Task manifest</td><td>API, at prepare time</td><td>manifestHash + pointer, in createTask</td></tr>
              <tr><td>Source snapshot</td><td>API fetcher</td><td>contentHash, inside the manifest</td></tr>
              <tr><td>Verification report</td><td>Verifier worker</td><td>reportHash, in revealReport</td></tr>
              <tr><td>Evidence graph</td><td>Verifier worker</td><td>embedded in the report</td></tr>
              <tr><td>Adjudication</td><td>Adjudicator</td><td>adjudicationHash, in resolveDispute</td></tr>
            </tbody>
          </table></div>
          <div className="code-block">
            <div className="code-head"><span><Code2 size={13} />report.json</span><button onClick={() => copy(reportShape, "Report shape")}>Copy</button></div>
            <pre>{reportShape}</pre>
          </div>
          <h3>How the hash is taken</h3>
          <p className="docs-body">The content hash is computed over canonical bytes — keys ordered, formatting fixed — not over whatever a UI happened to render. Two systems that hold the same artifact therefore compute the same hash, and the API refuses to serve a body whose hash does not match what the chain recorded.</p>
          <div className="docs-note"><Info size={16} /><div><strong>A storage pointer is not a content hash</strong><p>0G Storage addresses an upload by its merkle root, which is a different value from the content hash the contract commits to. Both are kept: the pointer says where to fetch, the hash says whether what came back is the right bytes.</p></div></div>
        </>}

        {active === "Settlement rules" && <>
          <p className="docs-lead">Settlement is deliberately conservative. Full payment requires agreement; disagreement pays less and keeps the record of the conflict.</p>
          <div className="rule-list">
            <div><span className="rule-icon rule-good"><Check size={15} /></span><div><strong>Consensus</strong><p>Every revealed report carries the same verdict. The bounty is allocated in full and split evenly across the verifiers that revealed.</p></div></div>
            <div><span className="rule-icon rule-warn"><ShieldCheck size={15} /></span><div><strong>Conflict</strong><p>Verifiers disagree. Half the bounty is paid out and the rest returns to the creator — the work was done, but it did not produce an answer.</p></div></div>
            <div><span className="rule-icon rule-warn"><Gavel size={15} /></span><div><strong>Dispute</strong><p>A bonded challenge freezes the payout. If it is upheld the outcome becomes a conflict and the challenger takes the bond back plus a reward; if it is rejected the bond is forfeited.</p></div></div>
            <div><span className="rule-icon rule-plain"><Code2 size={15} /></span><div><strong>Expiry</strong><p>If reveals never close, anyone may expire the task after the grace period and the creator can reclaim the escrow. A stalled keeper cannot strand a bounty.</p></div></div>
          </div>
          <h3>Live parameters</h3>
          <div className="docs-table-wrap"><table className="docs-table">
            <thead><tr><th>Parameter</th><th>Value</th><th>What it controls</th></tr></thead>
            <tbody>
              <tr><td>conflictRateBps</td><td className="num">50%</td><td>Share of the bounty paid when verifiers disagree.</td></tr>
              <tr><td>challengeBondBps</td><td className="num">10%</td><td>Bond a challenger must post, as a share of the bounty. Exact amount required.</td></tr>
              <tr><td>challengerRewardBps</td><td className="num">10%</td><td>Paid to a challenger whose challenge is upheld, on top of the returned bond.</td></tr>
              <tr><td>adjudicatorSplitBps</td><td className="num">50%</td><td>Share of a forfeited bond that goes to the defended verifiers; the rest returns to the creator.</td></tr>
              <tr><td>minBounty</td><td className="num">0.0001 0G</td><td>Floor on what a task may be funded with.</td></tr>
              <tr><td>verifierSlashBps</td><td className="num">0</td><td>Reserved. Slashing exists as a parameter only and is zero on this deployment.</td></tr>
              <tr><td>minVerifierStake</td><td className="num">0</td><td>Reserved alongside slashing. No stake is required to operate today.</td></tr>
              <tr><td>keeperGracePeriod</td><td className="num">3 days</td><td>After the reveal deadline plus this, anyone may expire the task.</td></tr>
              <tr><td>adjudicationWindow</td><td className="num">7 days</td><td>How long an adjudicator has before the dispute can be expired by anyone.</td></tr>
              <tr><td>claimGracePeriod</td><td className="num">7 days</td><td>Reserved. Set on this deployment, but no function in this version reads it.</td></tr>
            </tbody>
          </table></div>
          <div className="docs-note"><Info size={16} /><div><strong>Nothing is ever pushed to you</strong><p>Settlement allocates; it does not transfer. A beneficiary calls <code>claimReward</code> to move an allocation into their withdrawable balance, then <code>withdraw</code> to take it. A recipient that reverts on receipt can therefore never block anyone else's payout.</p></div></div>
          <div className="docs-note"><Info size={16} /><div><strong>Slashing is not live</strong><p>Both <code>verifierSlashBps</code> and <code>minVerifierStake</code> read zero on this deployment, so a verifier that files a bad report loses its share of that bounty and nothing more. This is why the verifier set is approval-gated.</p></div></div>
        </>}

        {active === "Live deployment" && <>
          <p className="docs-lead">Read from <code>/health</code> when this page loaded, so it always describes the contract this interface is actually talking to.</p>
          <div className="docs-facts">
            <div className="docs-fact"><span>Contract</span><strong>{contract ? <a href={`${explorer}/address/${contract}`} target="_blank" rel="noopener noreferrer">{contract}</a> : health.error ? "unavailable" : "loading…"}</strong></div>
            <div className="docs-fact"><span>Network</span><strong>{health.data ? `${health.data.network} · chain ${health.data.chainId}` : "—"}</strong></div>
            <div className="docs-fact"><span>Storage driver (API)</span><strong>{health.data?.drivers.storage ?? "—"}</strong></div>
            <div className="docs-fact"><span>Compute driver (API)</span><strong>{health.data?.drivers.compute ?? "—"}</strong></div>
            <div className="docs-fact"><span>API version</span><strong>{health.data?.version ?? "—"}</strong></div>
            <div className="docs-fact"><span>Contract state</span><strong>{health.data ? health.data.paused ? "paused" : "accepting tasks" : "—"}</strong></div>
          </div>
          <div className="docs-note"><Info size={16} /><div><strong>These are the API's drivers, not the verifiers'</strong><p>The API snapshots sources and serves artifacts; it does not score evidence. Each verifier configures its own compute driver independently, so this row will read <code>local</code> even while every report is being produced on 0G Compute. The trace inside a report is the only place that says what actually ran.</p></div></div>
          <div className="docs-note"><Info size={16} /><div><strong>{ACTIVE_CHAIN_ID === 16661 ? "Real value, audited only from the inside" : "Audited only from the inside"}</strong><p>This deployment runs on {NETWORK_NAME}{ACTIVE_CHAIN_ID === 16661 ? " with real value" : ""}. The source is verified on ChainScan and Sourcify, so everything this page states can be checked against the bytecode; the contracts have been through an internal audit and a full regression suite, but not an external one. Size bounties accordingly.</p></div></div>
        </>}

        <div className="docs-bottom-cta">
          <div><strong>Ready to inspect the queue?</strong><span>Jump back into real verification work.</span></div>
          <button className="primary-button" onClick={() => navigate("/verification-tasks")}>Open task queue <ArrowUpRight size={15} /></button>
        </div>
      </article>
    </div>
  </DashboardLayout>;
}
