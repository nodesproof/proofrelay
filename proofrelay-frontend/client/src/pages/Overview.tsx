// Evidence Ledger design: Overview prioritizes proof operations, not vanity metrics.
// Nothing on this page is a literal any more. The four metric cards read GET /v1/stats; the hero
// caption, the task banner and the evidence trail read the newest task from GET /v1/tasks?limit=3
// and GET /v1/tasks/:taskId; "Latest tasks" is that same list. A value still in flight renders the
// design's loading state and a value the protocol has not produced renders its empty state — the
// page never substitutes a plausible number for one nobody measured.
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Activity, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, FileCheck2, FileText, GitBranch, Hash, Plus, ShieldCheck, Sparkles, WalletCards, Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import EvidenceFlow from "@/components/EvidenceFlow";
import { EmptyState, EmptyStateBlock, ErrorState, EvidenceRowsSkeleton, MetricCardsSkeleton, Skeleton, TaskRowsSkeleton } from "@/components/states";
import { useStats, useTask, useTasks } from "@/hooks/useProofRelay";
import { API_URL } from "@/lib/api";
import { formatToken, percentLabel, plural, relativeTime, shortHash } from "@/lib/format";
import type { ClaimView, TaskDetail, TaskSummary } from "@/lib/types";


/** getTask() returns this for a manifest that was never anchored; the corner caption depends on it. */
const ZERO_HASH = `0x${"0".repeat(64)}`;

/** How many rows the queue shows, and therefore how many the API is asked for. */
const LATEST_TASKS = 3;

/** packages/consensus displayVerdict() → the pill tone in FRONTEND_DATA_CONTRACT §6.2. */
const VERDICT_TONE: Record<ClaimView["displayVerdict"], string> = { SUPPORTED: "lime", CONTRADICTED: "coral", INSUFFICIENT: "sky", PENDING: "ink" };

/**
 * Contract status → the second line under "Updated" (FRONTEND_DATA_CONTRACT §1.2).
 * Keyed by the exact strings the API sends on `rawStatus`: `statusName()` in
 * packages/schemas/src/task.ts returns TASK_STATUS_NAMES, which are upper case.
 * A key in any other case silently falls through and prints the raw enum instead.
 */
const STATUS_NOTE: Record<string, string> = { NONE: "Not indexed", OPEN: "Awaiting commits", COMMITTING: "Committing", REVEALING: "Revealing", CONSENSUS: "Dispute window", DISPUTED: "Needs review", ADJUDICATION: "Needs review", FINALIZED: "Finalized", EXPIRED: "Expired", CANCELLED: "Cancelled" };

/** "38 sec" over the real median; the same shape the design drew, never a fixed value. */
function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 90) return `${Math.round(seconds)} sec`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hr`;
  return `${Math.round(hours / 24)} days`;
}

/** "local://7574…f3b2" — a storage pointer shortened without losing the scheme that names its driver. */
function shortPointer(pointer: string | null | undefined): string {
  if (!pointer) return "—";
  const split = pointer.indexOf("://");
  if (split < 0) return shortHash(pointer);
  return `${pointer.slice(0, split + 3)}${shortHash(pointer.slice(split + 3))}`;
}

/** "08:32" UTC out of an ISO instant, matching the design's retrieval stamp. */
function utcHm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(11, 16);
}

/**
 * The canonical snapshot object behind a claim's quoted span. The manifest records the
 * `snapshotHash` for every source, so "View source" resolves the span's pointer to that hash and
 * opens the stored artifact; when no snapshot was recorded the button is not offered at all.
 */
function snapshotUrl(task: TaskDetail | undefined, claim: ClaimView): string | null {
  const objectId = claim.snapshotObjectId;
  if (!objectId) return null;
  const split = objectId.indexOf("://");
  const bare = (split < 0 ? objectId : objectId.slice(split + 3)).toLowerCase();
  const recorded = task?.sources.find((source) => source.snapshotPointer === objectId || source.snapshotHash.toLowerCase() === bare || source.snapshotHash.toLowerCase() === `0x${bare}`);
  const hash = recorded?.snapshotHash ?? (/^(0x)?[0-9a-f]{64}$/.test(bare) ? (bare.startsWith("0x") ? bare : `0x${bare}`) : null);
  return hash ? `${API_URL}/v1/artifacts/${hash}` : null;
}

/** Relative stamps are recomputed on a tick, not frozen at fetch time (FRONTEND_DATA_CONTRACT §1.2). */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Pill({ children, tone = "lime" }: { children: string; tone?: string }) { return <span className={`pill pill-${tone}`}><span className="pill-dot" />{children}</span>; }

/**
 * The trend badge exists only when the previous window actually had a value to compare against —
 * `null` means "not measured", and an unmeasured trend renders nothing rather than a placeholder.
 */
function Trend({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  const size = Math.abs(pct);
  return <span className="metric-trend">{pct < 0 ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}{size >= 10 ? Math.round(size) : size.toFixed(1)}%</span>;
}

function Metric({ label, value, helper, icon: Icon, tone, trend, title }: { label: string; value: React.ReactNode; helper: React.ReactNode; icon: typeof Activity; tone: string; trend?: number | null; title?: string }) { return <div className={`metric-card metric-${tone}`} title={title}><div className="metric-topline"><span className="eyebrow">{label}</span><Icon size={16} /></div><div className="metric-value">{value}</div><div className="metric-helper">{helper}<Trend pct={trend} /></div></div>; }

export default function Overview() {
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState("01");
  const [modal, setModal] = useState(false);
  const now = useNow();

  const stats = useStats();
  const tasks = useTasks({ limit: LATEST_TASKS });
  const items: TaskSummary[] = tasks.data?.items ?? [];
  const selected: TaskSummary | undefined = items[0];
  const detail = useTask(selected?.taskId);
  const task = detail.data;
  const claims = task?.claims ?? [];

  const statsPending = !stats.data && !stats.error;
  const tasksPending = !tasks.data && !tasks.error;
  const detailPending = Boolean(selected) && !detail.data && !detail.error;
  const anchored = selected ? selected.manifestHash && selected.manifestHash !== ZERO_HASH : false;

  /** The task bundle the API actually served, written out verbatim — no re-derivation, no summary. */
  const exportJson = () => {
    if (!task) return;
    const body = JSON.stringify(task, null, 2);
    const file = `${task.ref}-${task.taskId.slice(0, 10)}.json`;
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success("Evidence bundle downloaded", { description: `${file} · ${claims.length} claims · ${task.reports.length} reports` });
  };

  const openSnapshot = (url: string) => { window.open(url, "_blank", "noopener,noreferrer"); };

  return <DashboardLayout eyebrow="Real-time proof operations" title="Overview">
    <section className="hero-row"><div className="hero-copy"><h2 className="hero-title">Make every answer<br /><em>earn its confidence.</em></h2><p>ProofRelay turns AI outputs into auditable work. Independent verifiers produce evidence graphs, while 0G keeps the artifacts and settlement transparent.</p><div className="hero-actions"><button className="primary-button" onClick={() => setModal(true)}><Plus size={17} />Create verification task</button><button className="secondary-button" onClick={() => navigate("/protocol-docs")}><Sparkles size={16} />View how it works</button></div></div><div className="hero-visual"><EvidenceFlow task={task} pending={detailPending} /><div className="visual-caption"><span>LIVE EVIDENCE GRAPH</span><strong>{selected ? `${selected.revealedCount}/${selected.verifierCount} verifiers · ${plural(selected.rawStatus === "FINALIZED" ? 1 : 0, "settlement")}` : tasksPending ? <Skeleton width={168} height={16} /> : "No task indexed yet"}</strong></div><div className="visual-corner top-left">{selected ? `0G / ${shortHash(selected.taskId)}` : "0G / —"}</div><div className="visual-corner bottom-right" title={selected ? `manifest ${selected.manifestHash}` : undefined}>{selected ? anchored ? "hash anchored" : "manifest pending" : ""}</div></div></section>
    <section className="metric-grid">{statsPending ? <MetricCardsSkeleton /> : !stats.data ? <ErrorState error={stats.error} onRetry={() => { void stats.refetch(); }} retrying={stats.isFetching} /> : <><Metric label="Active tasks" value={String(stats.data.activeTasks)} helper={`${stats.data.tasksNeedingReview} need your review`} icon={FileCheck2} tone="lime" trend={stats.data.activeTasksTrendPct} title={`${stats.data.openQueue} open · ${stats.data.inReview} in review · ${stats.data.conflict} in conflict · ${stats.data.disputed} disputed · ${stats.data.totalTasks} indexed in total`} /><Metric label="Evidence coverage" value={percentLabel(stats.data.evidenceCoveragePct, 1) ?? "—"} helper={stats.data.evidenceCoverageSampleSize === 0 ? "No settled claims yet" : `Across ${plural(stats.data.evidenceCoverageSampleSize, "settled claim")}`} icon={ShieldCheck} tone="sky" trend={stats.data.evidenceCoverageTrendPct} title="Share of claims on settled tasks whose agreeing verifiers cited at least one source" /><Metric label="Bounties settled" value={formatToken(stats.data.bountiesSettledWei)} helper="All tasks" icon={WalletCards} tone="ink" trend={stats.data.bountiesSettledTrendPct} title={`${formatToken(stats.data.bountiesEscrowedWei)} still escrowed`} /><Metric label="Median verification" value={stats.data.medianVerificationSec === null ? "—" : durationLabel(stats.data.medianVerificationSec)} helper="From claim to result" icon={Zap} tone="coral" title={stats.data.medianVerificationSampleSize === 0 ? "No task has reached consensus yet" : `Median across ${plural(stats.data.medianVerificationSampleSize, "settled task")}`} /></>}</section>
    <section className="section-block"><div className="section-header"><div><div className="eyebrow">{selected ? `SELECTED TASK · ${selected.ref}` : "SELECTED TASK"}</div><h2>Evidence trail</h2></div><button className="quiet-button" onClick={exportJson} disabled={!task}>Export JSON <ArrowUpRight size={14} /></button></div>
      {tasks.error && !selected ? <ErrorState error={tasks.error} onRetry={() => { void tasks.refetch(); }} retrying={tasks.isFetching} /> : !selected && !tasksPending ? <EmptyStateBlock title="No task to trail yet">Nothing has been created on this deployment. The newest task's claims, verdicts and quoted spans appear here as soon as one is indexed.</EmptyStateBlock> : <>
        <div className="task-banner">{selected ? <><div className="task-banner-icon"><FileCheck2 size={20} /></div><div className="task-banner-copy"><div className="task-banner-top"><strong>{selected.title}</strong><Pill tone={selected.tone}>{selected.status}</Pill></div><span>Snapshot anchored {relativeTime(selected.createdAt, now)} · {plural(selected.verifierCount, "independent verifier")} · {selected.hasDispute ? "challenge opened" : "no challenge opened"}</span></div><div className="task-banner-hash"><span>Task hash</span><strong title={`${selected.taskId}\n${selected.ref} is an index-assigned handle, not an onchain identifier\nmanifest ${selected.manifestHash}${selected.tx.txHash ? `\ncreated in ${selected.tx.txHash}` : ""}${selected.syncRequired ? "\nread model is behind the chain" : ""}`}>{shortHash(selected.taskId)}</strong></div></> : <><div className="task-banner-icon"><FileCheck2 size={20} /></div><div className="task-banner-copy"><div className="task-banner-top"><Skeleton width={232} height={13} /></div><span><Skeleton width={296} height={9} /></span></div><div className="task-banner-hash"><span>Task hash</span><Skeleton width={72} height={9} /></div></>}</div>
        <div className="evidence-list">{detailPending ? <EvidenceRowsSkeleton rows={Math.max(1, selected?.claimCount ?? 3)} /> : detail.error && !task ? <ErrorState error={detail.error} onRetry={() => { void detail.refetch(); }} retrying={detail.isFetching} /> : claims.length === 0 ? <EmptyState>No claim is readable for this task yet — the manifest has not been fetched from storage.</EmptyState> : claims.map((claim) => { const source = snapshotUrl(task, claim); const retrieved = utcHm(claim.retrievedAt); return <div className={`evidence-item ${expanded === claim.ordinal ? "expanded" : ""}`} key={claim.claimId}><button className="evidence-head" onClick={() => setExpanded(expanded === claim.ordinal ? "" : claim.ordinal)}><div className="evidence-number number-lime">{claim.ordinal}</div><div className="evidence-title"><strong>{claim.claimText}</strong>{claim.primarySourceLabel && <span><FileText size={12} />{claim.primarySourceLabel}</span>}</div><Pill tone={VERDICT_TONE[claim.displayVerdict]}>{claim.displayVerdict}</Pill><span className="confidence" title={claim.confidencePct === null ? "No verifier has revealed a verdict for this claim" : `Mean confidence of the agreeing verifiers across ${plural(claim.verdicts.length, "report")}`}>{claim.confidencePct === null ? "—" : `${Math.round(claim.confidencePct)}%`}</span><ChevronDown size={16} className="evidence-chevron" /></button>{expanded === claim.ordinal && <div className="evidence-detail"><div className="quote-mark">“</div><p>{claim.excerpt ?? "No verifier has quoted a span for this claim yet."}</p><div className="evidence-meta">{claim.snapshotObjectId && <span title={claim.snapshotObjectId}><Hash size={12} />{shortPointer(claim.snapshotObjectId)}</span>}{retrieved && <span title={claim.retrievedAt ?? undefined}><Clock3 size={12} />retrieved {retrieved} UTC</span>}{source && <button onClick={() => openSnapshot(source)}>View source <ArrowUpRight size={12} /></button>}</div></div>}</div>; })}</div>
      </>}
    </section>
    <section className="section-block"><div className="section-header"><div><div className="eyebrow">WORKSPACE QUEUE</div><h2>Latest tasks</h2></div><button className="secondary-button compact" onClick={() => setModal(true)}><Plus size={15} />New task</button></div><div className="task-table">{tasksPending ? <TaskRowsSkeleton rows={LATEST_TASKS} /> : tasks.error && items.length === 0 ? <ErrorState error={tasks.error} onRetry={() => { void tasks.refetch(); }} retrying={tasks.isFetching} /> : items.length === 0 ? <EmptyState icon="inbox">No verification task has been indexed yet.</EmptyState> : items.map((row) => <button key={row.taskId} className="task-row" onClick={() => navigate(`/task/${row.taskId}`)}><div className="task-main"><div className={`task-id task-${row.tone}`} title={`${row.taskId}\n${row.ref} is an index-assigned handle, not an onchain identifier`}>{row.ref}</div><div><strong>{row.title}</strong><span><GitBranch size={12} />{row.primarySource ?? "no source recorded"}{row.sourceCount > 1 ? ` +${row.sourceCount - 1}` : ""}</span></div></div><Pill tone={row.tone}>{row.status}</Pill><div className="agreement"><div className="progress-track"><span style={{ width: `${row.agreementPct}%` }} className={`progress-fill fill-${row.tone}`} /></div><span>{row.agreementLabel}</span></div><div className="task-bounty"><strong>{row.bountyFormatted}</strong><span>{plural(row.verifierCount, "verifier")}</span></div><div className="task-time"><strong>{relativeTime(row.updatedAt, now)}</strong><span>{STATUS_NOTE[row.rawStatus] ?? row.rawStatus}</span></div><ChevronDown size={17} className="row-chevron" /></button>)}</div></section>
    {modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setModal(false); }}><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">New verification request</span><h2>Make the claim earn its confidence.</h2></div><button className="icon-button" onClick={() => setModal(false)}>×</button></div><p className="modal-copy">Create-task form is available on the dedicated Verification Tasks page.</p><div className="modal-foot"><span className="modal-note"><CheckCircle2 size={15} />Public-data demo · no private inputs stored</span><button className="primary-button" onClick={() => { setModal(false); navigate("/verification-tasks?create=1"); }}>Continue <ArrowUpRight size={16} /></button></div></div></div>}
  </DashboardLayout>;
}
