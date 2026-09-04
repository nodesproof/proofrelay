// Evidence Ledger design: the verifier network turns opaque AI checks into inspectable operators with health and accountability.
// Nothing on this page is a literal any more. The four overview cards, the directory rows, the 24-bucket
// sparkline and the signal feed all come from GET /v1/verifiers; the selected operator's stake, approval
// and metadata pointer are re-read from getVerifier() onchain and marked as chain-sourced; the slashing
// caption reflects the real params().verifierSlashBps; and "Register verifier" is a real registerVerifier
// transaction that says plainly that an admin allow-list entry is still required afterwards.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useReadContract } from "wagmi";
import { Activity, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Copy, ExternalLink, Fingerprint, MoreHorizontal, Plus, ShieldCheck, SlidersHorizontal, Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { EmptyStateBlock, ErrorState, SignalRowsSkeleton, Skeleton, StatCardsSkeleton, UptimeBarsSkeleton, VerifierRowsSkeleton, errorMessage, writeErrorMessage } from "@/components/states";
import { POLL_MS, useHealth, useOnchainVerifier, usePaused, useProtocolParams, useTxRunner, useVerifiers, useWallet } from "@/hooks/useProofRelay";
import { PROOFRELAY_ADDRESS, proofRelayAbi } from "@/lib/contract";
import { ACTIVE_CHAIN_ID, EXPLORER_URL, NETWORK_NAME, explorerTxUrl } from "@/lib/wagmi";
import type { Address, Bytes32, VerifierView } from "@/lib/types";
import { explorerAddressUrl, formatToken, percentLabel, sameAddress, toChecksumAddress, utcClock } from "@/lib/format";

/** A verifier that registered without a metadata object carries this hash onchain. */
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** The design's own sparkline threshold, applied to the real bucket value (FRONTEND_DATA_CONTRACT §1.4). */
const UPTIME_WARNING_PCT = 95;
/** The panel draws exactly 24 buckets; a shorter series is left-padded with "no data" stubs, never with 100. */
const UPTIME_BUCKETS = 24;
/** VerifierStatus, as the API defines it — these are the values `GET /v1/verifiers?status=` accepts. */
const STATUS_FILTERS: Array<{ label: string; value: string }> = [{ label: "All verifiers", value: "" }, { label: "Online", value: "ONLINE" }, { label: "Degraded", value: "DEGRADED" }, { label: "Offline", value: "OFFLINE" }, { label: "Awaiting approval", value: "PENDING" }];

type OpenMenu = "filters" | "operator" | null;

function avatarTone(tone: string): string {
  return tone === "lime" ? "lime-avatar" : tone === "sky" ? "sky-avatar" : tone === "coral" ? "coral-avatar" : "ink-avatar";
}

function statusTone(status: string): string {
  return status === "ONLINE" ? "status-online" : status === "DEGRADED" ? "status-degraded" : status === "PENDING" ? "status-pending" : "status-offline";
}

/** The design's avatar is two characters; the address is the only real identity a verifier has. */
function addressInitials(address: string): string {
  return (toChecksumAddress(address) ?? address).slice(2, 4).toUpperCase();
}

/** modelId only exists once the verifier has revealed a report — before that there is nothing to name. */
function modelLabel(verifier: VerifierView): string | null {
  if (!verifier.modelId) return null;
  return verifier.pipelineVersion ? `${verifier.modelId} · ${verifier.pipelineVersion}` : verifier.modelId;
}

function latencyLabel(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : `${Math.round(ms)}ms`;
}

/** The signal column is a clock, not a duration; the full ISO stays on the title. */
function clockLabel(iso: string): string {
  try {
    return utcClock(iso).slice(0, 5);
  } catch {
    return "—";
  }
}

function trendLabel(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export default function VerifierNetwork() {
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedAddress, setSelectedAddress] = useState<Address | null>(null);
  const [menu, setMenu] = useState<OpenMenu>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [form, setForm] = useState({ metadataHash: "", metadataPointer: "", stake: "" });
  const [busy, setBusy] = useState<"register" | "active" | "approval" | null>(null);

  const verifiers = useVerifiers({ status: statusFilter || undefined });
  const health = useHealth();
  const wallet = useWallet();
  const paused = usePaused();
  const params = useProtocolParams();

  const summary = verifiers.data?.summary;
  const items = useMemo(() => verifiers.data?.items ?? [], [verifiers.data?.items]);
  const events = verifiers.data?.events ?? [];
  const current = useMemo(() => items.find((verifier) => sameAddress(verifier.address, selectedAddress)) ?? items[0], [items, selectedAddress]);

  /** getVerifier(address): the authoritative approved/active/stake/metadata truth behind the selected row. */
  const onchain = useOnchainVerifier(current?.address);
  const chainRecord = onchain.data;

  const explorer = health.data?.explorer || EXPLORER_URL;
  const checksummedCurrent = current ? toChecksumAddress(current.address) : null;
  const isSelf = Boolean(current && sameAddress(wallet.address, current.address));

  /** params() is 10 numerics; verifierSlashBps is the fifth and minVerifierStake the seventh. */
  const paramTuple = params.data as readonly [number, number, number, number, number, bigint, bigint, number, number, number] | undefined;
  const slashBps = paramTuple ? Number(paramTuple[4]) : null;
  const minVerifierStake = paramTuple ? paramTuple[6] : null;
  const maxPointerBytes = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "MAX_POINTER_BYTES", chainId: ACTIVE_CHAIN_ID, query: { staleTime: Infinity, gcTime: Infinity } });
  const pointerLimit = maxPointerBytes.data === undefined ? null : Number(maxPointerBytes.data);

  /** setVerifierApproval is DEFAULT_ADMIN-gated, so the role id is read from the deployment rather than assumed. */
  const adminRole = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "DEFAULT_ADMIN_ROLE", chainId: ACTIVE_CHAIN_ID, query: { staleTime: Infinity, gcTime: Infinity } });
  const adminCheck = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "hasRole", args: adminRole.data && wallet.address ? [adminRole.data, wallet.address] : undefined, chainId: ACTIVE_CHAIN_ID, query: { enabled: Boolean(adminRole.data && wallet.address), refetchInterval: 60_000 } });
  const isAdmin = adminCheck.data === true;

  // The same runner every other write path uses: the network's tip floor, the
  // receipt retry, and the revert-reason replay all live in one place so this page
  // cannot drift away from TaskDetail and VerificationTasks.
  const { writeContractAsync, feeOverrides, confirm: confirmTx } = useTxRunner();

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => { const target = event.target as HTMLElement | null; if (target && target.closest("[data-menu-root]")) return; setMenu(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  /** Why a write cannot be signed right now, in the words the user can act on. */
  const walletBlocker = (): string | null => {
    if (!wallet.isConnected) return "This needs a connected wallet: it is a transaction your own address signs.";
    if (wallet.isWrongNetwork) return `The wallet is on another chain. Switch it to ${NETWORK_NAME} (chain ${ACTIVE_CHAIN_ID}) before signing.`;
    return null;
  };

  const registerBlocker = ((): string | null => {
    const connection = walletBlocker();
    if (connection) return connection;
    if (paused.isPaused) return "The contract is paused, so registerVerifier will revert. Registration reopens when a PAUSER holder unpauses it.";
    if (!/^0x[0-9a-fA-F]{64}$/.test(form.metadataHash.trim())) return "Metadata hash must be a 0x-prefixed 32-byte hash — the canonical hash of the metadata object you uploaded.";
    const pointer = form.metadataPointer.trim();
    if (!pointer) return "A metadata pointer is required: local://<hex> under the local driver, or the 0G Storage root under zerog.";
    const pointerBytes = new TextEncoder().encode(pointer).length;
    if (pointerLimit !== null && pointerBytes > pointerLimit) return `The pointer is ${pointerBytes} bytes; MAX_POINTER_BYTES() on this deployment is ${pointerLimit}.`;
    const stake = form.stake.trim();
    if (stake && !/^\d*(\.\d+)?$/.test(stake)) return "Stake must be a plain decimal amount of 0G.";
    if (minVerifierStake !== null && stakeWei() < minVerifierStake) return `params().minVerifierStake is ${formatToken(minVerifierStake)} on this deployment; the stake sent must be at least that.`;
    return null;
  })();

  function stakeWei(): bigint {
    const raw = form.stake.trim();
    if (!raw || !/^\d*(\.\d+)?$/.test(raw)) return 0n;
    const [whole, fraction = ""] = raw.split(".");
    return BigInt(`${whole || "0"}${fraction.padEnd(18, "0").slice(0, 18)}`);
  }

  const submitRegistration = async () => {
    if (!wallet.isConnected) { try { await wallet.connect(); } catch (error) { toast.error("Wallet not connected", { description: writeErrorMessage(error, "The wallet rejected the connection.") }); } return; }
    if (wallet.isWrongNetwork) { try { await wallet.switchNetwork(); } catch (error) { toast.error("Network not switched", { description: writeErrorMessage(error, `The wallet refused to switch to ${NETWORK_NAME}.`) }); } return; }
    if (registerBlocker) { toast.error("Registration not sent", { description: registerBlocker }); return; }
    setBusy("register");
    try {
      const hash = await writeContractAsync({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "registerVerifier", args: [form.metadataHash.trim() as Bytes32, form.metadataPointer.trim()], value: stakeWei(), chainId: ACTIVE_CHAIN_ID, ...(await feeOverrides()) });
      toast("Registration submitted", { description: explorerTxUrl(hash) ?? hash });
      await confirmTx(hash);
      toast.success("Verifier registered onchain", { description: "You are registered but not yet approved. ProofRelay's MVP sybil defence is an admin allow-list: a DEFAULT_ADMIN holder must call setVerifierApproval(you, true) before the dispatcher can assign you a task. Until then the directory lists you as PENDING." });
      setRegisterOpen(false);
      setForm({ metadataHash: "", metadataPointer: "", stake: "" });
      verifiers.refetch();
      onchain.refetch();
    } catch (error) {
      toast.error("Registration failed", { description: writeErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  /** setVerifierActive(bool) is self-service: only the verifier's own key can pause or resume itself. */
  const toggleActive = async () => {
    if (!current) return;
    const blocker = walletBlocker();
    if (blocker) { toast.error("Not signed", { description: blocker }); return; }
    const next = !(chainRecord?.active ?? current.active);
    setMenu(null);
    setBusy("active");
    try {
      const hash = await writeContractAsync({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "setVerifierActive", args: [next], chainId: ACTIVE_CHAIN_ID, ...(await feeOverrides()) });
      toast(next ? "Resuming verifier" : "Pausing verifier", { description: explorerTxUrl(hash) ?? hash });
      await confirmTx(hash);
      toast.success(next ? "Verifier active" : "Verifier paused", { description: `setVerifierActive(${next}) confirmed onchain.` });
      verifiers.refetch();
      onchain.refetch();
    } catch (error) {
      toast.error("Transaction failed", { description: writeErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  /** setVerifierApproval(address,bool) is the allow-list itself, and only DEFAULT_ADMIN can move it. */
  const toggleApproval = async () => {
    if (!current) return;
    const blocker = walletBlocker();
    if (blocker) { toast.error("Not signed", { description: blocker }); return; }
    const next = !(chainRecord?.approved ?? current.approved);
    setMenu(null);
    setBusy("approval");
    try {
      const hash = await writeContractAsync({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "setVerifierApproval", args: [current.address, next], chainId: ACTIVE_CHAIN_ID, ...(await feeOverrides()) });
      toast(next ? "Approving verifier" : "Revoking approval", { description: explorerTxUrl(hash) ?? hash });
      await confirmTx(hash);
      toast.success(next ? "Verifier approved" : "Approval revoked", { description: `setVerifierApproval(${current.shortAddress}, ${next}) confirmed onchain.` });
      verifiers.refetch();
      onchain.refetch();
    } catch (error) {
      toast.error("Transaction failed", { description: writeErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const copyValue = async (label: string, value: string | null | undefined) => {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    toast.success(`${label} copied`, { description: value });
  };

  const openOperatorExplorer = () => {
    const url = explorerAddressUrl(explorer, checksummedCurrent);
    setMenu(null);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  /** The overview cards: every one of the four is a real aggregate, including the zeroes. */
  const agreement = percentLabel(summary?.networkAgreementPct ?? null, 1);
  const agreementTrend = trendLabel(summary?.networkAgreementTrendPct ?? null);
  const networkLatency = latencyLabel(summary?.medianLatencyMs ?? null);
  const slashingCaption = slashBps === null ? (summary ? (summary.slashingEnabled ? "Slashing enabled" : "Slashing disabled") : "") : slashBps === 0 ? "Slashing disabled (slashBps 0)" : `Slash rate ${slashBps / 100}%`;

  /** 24 buckets, right-aligned on the newest; anything the series does not cover is a grey stub, never 100. */
  const buckets = useMemo<Array<number | null>>(() => {
    const series = current?.uptimeSeries ?? [];
    return Array.from({ length: UPTIME_BUCKETS }, (_, index) => {
      const value = series[series.length - UPTIME_BUCKETS + index];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    });
  }, [current?.uptimeSeries]);

  const metadataHash = chainRecord?.metadataHash ?? current?.metadataHash ?? null;
  const metadataPointer = chainRecord?.metadataPointer ?? current?.metadataPointer ?? null;
  const hasMetadata = Boolean(metadataHash && metadataHash !== ZERO_BYTES32);

  const streamLabel = verifiers.isError ? "reconnecting" : verifiers.isFetching ? "syncing" : "polling";
  const streamDot = verifiers.isError ? "dot-coral" : verifiers.isFetching ? "dot-sky" : "";
  const loadFailed = Boolean(verifiers.error) && !verifiers.data;
  const activeFilter = STATUS_FILTERS.find((option) => option.value === statusFilter);

  return <DashboardLayout eyebrow="Network operations" title="Verifier network">
    <div className="page-intro-row"><p className="page-intro">Inspect the independent workers that turn claims into evidence. Health, model version, agreement, and stake are visible before a report settles.</p><button className="primary-button" onClick={() => setRegisterOpen(true)}><Plus size={17} />Register verifier</button></div>
    {loadFailed ? <section className="section-block"><ErrorState error={verifiers.error} onRetry={() => verifiers.refetch()} retrying={verifiers.isFetching} /></section> : <>
      <section className="network-overview-grid">{summary ? <><div className="network-overview-card" title={`${summary.active} approved and active of ${items.length} listed`}><div className="eyebrow">ACTIVE VERIFIERS</div><strong>{summary.active}</strong><span><span className="live-dot" />{summary.online} online · {summary.degraded} degraded</span></div><div className="network-overview-card sky-overview" title="Mean consensus agreementBps across recently settled tasks"><div className="eyebrow">NETWORK AGREEMENT</div><strong>{agreement ?? "—"}</strong>{agreement === null ? <span>No settled task to measure yet</span> : agreementTrend ? <span><ArrowUpRight size={13} />{agreementTrend} vs previous window</span> : <span>No previous window to compare</span>}</div><div className="network-overview-card ink-overview" title="Sum of getVerifier(a).stake across every registered verifier"><div className="eyebrow">TOTAL STAKED</div><strong>{summary.totalStakedFormatted}</strong><span><ShieldCheck size={13} />{slashingCaption}</span></div><div className="network-overview-card coral-overview" title="Median of verifier-report compute[].latencyMs — self-reported inside the report artifact"><div className="eyebrow">MEDIAN LATENCY</div><strong>{networkLatency ?? "—"}</strong><span><Zap size={13} />{networkLatency ? "Self-reported in verifier reports" : "No revealed report to measure"}</span></div></> : <><StatCardsSkeleton cards={1} className="network-overview-card" /><StatCardsSkeleton cards={1} className="network-overview-card sky-overview" /><StatCardsSkeleton cards={1} className="network-overview-card ink-overview" /><StatCardsSkeleton cards={1} className="network-overview-card coral-overview" /></>}</section>
      <div className="network-layout"><section className="section-block verifier-directory"><div className="section-header"><div><div className="eyebrow">VERIFIER DIRECTORY</div><h2>Independent operators</h2></div><div className="topbar-anchor" data-menu-root><button className="quiet-button" onClick={() => setMenu(menu === "filters" ? null : "filters")}><SlidersHorizontal size={14} /> {statusFilter ? `Filters · ${activeFilter?.label ?? statusFilter}` : "Filters"}</button>{menu === "filters" && <div className="topbar-pop"><div className="topbar-pop-head"><span>Status</span><span>{items.length} shown</span></div><div className="topbar-pop-actions">{STATUS_FILTERS.map((option) => <button key={option.value || "all"} onClick={() => { setStatusFilter(option.value); setMenu(null); }}>{option.value === statusFilter ? <CheckCircle2 size={13} /> : <span className="pop-bullet" />}{option.label}</button>)}</div><p className="topbar-pop-note">Sent to the API as GET /v1/verifiers?status=…</p></div>}</div></div><div className="verifier-directory-list">{verifiers.isPending ? <VerifierRowsSkeleton rows={3} /> : items.length === 0 ? <EmptyStateBlock title={statusFilter ? "No verifiers match this filter" : "No verifiers registered yet"} actionLabel={statusFilter ? "Clear filter" : undefined} onAction={statusFilter ? () => setStatusFilter("") : undefined}>{statusFilter ? "Every registered operator is listed under “All verifiers”." : "Operators appear here once registerVerifier has been called and the indexer has recorded the VerifierRegistered log."}</EmptyStateBlock> : items.map((verifier) => <button className={`verifier-directory-row ${sameAddress(verifier.address, current?.address) ? "selected" : ""}`} key={verifier.address} onClick={() => { setSelectedAddress(verifier.address); setMenu(null); }}><div className={`verifier-avatar ${avatarTone(verifier.tone)}`}>{addressInitials(verifier.address)}</div><div className="verifier-directory-main"><strong>{verifier.name}</strong><span title={toChecksumAddress(verifier.address) ?? verifier.address}>{verifier.shortAddress} · {modelLabel(verifier) ?? "no report revealed yet"}</span></div><div className="directory-stat"><span>AGREEMENT</span><strong>{percentLabel(verifier.agreementPct, 1) ?? "—"}</strong></div><div className="directory-stat"><span>UPTIME</span><strong>{percentLabel(verifier.uptimePct, 1) ?? "—"}</strong></div><div className={`directory-status ${statusTone(verifier.status)}`} title={`registered ${verifier.registered} · approved ${verifier.approved} · active ${verifier.active}${verifier.lastSeenAt ? ` · last reveal ${verifier.lastSeenAt}` : " · no reveal yet"}`}><span className="pill-dot" />{verifier.status}</div><ChevronDown size={16} className="row-chevron" /></button>)}</div></section><aside className="network-detail-card"><div className="side-card-head"><div><div className="eyebrow">SELECTED OPERATOR</div><h3>{current ? current.name : verifiers.isPending ? <Skeleton width={128} height={17} /> : "—"}</h3></div><div className="topbar-anchor" data-menu-root><button className="icon-button tiny" onClick={() => setMenu(menu === "operator" ? null : "operator")} disabled={!current}><MoreHorizontal size={16} /></button>{menu === "operator" && current && <div className="topbar-pop"><div className="topbar-pop-head"><span>Operator</span><span>{current.status}</span></div><div className="topbar-pop-row"><span>Approved</span><strong>{chainRecord ? String(chainRecord.approved) : <Skeleton width={38} height={9} />}</strong></div><div className="topbar-pop-row"><span>Active</span><strong>{chainRecord ? String(chainRecord.active) : <Skeleton width={38} height={9} />}</strong></div><div className="topbar-pop-row"><span>Slashed</span><strong>{chainRecord ? formatToken(chainRecord.slashed) : <Skeleton width={58} height={9} />}</strong></div><div className="topbar-pop-actions"><button onClick={() => { setMenu(null); copyValue("Address", checksummedCurrent); }}><Copy size={13} />Copy address</button><button onClick={openOperatorExplorer}><ExternalLink size={13} />View on explorer</button><button onClick={toggleActive} disabled={!isSelf || busy !== null} title={isSelf ? "setVerifierActive(bool) — self-service" : "Only this verifier's own key can pause or resume it."}><Activity size={13} />{busy === "active" ? "Signing…" : (chainRecord?.active ?? current.active) ? "Pause this verifier" : "Resume this verifier"}</button><button onClick={toggleApproval} disabled={!isAdmin || busy !== null} title={isAdmin ? "setVerifierApproval(address,bool) — DEFAULT_ADMIN only" : "setVerifierApproval is DEFAULT_ADMIN-gated; this wallet does not hold that role."}><ShieldCheck size={13} />{busy === "approval" ? "Signing…" : (chainRecord?.approved ?? current.approved) ? "Revoke approval" : "Approve verifier"}</button></div></div>}</div></div>{current ? <><div className="operator-identity"><div className={`verifier-avatar large-avatar ${avatarTone(current.tone)}`}>{addressInitials(current.address)}</div><div><strong title={checksummedCurrent ?? current.address}>{current.shortAddress}</strong><span>{current.role}</span></div></div><div className="operator-metrics"><div><span>Model version</span><strong title={current.modelId ? `${current.modelId}${current.pipelineVersion ? ` · pipeline ${current.pipelineVersion}` : ""} — from this verifier's latest revealed report` : "modelId only exists after revealReport"}>{modelLabel(current) ?? "No report revealed yet"}</strong></div><div><span>Stake locked</span><strong className={chainRecord ? "chain-value" : undefined} title={chainRecord ? `getVerifier(${checksummedCurrent ?? current.address}).stake — read from chain ${ACTIVE_CHAIN_ID}${chainRecord.slashed > 0n ? ` · slashed ${formatToken(chainRecord.slashed)}` : ""}` : "from the read model; the onchain read has not landed yet"}>{chainRecord ? formatToken(chainRecord.stake) : onchain.isPending ? <Skeleton width={64} height={9} /> : current.stakeFormatted}</strong></div><div><span>Median latency</span><strong title="Median of compute[].latencyMs across this verifier's revealed reports — self-reported">{latencyLabel(current.medianLatencyMs) ?? "Not reported"}</strong></div></div><div className="uptime-panel"><div><span>30-day uptime</span><strong>{percentLabel(current.uptimePct, 1) ?? "—"}</strong></div>{verifiers.isPending ? <UptimeBarsSkeleton /> : <div className="uptime-bars">{buckets.map((value, index) => <i key={index} style={{ height: value === null ? "8%" : `${Math.max(3, Math.min(100, value))}%` }} className={value === null ? "bar-empty" : value < UPTIME_WARNING_PCT ? "bar-warning" : ""} title={value === null ? "No commits in this bucket" : `${value.toFixed(1)}% revealed`} />)}</div>}</div><button className="secondary-button full-button" onClick={() => setMetadataOpen(true)}><Fingerprint size={15} />Inspect verifier metadata <ExternalLink size={13} /></button></> : verifiers.isPending ? <><div className="operator-identity"><Skeleton className="sk-round" width={39} height={39} /><div><Skeleton width={92} height={10} /><Skeleton width={72} height={9} /></div></div><div className="operator-metrics"><div><span>Model version</span><Skeleton width={104} height={9} /></div><div><span>Stake locked</span><Skeleton width={64} height={9} /></div><div><span>Median latency</span><Skeleton width={48} height={9} /></div></div><div className="uptime-panel"><div><span>30-day uptime</span><Skeleton width={44} height={10} /></div><UptimeBarsSkeleton /></div></> : <EmptyStateBlock title="No operator to inspect">A registered verifier has to exist before its model, stake and reveal history can be read.</EmptyStateBlock>}</aside></div>
      <section className="section-block verifier-events"><div className="section-header"><div><div className="eyebrow">NETWORK SIGNALS</div><h2>Latest verifier events</h2></div><span className="small-status" title={verifiers.error ? errorMessage(verifiers.error) : `GET /v1/verifiers every ${POLL_MS.verifiers / 1000}s — no event stream is open on this deployment`}><span className={`live-dot ${streamDot}`} />{streamLabel}</span></div><div className="signal-table"><div className="signal-head"><span>Event</span><span>Operator</span><span>Task</span><span>Time</span><span /></div>{verifiers.isPending ? <SignalRowsSkeleton rows={3} /> : events.length === 0 ? <EmptyStateBlock title="No verifier events yet">Commits, reveals and allow-list changes appear here as the indexer records the matching logs.</EmptyStateBlock> : events.map((event, index) => <div className="signal-row" key={`${event.taskId ?? "no-task"}-${event.at}-${event.label}-${index}`}><div><span className={`signal-icon signal-${event.tone}`}><Activity size={13} /></span><strong>{event.label}</strong></div><span>{event.operator}</span><span className="mono-text">{event.taskRef}</span><span className="muted-time" title={event.at}><Clock3 size={12} />{clockLabel(event.at)}</span><ArrowUpRight size={14} /></div>)}</div></section>
    </>}
    {registerOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setRegisterOpen(false); }}><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">Verifier registration</span><h2>Register, then wait for the allow-list.</h2></div><button className="icon-button" onClick={() => setRegisterOpen(false)}>×</button></div><p className="modal-copy">This signs <strong>registerVerifier(bytes32,string)</strong> against {PROOFRELAY_ADDRESS} and records your address, the canonical hash of your metadata object and the pointer to it. Registration alone does not put you to work: ProofRelay's MVP sybil defence is an admin allow-list, so a DEFAULT_ADMIN holder must still call setVerifierApproval(you, true) before the dispatcher assigns you a task. Until they do, the directory lists you as PENDING.</p><div className="form-grid"><label className="field full"><span>Metadata hash (bytes32)</span><input value={form.metadataHash} onChange={(event) => setForm({ ...form, metadataHash: event.target.value })} placeholder="0x… 32-byte canonical hash of the metadata object" spellCheck={false} autoComplete="off" /></label><label className="field full"><span>Metadata pointer{pointerLimit === null ? "" : ` (max ${pointerLimit} bytes)`}</span><input value={form.metadataPointer} onChange={(event) => setForm({ ...form, metadataPointer: event.target.value })} placeholder="local://… under the local driver, or the 0G Storage root" spellCheck={false} autoComplete="off" /></label><label className="field"><span>Stake to lock</span><div className="input-with-suffix"><input value={form.stake} onChange={(event) => setForm({ ...form, stake: event.target.value })} placeholder="0" inputMode="decimal" autoComplete="off" /><span>0G</span></div></label><label className="field"><span>Minimum stake</span><div className="field-static"><span>{minVerifierStake === null ? "reading params()…" : formatToken(minVerifierStake)}</span><ShieldCheck size={15} /></div></label></div>{wallet.isConnected && registerBlocker && <p className="modal-error">{registerBlocker}</p>}<div className="modal-foot"><span className="modal-note"><CheckCircle2 size={15} />{slashBps === null ? "Approval by an admin is required after registration" : slashBps === 0 ? "Slashing disabled (slashBps 0) · approval by an admin still required" : `Slash rate ${slashBps / 100}% · approval by an admin still required`}</span><button className="primary-button" onClick={submitRegistration} disabled={busy === "register"}>{busy === "register" ? "Signing…" : !wallet.isConnected ? "Connect wallet" : wallet.isWrongNetwork ? `Switch to ${NETWORK_NAME}` : "Register verifier"} <ArrowUpRight size={16} /></button></div></div></div>}
    {metadataOpen && current && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setMetadataOpen(false); }}><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">Verifier metadata</span><h2>{current.name}</h2></div><button className="icon-button" onClick={() => setMetadataOpen(false)}>×</button></div><p className="modal-copy">{onchain.isPending ? "Reading getVerifier() from the chain…" : onchain.error ? `getVerifier() could not be read: ${errorMessage(onchain.error)}` : hasMetadata ? `Both values below are read live from getVerifier(address) on ${NETWORK_NAME} — they are the pointer the verifier itself anchored, not an index copy.` : "This verifier registered without a metadata object: its metadataHash onchain is the zero hash, so there is nothing to resolve."}</p><div className="form-grid"><div className="field full"><span>Address</span><div className="field-static"><span className="mono-text truncate-value">{checksummedCurrent ?? current.address}</span><button className="icon-button tiny" onClick={() => copyValue("Address", checksummedCurrent)}><Copy size={14} /></button></div></div><div className="field full"><span>Metadata hash</span><div className="field-static"><span className="mono-text truncate-value">{metadataHash ?? "—"}</span><button className="icon-button tiny" onClick={() => copyValue("Metadata hash", metadataHash)} disabled={!hasMetadata}><Copy size={14} /></button></div></div><div className="field full"><span>Metadata pointer</span><div className="field-static"><span className="mono-text truncate-value">{metadataPointer || "—"}</span><button className="icon-button tiny" onClick={() => copyValue("Metadata pointer", metadataPointer)} disabled={!metadataPointer}><Copy size={14} /></button></div></div></div><div className="modal-foot"><span className="modal-note"><Fingerprint size={15} />{health.data ? `Storage driver ${health.data.drivers.storage}` : "Reading /health…"}</span><button className="primary-button" onClick={openOperatorExplorer} disabled={!explorer}>View address on explorer <ExternalLink size={15} /></button></div></div></div>}
  </DashboardLayout>;
}
