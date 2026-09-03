// Evidence Ledger design: the task record is the screen where disagreement has to be legible.
// Every claim carries each verifier's own verdict, confidence, reasoning and quoted span with the
// hash of the snapshot it was quoted from — a split is rendered as a conflict, never averaged into
// one number. Nothing here is a literal: the header, the claims, the consensus block, the dispute
// block, the timeline and the raw-artifact drawer all read GET /v1/tasks/:taskId, GET /v1/reports/:hash
// and the chain, and the three write paths (challenge, claim reward, withdraw) are real transactions.
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Copy, Database, ExternalLink, FileCheck2, FileJson2, FileText, Gavel, GitBranch, Hash, ShieldAlert, ShieldCheck, WalletCards } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { EmptyState, EmptyStateBlock, ErrorState, EvidenceRowsSkeleton, SignalRowsSkeleton, Skeleton, StatCardsSkeleton, TimelineSkeleton, errorCode, errorMessage, writeErrorMessage } from "@/components/states";
import { useAllocation, useClaimReward, useHealth, useOpenChallenge, usePaused, usePendingWithdrawal, useProtocolParams, useReport, useTask, useWallet, useWithdraw, queryKeys } from "@/hooks/useProofRelay";
import { isApiError, syncTask } from "@/lib/api";
import type { Bytes32, ClaimView, EvidenceSpan, ReportView, Tone, Verdict } from "@/lib/types";
import { dayBucket, formatToken, relativeTime, sameAddress, shortAddress, shortHash, toChecksumAddress, utcClock } from "@/lib/format";
import { EXPLORER_URL } from "@/lib/wagmi";

/* ── maps the design already implies ─────────────────────────────────────── */

/** FRONTEND_DATA_CONTRACT §6.2 — CONTRADICTED is coral; it must never render lime. */
const VERDICT_TONE: Record<Verdict, Tone> = { SUPPORTED: "lime", CONTRADICTED: "coral", INSUFFICIENT_EVIDENCE: "sky" };
const VERDICT_LABEL: Record<Verdict, string> = { SUPPORTED: "SUPPORTED", CONTRADICTED: "CONTRADICTED", INSUFFICIENT_EVIDENCE: "INSUFFICIENT" };
const CLAIM_TONE: Record<ClaimView["displayVerdict"], Tone> = { SUPPORTED: "lime", CONTRADICTED: "coral", INSUFFICIENT: "sky", PENDING: "ink" };

/** The API's own event labels (task-service EVENT_LABELS) → the timeline's node tone and category. */
const TIMELINE_STYLE: Record<string, { tone: string; type: string; icon: typeof Activity }> = {
  "Task created": { tone: "ink", type: "Task", icon: FileCheck2 },
  "Manifest anchored": { tone: "sky", type: "Storage", icon: Database },
  "Report committed": { tone: "ink", type: "Verification", icon: GitBranch },
  "Report revealed": { tone: "ink", type: "Verification", icon: GitBranch },
  "Consensus reached": { tone: "lime", type: "Settlement", icon: CheckCircle2 },
  "Task finalized": { tone: "lime", type: "Settlement", icon: CheckCircle2 },
  "Reward allocated": { tone: "lime", type: "Settlement", icon: WalletCards },
  "Challenge opened": { tone: "coral", type: "Dispute", icon: ShieldAlert },
  "Dispute resolved": { tone: "coral", type: "Dispute", icon: Gavel },
  "Verifier registered": { tone: "sky", type: "Registry", icon: ShieldCheck },
  "Verifier approval changed": { tone: "sky", type: "Registry", icon: ShieldCheck },
  "Role granted": { tone: "sky", type: "Registry", icon: ShieldCheck },
};

/* ── derivations the API cannot preformat (they move with the clock) ─────── */

function isFuture(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) && at > now;
}

/** "in 12 min" ahead of a deadline, "closed 3 hr ago" behind it. */
function untilLabel(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return `closed ${relativeTime(iso, new Date(now))}`;
  if (seconds < 60) return `in ${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hr`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** Two verifiers filing different verdicts for one claim is the product's core signal. */
function verdictSpread(claim: ClaimView): { split: boolean; majority: number; total: number } {
  const total = claim.verdicts.length;
  if (total === 0) return { split: false, majority: 0, total: 0 };
  const tally = new Map<Verdict, number>();
  for (const entry of claim.verdicts) tally.set(entry.verdict, (tally.get(entry.verdict) ?? 0) + 1);
  const majority = Math.max(...tally.values());
  return { split: tally.size > 1, majority, total };
}

function isConflicted(claim: ClaimView): boolean {
  return claim.criticalConflict || verdictSpread(claim).split;
}

/**
 * Verifiers that quote the identical bytes quote them once, with every name on
 * the citation. A span is evidence of the claim, not of the verifier; repeating
 * it per verifier doubled the page while hiding the one fact worth seeing —
 * whether they read the same thing. Grouped by content hash and span text, so a
 * different quote from the same document still shows as its own citation.
 */
function citedSpans(claim: ClaimView): { span: EvidenceSpan; citedBy: string[] }[] {
  const grouped = new Map<string, { span: EvidenceSpan; citedBy: string[] }>();
  for (const verdict of claim.verdicts) {
    for (const span of verdict.sources) {
      const key = `${span.contentHash}\u0000${span.quotedSpan}`;
      const entry = grouped.get(key);
      if (entry) entry.citedBy.push(verdict.verifierLabel);
      else grouped.set(key, { span, citedBy: [verdict.verifierLabel] });
    }
  }
  return [...grouped.values()];
}

/** One reasoning when the verifiers wrote the same one; each of theirs when they did not. */
function reasonings(claim: ClaimView): { shared: string | null; perVerifier: ClaimView["verdicts"] } {
  const distinct = new Set(claim.verdicts.map((verdict) => verdict.reasoningSummary.trim()));
  return distinct.size === 1 ? { shared: [...distinct][0] ?? null, perVerifier: [] } : { shared: null, perVerifier: claim.verdicts };
}

function reportState(report: ReportView): { label: string; tone: Tone } {
  if (report.revealed) return { label: "REVEALED", tone: "lime" };
  if (report.committed) return { label: "COMMITTED", tone: "sky" };
  return { label: "AWAITING", tone: "ink" };
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/* ── shared bits of the ledger vocabulary ────────────────────────────────── */

function Pill({ children, tone = "lime" }: { children: React.ReactNode; tone?: string }) { return <span className={`pill pill-${tone}`}><span className="pill-dot" />{children}</span>; }
function Origin({ kind }: { kind: "chain" | "storage" | "index" }) { return <span className={`origin-chip origin-${kind}`}>{kind === "chain" ? "chain" : kind === "storage" ? "0G storage" : "index"}</span>; }
function Row({ label, sub, children }: { label: string; sub?: React.ReactNode; children: React.ReactNode }) { return <div><span>{label}</span><strong>{children}{sub ? <small>{sub}</small> : null}</strong></div>; }

export default function TaskDetail() {
  const params = useParams<{ taskId: string }>();
  const handle = params.taskId ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const detail = useTask(handle);
  const task = detail.data;
  const health = useHealth();
  const paused = usePaused();
  const wallet = useWallet();
  const protocolParams = useProtocolParams();
  const withdrawal = usePendingWithdrawal();

  const canonicalId = task?.taskId;
  const allocation = useAllocation(canonicalId, wallet.address);
  const openChallenge = useOpenChallenge();
  const claimReward = useClaimReward();
  const withdraw = useWithdraw();

  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [drawer, setDrawer] = useState<{ hash: Bytes32; verifier: string } | null>(null);
  const artifact = useReport(drawer?.hash);

  // Deadlines and "8 min ago" are recomputed on a tick, never frozen at fetch time.
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const sync = useMutation({
    mutationFn: () => syncTask(handle),
    onSuccess: (result) => { queryClient.invalidateQueries({ queryKey: queryKeys.task(handle) }); queryClient.invalidateQueries({ queryKey: ["proofrelay", "tasks"] }); toast.success("Re-indexed from chain", { description: `${result.eventsProcessed} events across blocks ${result.scannedFrom}–${result.scannedTo}` }); },
    onError: (error) => toast.error("Sync failed", { description: `${errorCode(error)} — ${errorMessage(error)}` }),
  });

  const explorer = health.data?.explorer || EXPLORER_URL;
  const claims = useMemo(() => task?.claims ?? [], [task]);
  const conflicted = useMemo(() => claims.filter(isConflicted), [claims]);
  const openClaim = expanded ?? conflicted[0]?.claimId ?? claims[0]?.claimId ?? "";
  const dispute = task?.dispute ?? null;
  const disputeLive = Boolean(dispute && !dispute.resolved);
  const windowOpen = Boolean(task && task.rawStatus === "CONSENSUS" && isFuture(task.disputeDeadline, now));
  const challengeBondBps = protocolParams.data ? Number(protocolParams.data[1]) : null;
  const bondWei = task && challengeBondBps !== null ? (BigInt(task.bountyWei) * BigInt(challengeBondBps)) / 10_000n : null;
  const allocationWei = allocation.data as bigint | undefined;
  const hasAllocation = typeof allocationWei === "bigint" && allocationWei > 0n;
  const isCreator = sameAddress(wallet.address, task?.creator);
  const canChallenge = Boolean(task && windowOpen && !disputeLive && !paused.isPaused);

  const copy = async (label: string, value: string | null | undefined) => { if (!value) return; await navigator.clipboard?.writeText(value); toast.success(`${label} copied`, { description: value }); };
  // Source URLs and labels come from whoever created the task, so the scheme is
  // attacker-chosen: `javascript:` here would run in this origin, and `data:`
  // would open a document that claims to be it. Only the two schemes a source
  // can legitimately be.
  const open = (url: string | null | undefined) => {
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url, window.location.origin);
    } catch {
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    window.open(parsed.href, "_blank", "noopener,noreferrer");
  };

  const submitChallenge = async () => {
    if (!canonicalId) return;
    try {
      const result = await openChallenge.mutateAsync({ taskId: canonicalId, reason, disputedClaims: conflicted.map((claim) => claim.claimId) });
      setChallengeOpen(false);
      setReason("");
      toast.success("Challenge opened", { description: `${formatToken(result.bondWei)} bond posted · ${result.explorerUrl ?? `block ${result.blockNumber}`}` });
    } catch (error) {
      toast.error("Challenge not opened", { description: writeErrorMessage(error) });
    }
  };

  const runClaim = async () => {
    if (!canonicalId) return;
    try {
      const result = await claimReward.mutateAsync(canonicalId);
      toast.success("Reward claimed", { description: result.explorerUrl ?? `Block ${result.blockNumber}` });
    } catch (error) {
      toast.error("Claim failed", { description: writeErrorMessage(error) });
    }
  };

  const runWithdraw = async () => {
    try {
      const result = await withdraw.mutateAsync();
      toast.success("Withdrawal confirmed", { description: result.explorerUrl ?? `Block ${result.blockNumber}` });
    } catch (error) {
      toast.error("Withdrawal failed", { description: writeErrorMessage(error) });
    }
  };

  const heading = task ? task.ref : handle.startsWith("0x") ? shortHash(handle) : handle || "Task";

  // A task the read model has never seen and a task the API could not serve are different facts, and
  // neither of them is "loading" — the record renders one of the two states instead of empty scaffolding.
  if (!task && detail.error) return <DashboardLayout eyebrow="Evidence and settlement record" title={heading}><section className="section-block"><div className="section-header"><div><div className="eyebrow">TASK · {handle.startsWith("0x") ? shortHash(handle) : handle}</div><h2>Task record unavailable</h2></div></div>{isApiError(detail.error) && detail.error.code === "TASK_NOT_FOUND" ? <EmptyStateBlock title="This task is not in the read model" actionLabel={sync.isPending ? "Indexing…" : "Index it from the chain"} onAction={() => sync.mutate()}>{errorMessage(detail.error)}</EmptyStateBlock> : <ErrorState error={detail.error} onRetry={() => { void detail.refetch(); }} retrying={detail.isFetching} />}</section></DashboardLayout>;

  return <DashboardLayout eyebrow="Evidence and settlement record" title={heading}>
    <section className="section-block">
      <div className="task-hero">
        <div className="task-hero-icon"><FileCheck2 size={18} /></div>
        <div className="task-hero-main">
          <div className="task-hero-top">{task ? <Pill tone={task.tone}>{task.status}</Pill> : <Skeleton className="sk-pill" width={78} />}{task && <span className="origin-chip origin-chain">{task.rawStatus} · {task.outcome}</span>}{task?.syncRequired && <button className="quiet-button" onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? "Re-indexing…" : "Index behind chain · re-index"}</button>}</div>
          <h2 className="task-hero-title">{task ? task.title : <Skeleton width={320} height={22} />}</h2>
          <p className="task-hero-question" title={task?.question || undefined}>{task ? task.question || `${task.claimCount} claims · ${task.sourceCount} sources` : <Skeleton width={420} height={9} />}</p>
        </div>
        <div className="task-hero-side">
          <div className="task-hero-hash"><span>Task ID</span><button onClick={() => copy("Task ID", task?.taskId)} title="Copy the full task id">{task ? shortHash(task.taskId) : <Skeleton width={72} height={9} />}<Copy size={11} /></button><span>Manifest hash</span><button onClick={() => copy("Manifest hash", task?.manifestHash)} title="Copy the manifest hash">{task ? shortHash(task.manifestHash) : <Skeleton width={72} height={9} />}<Copy size={11} /></button></div>
          <button className="quiet-button" onClick={() => open(task?.tx.explorerUrl)} disabled={!task?.tx.explorerUrl}>Creation tx <ArrowUpRight size={13} /></button>
        </div>
      </div>
    </section>

    <section className="task-summary-grid">{!task ? <StatCardsSkeleton cards={3} className="summary-strip" /> : <><div className="summary-strip"><span className="summary-label">BOUNTY ESCROWED</span><strong>{task.bountyFormatted}</strong><span>{task.verifierCount} verifiers · creator {shortAddress(toChecksumAddress(task.creator) ?? task.creator)}</span></div><div className="summary-strip sky-summary"><span className="summary-label">AGREEMENT</span><strong>{task.agreementLabel}</strong><span>{task.committedCount}/{task.verifierCount} committed · {task.revealedCount}/{task.verifierCount} revealed</span></div><div className={`summary-strip ${disputeLive || conflicted.length > 0 ? "coral-summary" : "sky-summary"}`}><span className="summary-label">{disputeLive ? "DISPUTE" : "DISPUTE WINDOW"}</span><strong>{disputeLive ? untilLabel(dispute?.deadline, now) ?? "open" : untilLabel(task.disputeDeadline, now) ?? "—"}</strong><span>{disputeLive ? `challenged by ${shortAddress(dispute?.challenger)}` : conflicted.length > 0 ? `${conflicted.length} of ${claims.length} claims contested` : "no challenge opened"}</span></div></>}</section>

    <div className="lower-grid">
      <div className="evidence-section">
        <section className="section-block" id="evidence">
          <div className="section-header"><div><div className="eyebrow">CLAIMS · {task ? claims.length : "—"} <Origin kind="storage" /></div><h2>Evidence and disagreement</h2></div><span className="small-status">{conflicted.length > 0 ? <><span className="live-dot dot-coral" />{conflicted.length} of {claims.length} claims contested</> : task ? <><span className="live-dot" />no verifier disagreement</> : null}</span></div>
          <div className="evidence-list">{!task ? <EvidenceRowsSkeleton rows={3} /> : claims.length === 0 ? <EmptyState icon="inbox">No claim has been read from the manifest yet.</EmptyState> : claims.map((claim) => { const spread = verdictSpread(claim); const conflict = isConflicted(claim); const tone = conflict ? "coral" : CLAIM_TONE[claim.displayVerdict]; return <div className={`evidence-item ${openClaim === claim.claimId ? "expanded" : ""} ${conflict ? "conflict" : ""}`} key={claim.claimId}><button className="evidence-head" onClick={() => setExpanded(openClaim === claim.claimId ? "" : claim.claimId)}><div className={`evidence-number number-${tone === "coral" ? "coral" : tone === "sky" ? "sky" : tone === "ink" ? "ink" : "lime"}`}>{claim.ordinal}</div><div className="evidence-title" title={claim.claimText}><strong>{claim.claimText}</strong><span><FileText size={12} />{claim.primarySourceLabel ?? "no source quoted yet"}</span></div><Pill tone={tone}>{conflict ? "CONFLICT" : claim.displayVerdict}</Pill><span className="confidence" title={conflict ? "verifiers agreeing on the leading verdict, out of those that reported" : "mean confidence of the agreeing verifiers"}>{conflict ? `${spread.majority}/${spread.total}` : claim.confidencePct === null ? "—" : `${claim.confidencePct}%`}</span><ChevronDown size={16} className="evidence-chevron" /></button>{openClaim === claim.claimId && <div className="evidence-detail">{claim.verdicts.length === 0 ? <EmptyState icon="inbox">No verifier has revealed a report for this claim yet.</EmptyState> : <><div className="evidence-meta"><span><ShieldCheck size={12} />{conflict ? "verifiers disagree — every verdict is shown" : `${spread.majority}/${spread.total} verifiers agree`}</span>{claim.evidenceCoverage !== null && <span><FileText size={12} />evidence coverage {Math.round(claim.evidenceCoverage * 100)}%</span>}{claim.retrievedAt && <span><Clock3 size={12} />retrieved {utcClock(claim.retrievedAt)} UTC</span>}</div><div className="verdict-strip">{claim.verdicts.map((verdict) => <div className="verdict-line" key={`${claim.claimId}:${verdict.verifier}`}><span className="verdict-who"><strong>{verdict.verifierLabel}</strong><span>{shortAddress(toChecksumAddress(verdict.verifier) ?? verdict.verifier)}</span></span><Pill tone={VERDICT_TONE[verdict.verdict]}>{VERDICT_LABEL[verdict.verdict]}</Pill><span className="confidence">{Math.round(verdict.confidence * 100)}%</span></div>)}</div>{(() => { const why = reasonings(claim); return why.shared ? <p className="verdict-reasoning">{why.shared}</p> : why.perVerifier.map((verdict) => <p className="verdict-reasoning" key={`${claim.claimId}:${verdict.verifier}:why`}><strong>{verdict.verifierLabel}:</strong> {verdict.reasoningSummary}</p>); })()}{citedSpans(claim).map(({ span, citedBy }) => <div className="verdict-source" key={`${span.contentHash}:${span.snapshotObjectId}:${span.quotedSpan.slice(0, 40)}`}><div className="quote-mark">“</div><p>{span.quotedSpan}</p><div className="evidence-meta"><span><ShieldCheck size={12} />cited by {citedBy.join(", ")}</span><span><FileText size={12} />{hostOf(span.uri)}</span><span><Hash size={12} />{shortHash(span.contentHash)}</span><span className="storage-pointer"><Database size={12} />{shortHash(span.snapshotObjectId, 6, 6)}</span><span><Clock3 size={12} />{utcClock(span.retrievedAt)} UTC</span><button onClick={() => open(span.uri)}>Open source <ArrowUpRight size={12} /></button></div></div>)}</>}</div>}</div>; })}</div>
        </section>

        <section className="section-block" id="reports">
          <div className="section-header"><div><div className="eyebrow">VERIFIER REPORTS <Origin kind="chain" /></div><h2>Commit and reveal</h2></div></div>
          <div className="signal-table report-table"><div className="signal-head"><span>Verifier</span><span>Report hash</span><span>Model</span><span>Revealed</span><span /></div>{!task ? <SignalRowsSkeleton rows={2} /> : task.reports.length === 0 ? <EmptyState icon="inbox">No verifier has been assigned to this task yet.</EmptyState> : task.reports.map((report) => { const state = reportState(report); return <button className="signal-row" key={report.verifier} title={report.reportHash ? "Open the raw report artifact" : "No report has been revealed"} disabled={!report.reportHash} onClick={() => report.reportHash && setDrawer({ hash: report.reportHash, verifier: report.verifierLabel })}><div><span className={`signal-icon signal-${state.tone === "ink" ? "sky" : state.tone}`}><FileJson2 size={13} /></span><strong>{report.verifierLabel}</strong><Pill tone={state.tone}>{state.label}</Pill></div><span className="mono-text">{report.reportHash ? shortHash(report.reportHash) : report.commitment ? `commit ${shortHash(report.commitment)}` : "—"}</span><span className="model-cell" title={report.modelId ? `${report.modelId}${report.pipelineVersion ? ` · pipeline ${report.pipelineVersion}` : ""}` : undefined}><strong>{report.modelId ?? "—"}</strong>{report.pipelineVersion && <small>pipeline {report.pipelineVersion}</small>}</span><span className="muted-time"><Clock3 size={12} />{report.revealedAt ? relativeTime(report.revealedAt, new Date(now)) : report.committedAt ? `committed ${relativeTime(report.committedAt, new Date(now))}` : "—"}</span><ArrowUpRight size={14} /></button>; })}</div>
        </section>

        <section className="section-block" id="timeline">
          <div className="section-header"><div><div className="eyebrow">CHAIN EVENTS <Origin kind="chain" /></div><h2>Task timeline</h2></div>{task && <span className="small-status"><span className="live-dot" />{task.timeline.length} indexed events</span>}</div>
          <div className="activity-timeline timeline-compact">{!task ? <TimelineSkeleton rows={4} /> : task.timeline.length === 0 ? <EmptyStateBlock title="No chain events indexed for this task" actionLabel={sync.isPending ? "Indexing…" : "Index it from the chain"} onAction={() => sync.mutate()}>The read model has no logs for this task id yet.</EmptyStateBlock> : task.timeline.map((event, index) => { const style = TIMELINE_STYLE[event.label] ?? { tone: "ink", type: "Chain", icon: Activity }; const Icon = style.icon; const day = dayBucket(event.at, new Date(now)); const previous = index === 0 ? null : dayBucket(task.timeline[index - 1].at, new Date(now)); return <div className="timeline-entry" key={`${event.tx.txHash ?? "notx"}:${index}`}>{previous !== day && <div className="timeline-day">{day}</div>}<div className="timeline-line"><div className={`timeline-node timeline-${style.tone}`}><Icon size={14} /></div><div className="timeline-content"><div className="timeline-top"><time>{utcClock(event.at)} UTC</time><span className="event-type">{style.type}</span></div><h3>{event.label}</h3><p>{event.detail}</p><div className="timeline-meta"><span><Hash size={12} />{event.tx.txHash ? shortHash(event.tx.txHash) : "—"}</span>{event.tx.blockNumber !== null && <span><Activity size={12} />block {event.tx.blockNumber.toLocaleString("en-US")}</span>}{event.tx.explorerUrl && <button onClick={() => open(event.tx.explorerUrl)}>View transaction <ArrowUpRight size={12} /></button>}</div></div></div></div>; })}</div>
        </section>
      </div>

      <div className="right-column">
        <div className="side-card">
          <div className="side-card-head"><div><span className="eyebrow">ACTIONS</span><h3>Settle or contest</h3></div><Origin kind="chain" /></div>
          {!wallet.isConnected ? <div className="side-note">Connect a wallet to open a challenge, claim a reward or withdraw. Nothing on this page is signed without one.</div> : wallet.isWrongNetwork ? <div className="side-note">This wallet is on another chain. Switch it to the network the contract is deployed on before signing.</div> : <div className="side-note">{isCreator ? "You created this task. " : ""}{hasAllocation ? `Your allocation is ${formatToken(allocationWei as bigint)}.` : canChallenge ? `The dispute window closes ${untilLabel(task?.disputeDeadline, now)}.` : disputeLive ? `Adjudication closes ${untilLabel(dispute?.deadline, now)}.` : paused.isPaused ? "The contract is paused: challenges are blocked, withdrawals are not." : "No transaction is available to this wallet for this task right now."}</div>}
          {!wallet.isConnected && <button className="primary-button full-button" onClick={() => { void wallet.connect().catch((error: unknown) => toast.error("Wallet not connected", { description: writeErrorMessage(error, "The wallet rejected the connection.") })); }}><WalletCards size={16} />Connect wallet</button>}
          {wallet.isConnected && wallet.isWrongNetwork && <button className="primary-button full-button" onClick={() => { void wallet.switchNetwork(); }} disabled={wallet.isSwitchingNetwork}>{wallet.isSwitchingNetwork ? "Switching…" : "Switch network"}</button>}
          {wallet.isConnected && !wallet.isWrongNetwork && canChallenge && <button className="primary-button full-button" onClick={() => setChallengeOpen(true)}><ShieldAlert size={16} />Open challenge</button>}
          {wallet.isConnected && !wallet.isWrongNetwork && hasAllocation && <button className="primary-button full-button" onClick={runClaim} disabled={claimReward.isPending}><WalletCards size={16} />{claimReward.isPending ? "Claiming…" : `Claim ${formatToken(allocationWei as bigint)}`}</button>}
          {wallet.isConnected && !wallet.isWrongNetwork && withdrawal.hasBalance && <button className="secondary-button full-button" onClick={runWithdraw} disabled={withdraw.isPending}>{withdraw.isPending ? "Withdrawing…" : `Withdraw ${formatToken(withdrawal.wei as bigint)}`}</button>}
        </div>

        <div className="side-card">
          <div className="side-card-head"><div><span className="eyebrow">ONCHAIN RECORD</span><h3>What the contract holds</h3></div><Origin kind="chain" /></div>
          <div className="operator-metrics">{!task ? <><Row label="Status"><Skeleton width={78} height={9} /></Row><Row label="Creator"><Skeleton width={78} height={9} /></Row><Row label="Bounty"><Skeleton width={78} height={9} /></Row></> : <><Row label="Status" sub={task.outcome}>{task.rawStatus}</Row><Row label="Creator"><button className="quiet-button tiny-quiet" onClick={() => open(`${explorer.replace(/\/$/, "")}/address/${task.creator}`)}>{shortAddress(toChecksumAddress(task.creator) ?? task.creator)}</button></Row><Row label="Bounty">{task.bountyFormatted}</Row><Row label="Verifiers" sub={`${task.committedCount} committed · ${task.verifierCount} required`}>{task.revealedCount} / {task.verifierCount} revealed</Row><Row label="Commit deadline">{task.commitDeadline ? untilLabel(task.commitDeadline, now) : "—"}</Row><Row label="Reveal deadline">{task.revealDeadline ? untilLabel(task.revealDeadline, now) : "—"}</Row><Row label="Dispute deadline">{task.disputeDeadline ? untilLabel(task.disputeDeadline, now) : "—"}</Row><Row label="Manifest pointer">{shortHash(task.manifestPointer, 8, 6)}</Row><Row label="Result hash">{task.resultHash ? shortHash(task.resultHash) : "not settled"}</Row><Row label="Created" sub={relativeTime(task.createdAt, new Date(now))}>{task.tx.blockNumber === null ? "—" : `block ${task.tx.blockNumber.toLocaleString("en-US")}`}</Row></>}</div>
          {task?.tx.explorerUrl && <button className="quiet-button full-button" onClick={() => open(task.tx.explorerUrl)}><ExternalLink size={13} /> Open creation transaction</button>}
        </div>

        <div className="side-card">
          <div className="side-card-head"><div><span className="eyebrow">SETTLEMENT</span><h3>{task?.consensus ? task.consensus.outcome : "Not evaluated"}</h3></div><Origin kind="storage" /></div>
          {!task ? <div className="operator-metrics"><Row label="Outcome"><Skeleton width={70} height={9} /></Row><Row label="Agreement"><Skeleton width={70} height={9} /></Row></div> : !task.consensus ? <EmptyState icon="inbox">Consensus has not been evaluated for this task yet.</EmptyState> : <><div className="operator-metrics"><Row label="Outcome">{task.consensus.outcome}</Row><Row label="Agreement">{(task.consensus.agreementBps / 100).toFixed(2)}%</Row><Row label="Claims in conflict">{task.consensus.conflicts.length}</Row><Row label="Rewarded verifiers">{task.consensus.rewardedVerifiers.length}</Row><Row label="Result hash"><button className="quiet-button tiny-quiet" onClick={() => copy("Result hash", task.consensus?.resultHash)}>{shortHash(task.consensus.resultHash)}</button></Row><Row label="Evaluated">{relativeTime(task.consensus.evaluatedAt, new Date(now))}</Row></div>{task.consensus.conflicts.length > 0 && <div className="side-note"><strong>Conflicting claims:</strong> {task.consensus.conflicts.join(", ")}</div>}{task.allocations.length > 0 && <div className="side-list">{task.allocations.map((entry) => <div className="verifier-row" key={entry.verifier}><div className="verifier-avatar lime-avatar">{(toChecksumAddress(entry.verifier) ?? entry.verifier).slice(2, 4).toUpperCase()}</div><div className="verifier-info"><strong>{shortAddress(toChecksumAddress(entry.verifier) ?? entry.verifier)}</strong><span>allocated onchain</span></div><div className="verifier-result"><strong>{formatToken(entry.amountWei)}</strong><span className="result-good"><CheckCircle2 size={11} />allocated</span></div></div>)}</div>}</>}
        </div>

        {dispute && <div className="side-card">
          <div className="side-card-head"><div><span className="eyebrow">DISPUTE</span><h3>{dispute.resolved ? dispute.upheld ? "Challenge upheld" : "Challenge rejected" : "Open"}</h3></div><Origin kind="chain" /></div>
          {dispute.reason && <div className="side-note"><strong>Reason:</strong> {dispute.reason}</div>}
          <div className="operator-metrics"><Row label="Challenger"><button className="quiet-button tiny-quiet" onClick={() => open(`${explorer.replace(/\/$/, "")}/address/${dispute.challenger}`)}>{shortAddress(toChecksumAddress(dispute.challenger) ?? dispute.challenger)}</button></Row><Row label="Bond">{formatToken(dispute.bondWei)}</Row><Row label="Opened">{dispute.openedAt ? relativeTime(dispute.openedAt, new Date(now)) : "—"}</Row><Row label="Adjudication">{dispute.deadline ? untilLabel(dispute.deadline, now) : "—"}</Row><Row label="Evidence hash"><button className="quiet-button tiny-quiet" onClick={() => copy("Evidence hash", dispute.evidenceHash)}>{shortHash(dispute.evidenceHash)}</button></Row>{dispute.adjudicationHash && <Row label="Adjudication hash"><button className="quiet-button tiny-quiet" onClick={() => copy("Adjudication hash", dispute.adjudicationHash)}>{shortHash(dispute.adjudicationHash)}</button></Row>}</div>
          {dispute.decision && <div className="side-note"><strong>Decision:</strong> {dispute.decision}</div>}
          {dispute.tx.explorerUrl && <button className="quiet-button full-button" onClick={() => open(dispute.tx.explorerUrl)}><ExternalLink size={13} /> Open dispute transaction</button>}
        </div>}
      </div>
    </div>


    {challengeOpen && task && <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setChallengeOpen(false); }}><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">Open challenge · {task.ref}</span><h2>Put a bond behind the disagreement.</h2></div><button className="icon-button" onClick={() => setChallengeOpen(false)}>×</button></div><p className="modal-copy">The reason and the claims below are uploaded as a canonical challenge-evidence artifact, then <strong>openChallenge</strong> is signed by your wallet with the bond as its value.</p><div className="form-grid"><label className="field full"><span>Why is this result wrong?</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Name the claim and the evidence the verifiers missed (10 characters minimum)" /></label><label className="field"><span>Bond</span><div className="field-static"><span>{bondWei === null ? <Skeleton width={72} height={9} /> : formatToken(bondWei)}</span><span>{challengeBondBps === null ? "" : `${challengeBondBps / 100}% of bounty`}</span></div></label><label className="field"><span>Window closes</span><div className="field-static"><span>{untilLabel(task.disputeDeadline, now) ?? "—"}</span><Clock3 size={15} /></div></label><label className="field full"><span>Claims flagged</span><div className="field-static"><span>{conflicted.length === 0 ? "No claim is in conflict — the challenge is filed against the result as a whole." : `Claims ${conflicted.map((claim) => claim.ordinal).join(", ")}`}</span><span>{conflicted.length} of {claims.length}</span></div></label></div><div className="modal-foot"><span className="modal-note"><ShieldAlert size={15} />The bond is escrowed onchain until an adjudicator rules</span><button className="primary-button" onClick={submitChallenge} disabled={reason.trim().length < 10 || openChallenge.isPending || !wallet.isConnected || wallet.isWrongNetwork}>{openChallenge.isPending ? "Signing…" : "Open challenge"} <ArrowUpRight size={16} /></button></div></div></div>}

    {drawer && <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setDrawer(null); }}><div className="modal-card modal-wide"><div className="modal-head"><div><span className="eyebrow">Raw artifact · {drawer.verifier}</span><h2>Verifier report</h2></div><button className="icon-button" onClick={() => setDrawer(null)}>×</button></div>{artifact.isLoading ? <div className="drawer-chips"><Skeleton className="sk-pill" width={92} /><Skeleton width={124} height={9} /></div> : artifact.error ? <ErrorState error={artifact.error} onRetry={() => { void artifact.refetch(); }} retrying={artifact.isFetching} /> : artifact.data ? <><div className="drawer-chips"><Pill tone={artifact.data.verified ? "lime" : "coral"}>{artifact.data.verified ? "VERIFIED: TRUE" : "VERIFIED: FALSE"}</Pill><span className={`origin-chip origin-${artifact.data.source === "storage" ? "storage" : "index"}`}>{artifact.data.source === "storage" ? "served from 0G storage" : "served from index cache"}</span>{artifact.data.pointer && <span className="storage-pointer"><Database size={12} />{artifact.data.pointer}</span>}</div>{artifact.data.source === "cache" && <p className="modal-copy">The storage gateway did not answer; this body came from the indexer's cache. Its hash was still checked against the report hash recorded onchain.</p>}{!artifact.data.verified && <p className="modal-copy">The recomputed canonical hash does not match the report hash onchain. Treat this body as untrusted.</p>}<div className="code-block code-scroll"><div className="code-head"><span><FileJson2 size={13} />{shortHash(artifact.data.reportHash, 8, 8)}</span><button onClick={() => copy("Report JSON", JSON.stringify(artifact.data.report, null, 2))}>Copy JSON</button></div><pre>{JSON.stringify(artifact.data.report, null, 2)}</pre></div></> : null}<div className="modal-foot"><span className="modal-note"><Hash size={15} />Content-addressed object · GET /v1/reports/{shortHash(drawer.hash, 6, 6)}</span><button className="primary-button" onClick={() => { setDrawer(null); navigate("/artifacts"); }}>All artifacts <ArrowUpRight size={16} /></button></div></div></div>}
  </DashboardLayout>;
}
