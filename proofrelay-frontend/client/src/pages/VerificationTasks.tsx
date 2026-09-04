// Evidence Ledger design: the task queue is a work surface with explicit states, bounty, and verifier agreement.
// Nothing on this page is a literal any more. The three strips are GET /v1/stats, the table is GET /v1/tasks with
// the search box and the four display groups pushed into the query (debounced, server-side), the workflow card
// reads the selected task's real lifecycle position, and the modal is the real escrow path: POST /v1/tasks/prepare,
// then createTask signed in the wallet, then the receipt. The manifest hash shown before the signature is read out
// of the transaction the wallet is holding, so the frozen claim list is on screen at signing time (THREAT_MODEL).
import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { toast } from "sonner";
import { useMutationState } from "@tanstack/react-query";
import { formatEther, parseEther } from "viem";
import { useReadContract } from "wagmi";
import { ArrowUpRight, CheckCircle2, ChevronDown, Clock3, GitBranch, Plus, Search, ShieldCheck, X } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { EmptyState, EmptyStateBlock, ErrorState, IndexingState, StatCardsSkeleton, TaskRowsSkeleton, Skeleton, errorCode, errorMessage } from "@/components/states";
import { useCreateTask, useHealth, usePaused, useProtocolParams, useStats, useTask, useTasks, useWallet } from "@/hooks/useProofRelay";
import { PROOFRELAY_ADDRESS, proofRelayAbi } from "@/lib/contract";
import { ACTIVE_CHAIN_ID, NETWORK_NAME, explorerTxUrl } from "@/lib/wagmi";
import { isApiError } from "@/lib/api";
import type { PrepareTaskRequest, TaskSummary } from "@/lib/types";
import { chainName, plural, relativeTime, shortHash } from "@/lib/format";

/** The four display groups the API groups tasks by; the labels below are the design's, unchanged. */
type Filter = "ALL" | "VERIFIED" | "IN REVIEW" | "CONFLICT" | "DISPUTED";
const FILTERS: Filter[] = ["ALL", "VERIFIED", "IN REVIEW", "CONFLICT", "DISPUTED"];

/** The createTask tuple, exactly as the ABI declares it — this is what the wallet is asked to sign. */
interface CreateSpec { verifierCount: number; commitWindowSec: number; revealWindowSec: number; disputeWindowSec: number; manifestHash: string; manifestPointer: string; ruleId: string }
interface WriteVariables { functionName?: string; args?: readonly unknown[]; value?: bigint }
interface WriteSnapshot { status: "idle" | "pending" | "success" | "error"; submittedAt: number; variables: WriteVariables | undefined; hash: string | undefined }
type StageState = "idle" | "active" | "done" | "failed";

function Pill({ children, tone = "lime" }: { children: React.ReactNode; tone?: string }) { return <span className={`pill pill-${tone}`}><span className="pill-dot" />{children}</span>; }

/** "8 min ago" has to age on a clock, not on a fetch, so the whole table shares one 30 s tick. */
function useClockTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(id); }, [intervalMs]);
  return now;
}

/** The design's three words — Finalized / Needs review / Processing — resolved from the real contract status. */
function statusCaption(task: TaskSummary): string {
  if (task.status === "VERIFIED") return "Finalized";
  if (task.status === "CONFLICT") return "No consensus";
  if (task.status === "NO QUORUM") return "No quorum";
  if (task.status === "DISPUTED") return "Needs review";
  if (task.status === "EXPIRED") return "Expired";
  if (task.status === "CANCELLED") return "Cancelled";
  switch (task.rawStatus) {
    case "OPEN": return "Awaiting commits";
    case "COMMITTING": return "Committing";
    case "REVEALING": return "Revealing";
    case "CONSENSUS": return "Dispute window";
    default: return "Processing";
  }
}

/** `primarySource` is the manifest's first URI; the table shows host + path and how many more there are. */
function sourceLabel(task: TaskSummary): string {
  if (!task.primarySource) return task.sourceCount > 0 ? "manifest not resolved yet" : "no public source";
  const trimmed = task.primarySource.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return task.sourceCount > 1 ? `${trimmed} +${task.sourceCount - 1}` : trimmed;
}

/** A deadline in the future; `relativeTime` only speaks about the past. */
function countdown(iso: string | null, now: number): string {
  if (!iso) return "no deadline recorded";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "no deadline recorded";
  if (ms <= 0) return "elapsed";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `closes in ${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `closes in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `closes in ${hours} hr`;
  return `closes in ${Math.floor(hours / 24)} days`;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.round(hours / 24)} days`;
}

function windowLabel(seconds: number | undefined): string { return typeof seconds === "number" ? durationLabel(seconds) : "—"; }

/** Where a task actually is, as three booleans read off the contract status the indexer projected. */
function lifecycle(task: TaskSummary | undefined): { manifest: boolean; verify: boolean; settle: boolean } {
  if (!task) return { manifest: false, verify: false, settle: false };
  return { manifest: true, verify: task.rawStatusCode >= 2 || task.committedCount > 0, settle: task.rawStatusCode >= 4 };
}

function stepClass(reached: boolean, tone: "lime-step" | "sky-step" | "coral-step"): string { return reached ? tone : "idle-step"; }

/**
 * The server names the field it rejected — `PERSONAL_DATA_REJECTED` carries the offending field, a
 * `VALIDATION_FAILED` carries the zod path — so the message lands on that input rather than in a toast.
 */
function fieldIssues(error: unknown): { field: string; message: string }[] {
  if (!isApiError(error) || !error.detail) return [];
  const detail = error.detail as { issues?: { path?: string; message?: string }[]; matches?: { field?: string; kind?: string }[]; fields?: string[] };
  const normalise = (field: string) => field.replace(/\[(\d+)\]/g, ".$1");
  if (Array.isArray(detail.issues)) return detail.issues.filter((issue) => issue.path).map((issue) => ({ field: normalise(String(issue.path)), message: String(issue.message ?? "is not valid") }));
  if (Array.isArray(detail.matches)) return detail.matches.filter((match) => match.field).map((match) => ({ field: normalise(String(match.field)), message: `${match.kind ?? "personal data"} detected — this text would become a public artifact` }));
  if (Array.isArray(detail.fields)) return detail.fields.map((field) => ({ field: normalise(field), message: "personal data detected — this text would become a public artifact" }));
  return [];
}

/** viem puts the node's revert string on `details` and the decoded custom error on `shortMessage`. Both are shown verbatim. */
function failureLines(error: unknown): { headline: string; body: string } {
  if (!error) return { headline: "", body: "" };
  const shell = error as { shortMessage?: string; details?: string; message?: string };
  const headline = isApiError(error) ? `${errorCode(error)} — ${errorMessage(error)}` : shell.shortMessage || shell.message || String(error);
  const body = isApiError(error) ? "" : [shell.details, shell.message && shell.message !== shell.shortMessage ? shell.message : ""].filter(Boolean).join("\n");
  return { headline, body };
}

function parseBounty(input: string): { wei: bigint | null; error: string | null } {
  const raw = input.trim();
  if (!raw) return { wei: null, error: "Enter the bounty this task escrows." };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { wei: null, error: "The bounty is a plain decimal amount of 0G, e.g. 0.001." };
  try { return { wei: parseEther(raw as `${number}`), error: null }; } catch { return { wei: null, error: "That bounty has more precision than 0G supports." }; }
}

function badSource(uri: string): string | null {
  let url: URL;
  try { url = new URL(uri); } catch { return "Enter the full URL, including https://"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https sources can be snapshotted.";
  return null;
}

function markFor(state: StageState) { return state === "done" ? <CheckCircle2 size={14} /> : state === "failed" ? <X size={14} /> : <Clock3 size={14} />; }

export default function VerificationTasks() {
  const [, navigate] = useLocation();
  const [routeMatched, routeParams] = useRoute("/task/:taskId");
  const routeTaskId = routeMatched ? routeParams.taskId : undefined;

  // Overview's modal hands off with ?create=1; without this the "Continue" button
  // lands on the queue with the create form closed.
  const searchString = useSearch();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(() => new URLSearchParams(searchString).get("create") === "1");
  const now = useClockTick();

  // Consume the flag so a reload or a back-navigation does not reopen the modal.
  useEffect(() => {
    if (new URLSearchParams(searchString).get("create") !== "1") return;
    setShowCreate(true);
    navigate("/verification-tasks", { replace: true });
  }, [navigate, searchString]);

  // The search is a server query, not a filter over a fixed array, so it is debounced before it becomes one.
  useEffect(() => { const id = window.setTimeout(() => setSearch(query.trim()), 300); return () => window.clearTimeout(id); }, [query]);

  const health = useHealth();
  const stats = useStats();
  const tasks = useTasks({ status: filter === "ALL" ? undefined : filter, q: search || undefined, limit: 25 });
  const items = tasks.data?.items ?? [];
  const selectedQuery = useTask(routeTaskId);
  const selected: TaskSummary | undefined = routeTaskId ? selectedQuery.data ?? items.find((task) => task.taskId.toLowerCase() === routeTaskId.toLowerCase()) : items[0];
  const steps = lifecycle(selected);
  const filtering = filter !== "ALL" || search.length > 0;

  /* ── create task ─────────────────────────────────────────────────────── */

  const wallet = useWallet();
  const paused = usePaused();
  const protocolParams = useProtocolParams();
  const minBountyWei = protocolParams.data ? (protocolParams.data as readonly unknown[])[5] as bigint : undefined;
  const minVerifiers = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "MIN_VERIFIERS", chainId: ACTIVE_CHAIN_ID, query: { staleTime: Infinity, gcTime: Infinity } });
  const maxVerifiers = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "MAX_VERIFIERS", chainId: ACTIVE_CHAIN_ID, query: { staleTime: Infinity, gcTime: Infinity } });
  const verifierRange = typeof minVerifiers.data === "number" && typeof maxVerifiers.data === "number" ? { min: minVerifiers.data, max: maxVerifiers.data } : null;

  const create = useCreateTask();
  const [phase, setPhase] = useState<"form" | "running">("form");
  const [runStartedAt, setRunStartedAt] = useState(Number.POSITIVE_INFINITY);
  const [frozen, setFrozen] = useState<PrepareTaskRequest | null>(null);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [sources, setSources] = useState<string[]>([""]);
  const [claims, setClaims] = useState<string[]>([""]);
  const [verifierCount, setVerifierCount] = useState(2);
  const [bounty, setBounty] = useState("");

  useEffect(() => { if (verifierRange && verifierCount < verifierRange.min) setVerifierCount(verifierRange.min); }, [verifierCount, verifierRange]);

  // wagmi's write mutation is keyed ['writeContract'], so the page can watch the very transaction
  // useCreateTask() put in front of the wallet — that is where the manifest hash being signed comes from.
  const writeStates = useMutationState<WriteSnapshot>({ filters: { mutationKey: ["writeContract"] }, select: (mutation) => ({ status: mutation.state.status, submittedAt: mutation.state.submittedAt, variables: mutation.state.variables as WriteVariables | undefined, hash: mutation.state.data as string | undefined }) });
  const write = useMemo(() => writeStates.filter((entry) => entry.submittedAt >= runStartedAt && entry.variables?.functionName === "createTask").sort((a, b) => b.submittedAt - a.submittedAt)[0], [writeStates, runStartedAt]);
  const spec = write?.variables?.args?.[0] as CreateSpec | undefined;
  const signedValue = write?.variables?.value;

  const stagePrepare: StageState = create.data ? "done" : write ? "done" : create.isPending ? "active" : create.error ? "failed" : "idle";
  const stageSign: StageState = write?.status === "pending" ? "active" : write?.status === "success" ? "done" : write?.status === "error" ? "failed" : create.error && write ? "failed" : "idle";
  const stageConfirm: StageState = create.data ? "done" : write?.status === "success" && create.isPending ? "active" : create.error && write?.status === "success" ? "failed" : "idle";

  const claimList = claims.map((claim) => claim.trim()).filter(Boolean);
  const sourceList = sources.map((source) => source.trim()).filter(Boolean);
  const bountyParsed = parseBounty(bounty);
  const issues = fieldIssues(create.error);
  const issueFor = (field: string) => issues.find((issue) => issue.field === field)?.message ?? null;

  const invalid = useMemo<string | null>(() => {
    if (title.trim().length < 3) return "The task needs a title of at least 3 characters.";
    if (question.trim().length < 3) return "The question the answer must support is required.";
    if (claimList.length === 0) return "Add at least one claim for the verifiers to check.";
    if (claimList.some((claim) => claim.length < 3)) return "Every claim needs at least 3 characters.";
    const badUrl = sourceList.map(badSource).find(Boolean);
    if (badUrl) return badUrl;
    if (verifierRange && (verifierCount < verifierRange.min || verifierCount > verifierRange.max)) return `The contract accepts ${verifierRange.min} to ${verifierRange.max} verifiers.`;
    if (bountyParsed.error) return bountyParsed.error;
    if (minBountyWei !== undefined && bountyParsed.wei !== null && bountyParsed.wei < minBountyWei) return `The protocol minimum bounty is ${formatEther(minBountyWei)} 0G.`;
    return null;
  }, [bountyParsed.error, bountyParsed.wei, claimList, minBountyWei, question, sourceList, title, verifierCount, verifierRange]);

  const blocked = !wallet.isConnected
    ? wallet.hasInjectedWallet ? "Connect a wallet — createTask escrows the bounty from your own account." : "No browser wallet detected, so nothing here can be signed."
    : wallet.isWrongNetwork ? `Wallet is on ${chainName(wallet.chainId)} — switch to ${NETWORK_NAME} (${ACTIVE_CHAIN_ID}) before signing.`
    : paused.isPaused ? "The contract is paused: createTask is blocked until it is unpaused."
    : invalid;

  const closeCreate = () => { setShowCreate(false); setPhase("form"); setRunStartedAt(Number.POSITIVE_INFINITY); setFrozen(null); create.reset(); };

  const submit = async () => {
    if (blocked || bountyParsed.wei === null) return;
    const request: PrepareTaskRequest = { title: title.trim(), question: question.trim(), claims: claimList, sources: sourceList.map((uri) => ({ uri })), verifierCount, bountyWei: bountyParsed.wei.toString() };
    setFrozen(request);
    setRunStartedAt(Date.now());
    setPhase("running");
    try {
      const result = await create.mutateAsync(request);
      toast.success("Task created", { description: `${shortHash(result.taskId)} · block ${result.blockNumber.toLocaleString("en-US")}` });
    } catch {
      /* the failure stays on screen in the stage panel, with the revert reason verbatim */
    }
  };

  const openCreated = () => { const taskId = create.data?.taskId; closeCreate(); if (taskId) navigate(`/task/${taskId}`); };

  /* ── render ──────────────────────────────────────────────────────────── */

  const statsFailed = Boolean(stats.error) && !stats.data;
  const strips = stats.data;

  return <DashboardLayout eyebrow="Workspace queue" title="Verification tasks">
    <div className="page-intro-row"><div><p className="page-intro">Track every claim from manifest preparation to final settlement. Filter by operational state or inspect a task’s evidence trail.</p></div><button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />Create verification task</button></div>
    <section className="task-summary-grid">{!strips && !statsFailed ? <><StatCardsSkeleton cards={1} className="summary-strip" /><StatCardsSkeleton cards={1} className="summary-strip sky-summary" /><StatCardsSkeleton cards={1} className="summary-strip coral-summary" /></> : <><div className="summary-strip" title="tasks.status in (Open, Committing)"><span className="summary-label">OPEN QUEUE</span><strong>{strips ? strips.openQueue : "—"}</strong><span>{strips ? strips.tasksNeedingReview > 0 ? `${strips.tasksNeedingReview} waiting on review` : "Nothing waiting on review" : errorCode(stats.error)}</span></div><div className="summary-strip sky-summary" title="tasks.status in (Revealing, Consensus)"><span className="summary-label">IN REVIEW</span><strong>{strips ? strips.inReview : "—"}</strong><span title={strips?.medianVerificationSec !== null && strips ? `median over ${plural(strips.medianVerificationSampleSize, "finalized task")}` : undefined}>{strips ? strips.medianVerificationSec === null ? "No task has settled yet" : `Median verification ${durationLabel(strips.medianVerificationSec)}` : errorCode(stats.error)}</span></div><div className="summary-strip coral-summary" title="display groups CONFLICT, NO QUORUM and DISPUTED — settled without agreement, or under challenge"><span className="summary-label">NO CONSENSUS</span><strong>{strips ? strips.conflict + strips.noQuorum + strips.disputed : "—"}</strong><span>{strips ? strips.disputed > 0 ? "Needs adjudication" : "No dispute open" : errorCode(stats.error)}</span></div></>}</section>
    <section className="section-block page-section"><div className="toolbar-row"><div className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task IDs, claims, or sources" /></div><div className="filter-tabs">{FILTERS.map((item) => <button className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)}>{item === "ALL" ? "All tasks" : item.toLowerCase()}</button>)}</div></div><div className="task-table task-table-wide"><div className="task-table-head"><span>Task</span><span>Status</span><span>Agreement</span><span>Bounty</span><span>Updated</span><span /></div>{tasks.isPending && !tasks.data ? <TaskRowsSkeleton rows={5} /> : tasks.error && !tasks.data ? <ErrorState error={tasks.error} onRetry={() => { void tasks.refetch(); }} retrying={tasks.isFetching} /> : items.map((task) => <button className="task-row" key={task.taskId} onClick={() => navigate(`/task/${task.taskId}`)} title={task.syncRequired ? `${task.taskId} — the read model disagrees with the chain; POST /v1/tasks/${task.taskId}/sync` : task.taskId}><div className="task-main"><div className={`task-id task-${task.tone}`} title={`${task.taskId} · the ${task.ref} handle is assigned by the indexer, not by the contract`}>{task.ref}</div><div><strong>{task.title}</strong><span><GitBranch size={12} />{sourceLabel(task)}</span></div></div><Pill tone={task.tone}>{task.status}</Pill><div className="agreement" title={`derived: ${task.committedCount} committed / ${task.revealedCount} revealed of ${plural(task.verifierCount, "verifier")}`}><div className="progress-track"><span style={{ width: `${task.agreementPct}%` }} className={`progress-fill fill-${task.tone}`} /></div><span>{task.agreementLabel}</span></div><div className="task-bounty"><strong title={`${task.bountyWei} wei escrowed onchain`}>{task.bountyFormatted}</strong><span>{plural(task.verifierCount, "verifier")}</span></div><div className="task-time"><strong title={task.updatedAt}>{relativeTime(task.updatedAt, new Date(now))}</strong><span>{statusCaption(task)}</span></div><ChevronDown size={17} className="row-chevron" /></button>)}{!tasks.isPending && !tasks.error && items.length === 0 && (filtering ? <EmptyState>No matching verification tasks.</EmptyState> : typeof health.data?.indexer.lastBlock === "number" ? <EmptyStateBlock title="No tasks indexed yet">{`The indexer is at block ${health.data.indexer.lastBlock.toLocaleString("en-US")} and has not seen a TaskCreated log. The first task created here appears in this table.`}</EmptyStateBlock> : <IndexingState indexedBlock={health.data?.indexer.lastBlock ?? null} />)}</div></section>
    <section className="section-block workflow-card"><div className="workflow-copy"><div className="eyebrow">HOW A TASK MOVES</div><h2>Claim → evidence → settlement</h2><p>{selected ? `${selected.ref} · ${selected.status} · ${selected.agreementLabel}. Each step below is lit by that task's onchain status, not by a clock.` : routeTaskId && selectedQuery.isPending ? "Reading the task from the index…" : routeTaskId && selectedQuery.error ? `${errorCode(selectedQuery.error)} — ${errorMessage(selectedQuery.error)}` : "Open a task to follow it through the protocol lifecycle; the steps below light from its onchain status."}</p></div><div className="workflow-steps"><div><span className={`workflow-number ${stepClass(steps.manifest, "lime-step")}`}>01</span><strong>Manifest</strong><small title={selected?.manifestHash}>{selected ? `Manifest ${shortHash(selected.manifestHash)} pinned` : "Source snapshot pinned"}</small></div><div><span className={`workflow-number ${stepClass(steps.verify, "sky-step")}`}>02</span><strong>Verify</strong><small>{selected ? selected.revealedCount > 0 ? `${selected.revealedCount}/${selected.verifierCount} reports revealed` : `${selected.committedCount}/${selected.verifierCount} commits accepted` : "Independent reports revealed"}</small></div><div><span className={`workflow-number ${stepClass(steps.settle, "coral-step")}`}>03</span><strong>Settle</strong><small>{selected ? selected.status === "VERIFIED" ? `Finalized · ${selected.agreementLabel}` : selected.status === "CONFLICT" ? `Settled without consensus · ${selected.agreementLabel}` : selected.status === "NO QUORUM" ? "Settled · too few reveals" : selected.status === "DISPUTED" ? selected.hasDispute ? "Challenge open · needs adjudication" : selected.agreementLabel : selected.status === "EXPIRED" ? "Expired without a result" : selected.status === "CANCELLED" ? "Cancelled by the creator" : selected.rawStatus === "CONSENSUS" ? `Dispute window ${countdown(selected.disputeDeadline, now)}` : "Not settled yet" : "Agreement or dispute"}</small></div></div></section>
    {showCreate && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !create.isPending) closeCreate(); }}><div className="modal-card modal-card-split"><div className="modal-head"><div><span className="eyebrow">New verification request</span><h2>Post a claim for proof.</h2></div><button className="icon-button" onClick={closeCreate} disabled={create.isPending}><X size={18} /></button></div><p className="modal-copy">The API snapshots every source, screens the text, and pins the manifest to 0G Storage. Your wallet then signs <code>createTask</code> and escrows the bounty — nothing is signed before the manifest hash below exists.</p>
      <div className="modal-body">{phase === "form" ? <div className="form-grid">
        <label className="field full"><span>Claim or task title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Verify a release claim" />{issueFor("title") && <span className="field-error">{issueFor("title")}</span>}</label>
        <label className="field full"><span>Question the answer must support</span><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="e.g. Is 0G Storage usable without the chain?" />{issueFor("question") && <span className="field-error">{issueFor("question")}</span>}</label>
        <div className="field full"><span>Public source URL</span><div className="field-rows">{sources.map((source, index) => <div className="field-row" key={`source-${index}`}><input value={source} onChange={(event) => setSources((current) => current.map((entry, position) => (position === index ? event.target.value : entry)))} placeholder="https://docs.example.com/source" />{sources.length > 1 && <button type="button" className="icon-button tiny" onClick={() => setSources((current) => current.filter((_, position) => position !== index))} aria-label="Remove source"><X size={14} /></button>}{issueFor(`sources.${index}.uri`) && <span className="field-error">{issueFor(`sources.${index}.uri`)}</span>}</div>)}{sources.length < 20 && <button type="button" className="quiet-button field-add" onClick={() => setSources((current) => [...current, ""])}><Plus size={13} />Add source</button>}</div><span className="field-hint">Each URL is fetched once, hashed, and stored as a snapshot; a dead source is recorded as unavailable rather than dropped.</span></div>
        <div className="field full"><span>Claims to verify</span><div className="field-rows">{claims.map((claim, index) => <div className="field-row" key={`claim-${index}`}><input value={claim} onChange={(event) => setClaims((current) => current.map((entry, position) => (position === index ? event.target.value : entry)))} placeholder="e.g. 0G Storage is available as a standalone service" />{claims.length > 1 && <button type="button" className="icon-button tiny" onClick={() => setClaims((current) => current.filter((_, position) => position !== index))} aria-label="Remove claim"><X size={14} /></button>}{issueFor(`claims.${index}`) && <span className="field-error">{issueFor(`claims.${index}`)}</span>}</div>)}{claims.length < 50 && <button type="button" className="quiet-button field-add" onClick={() => setClaims((current) => [...current, ""])}><Plus size={13} />Add claim</button>}</div><span className="field-hint">This list is frozen into the manifest hash you sign; verifiers rule on exactly these sentences.</span></div>
        <label className="field"><span>Verifier count</span><div className="field-static" title="MIN_VERIFIERS() / MAX_VERIFIERS(), read from the contract"><select value={verifierCount} onChange={(event) => setVerifierCount(Number(event.target.value))} disabled={!verifierRange}>{verifierRange ? Array.from({ length: verifierRange.max - verifierRange.min + 1 }, (_, index) => verifierRange.min + index).map((count) => <option key={count} value={count}>{plural(count, "independent verifier")}</option>) : <option value={verifierCount}>reading the contract…</option>}</select><ChevronDown size={15} /></div></label>
        <label className="field"><span>Bounty</span><div className="input-with-suffix"><input value={bounty} onChange={(event) => setBounty(event.target.value)} placeholder={minBountyWei === undefined ? "0.001" : `min ${formatEther(minBountyWei)}`} /><span>0G</span></div><span className="field-hint">{minBountyWei === undefined ? protocolParams.error ? "params() could not be read from the contract." : <Skeleton width={122} height={8} /> : `Protocol minimum ${formatEther(minBountyWei)} 0G · escrowed until the task settles.`}</span></label>
      </div> : <div className="tx-stages">
        <div className={`tx-stage stage-${stagePrepare}`}><span className="tx-stage-mark">{markFor(stagePrepare)}</span><div><strong>{stagePrepare === "done" ? "Manifest prepared" : stagePrepare === "failed" ? "Preparation refused" : "Preparing the manifest"}</strong><p>POST /v1/tasks/prepare snapshots every source, screens the text for personal data, and pins the manifest to 0G Storage.</p>{create.data && <div className="tx-facts"><div className="tx-fact"><span>manifest</span><strong>{create.data.prepared.manifestHash}</strong></div><div className="tx-fact"><span>pointer</span><strong>{create.data.prepared.manifestPointer}</strong></div>{create.data.prepared.sources.map((source) => <div className="tx-fact" key={source.sourceId}><span>{source.sourceId}</span><strong>{source.status} · {source.uri}</strong></div>)}</div>}{create.data?.prepared.warnings.map((warning) => <p className="tx-error" key={warning}>{warning}</p>)}{stagePrepare === "failed" && <p className="tx-error">{failureLines(create.error).headline}</p>}</div></div>
        <div className={`tx-stage stage-${stageSign}`}><span className="tx-stage-mark">{markFor(stageSign)}</span><div><strong>{stageSign === "done" ? "Escrow signed" : stageSign === "failed" ? "Signature refused" : stageSign === "active" ? "Waiting for your signature" : "Sign the escrow"}</strong><p>{spec ? "These are the exact bytes your wallet was handed. The manifest hash freezes the claim list below — if it is not what you meant to commit to, reject the transaction." : "Nothing reaches the wallet until the manifest exists."}</p>{spec && <div className="tx-facts"><div className="tx-fact"><span>manifest hash</span><strong>{spec.manifestHash}</strong></div><div className="tx-fact"><span>pointer</span><strong>{spec.manifestPointer}</strong></div><div className="tx-fact"><span>rule</span><strong>{spec.ruleId}</strong></div><div className="tx-fact"><span>verifiers</span><strong>{spec.verifierCount}</strong></div><div className="tx-fact"><span>windows</span><strong>commit {windowLabel(spec.commitWindowSec)} · reveal {windowLabel(spec.revealWindowSec)} · dispute {windowLabel(spec.disputeWindowSec)}</strong></div><div className="tx-fact"><span>escrow</span><strong>{signedValue === undefined ? "—" : `${formatEther(signedValue)} 0G`}</strong></div></div>}{spec && frozen && <ol className="tx-claims">{frozen.claims.map((claim, index) => <li key={`frozen-${index}`}>{claim}</li>)}</ol>}{stageSign === "failed" && <><p className="tx-error">{failureLines(create.error).headline}</p>{failureLines(create.error).body && <p className="tx-error">{failureLines(create.error).body}</p>}</>}</div></div>
        <div className={`tx-stage stage-${stageConfirm}`}><span className="tx-stage-mark">{markFor(stageConfirm)}</span><div><strong>{stageConfirm === "done" ? "Confirmed onchain" : stageConfirm === "failed" ? "Not confirmed" : stageConfirm === "active" ? "Waiting for the receipt" : "Confirm onchain"}</strong><p>{write?.hash ? `${NETWORK_NAME} answers with a not-found for a while after a transaction lands, so the receipt is retried rather than reported as a failure.` : "The receipt names the taskId the contract minted."}</p>{write?.hash && <div className="tx-facts"><div className="tx-fact"><span>tx</span><strong>{explorerTxUrl(write.hash) ? <a className="tx-link" href={explorerTxUrl(write.hash) ?? undefined} target="_blank" rel="noopener noreferrer">{write.hash}</a> : write.hash}</strong></div>{create.data && <><div className="tx-fact"><span>task</span><strong>{create.data.taskId}</strong></div><div className="tx-fact"><span>block</span><strong>{create.data.blockNumber.toLocaleString("en-US")}</strong></div><div className="tx-fact"><span>index</span><strong>{create.data.synced ? "synced" : "not synced yet — the indexer will pick it up on its own pass"}</strong></div></>}</div>}{stageConfirm === "failed" && <><p className="tx-error">{failureLines(create.error).headline}</p>{failureLines(create.error).body && <p className="tx-error">{failureLines(create.error).body}</p>}</>}</div></div>
      </div>}</div>
      <div className="modal-foot"><span className="modal-note"><ShieldCheck size={15} />{phase === "running" ? create.data ? "Escrowed onchain · the manifest is public and content-addressed" : create.error ? write?.status === "success" ? "The transaction was sent — open it on the explorer before signing another" : "Nothing was escrowed — no value left your wallet" : "Public data only · no private inputs stored" : blocked ?? "Public data only · no private inputs stored"}</span>{phase === "running" && create.data ? <button className="primary-button" onClick={openCreated}>Open task <ArrowUpRight size={16} /></button> : phase === "running" && create.error ? <button className="primary-button" onClick={() => { setPhase("form"); setRunStartedAt(Number.POSITIVE_INFINITY); }}>Edit and retry <ArrowUpRight size={16} /></button> : <button className="primary-button" onClick={() => { void submit(); }} disabled={Boolean(blocked) || create.isPending} title={blocked ?? undefined}>{create.isPending ? stageConfirm === "active" ? "Confirming…" : stageSign === "active" ? "Waiting for signature…" : "Preparing manifest…" : "Create task"} <ArrowUpRight size={16} /></button>}</div>
    </div></div>}
  </DashboardLayout>;
}
