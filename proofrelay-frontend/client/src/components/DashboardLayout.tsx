// Evidence Ledger design: every page shares the same ink rail, paper canvas, and visible 0G operational context.
// Nothing in this chrome is a literal any more: the network card, the block height, the nav counts, the
// notification badge and the signer rail all read GET /health, GET /v1/stats, GET /v1/artifacts,
// GET /v1/activity and the wallet. Where a value has not arrived yet the design's loading state is rendered.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Activity, ArrowDownToLine, ArrowUpRight, Bell, BookOpen, ChevronDown, Copy, Database, ExternalLink, FileCheck2, Layers3, LogOut, Menu, Network, ShieldAlert, WalletCards } from "lucide-react";
import { useReadContract } from "wagmi";
import { PROOFRELAY_ADDRESS, PROOFRELAY_ADDRESS_IS_UNSET, proofRelayAbi } from "@/lib/contract";
import { ACTIVE_CHAIN_ID, EXPLORER_URL, NETWORK_NAME } from "@/lib/wagmi";
import { useActivity, useArtifacts, useHealth, useOnchainVerifier, usePendingWithdrawal, useStats, useWallet, useWithdraw } from "@/hooks/useProofRelay";
import type { Address, HealthResponse } from "@/lib/types";
import { blockLabel, chainName, explorerAddressUrl, formatToken, lagLabel, percentLabel, shortChainName, shortChecksumAddress, toChecksumAddress } from "@/lib/format";
import { NetworkBanner, Skeleton, errorCode, errorMessage, writeErrorMessage } from "./states";

const proofLogo = "/proofrelay-logo.webp";

/** RUNBOOK: the indexer is "alerting" once it falls this far behind the chain head. */
const INDEXER_LAG_ALERT_BLOCKS = 20;
/** INDEXER_CONFIRMATIONS — anything at or under this is normal, not a degradation. */
const INDEXER_CONFIRMATIONS = 2;

type NavCount = "tasks" | "artifacts";
type OpenMenu = "wallet" | "signals" | "rail" | null;

const routes: Array<{ label: string; path: string; icon: typeof Activity; count?: NavCount }> = [
  { label: "Overview", path: "/", icon: Layers3 },
  { label: "Verification tasks", path: "/verification-tasks", icon: FileCheck2, count: "tasks" },
  { label: "Verifier network", path: "/verifier-network", icon: Network },
  { label: "Artifacts", path: "/artifacts", icon: Database, count: "artifacts" },
  { label: "Activity log", path: "/activity-log", icon: Activity },
  { label: "Protocol docs", path: "/protocol-docs", icon: BookOpen },
];

function isActive(current: string, path: string) {
  if (path === "/") return current === "/";
  return current.startsWith(path);
}

/** Every dependency /health reports as down, by name — the label says which one broke. */
function failingDependencies(health: HealthResponse | undefined): string[] {
  if (!health) return [];
  return Object.entries(health.dependencies)
    .filter(([, dependency]) => !dependency.ok)
    .map(([name]) => name);
}

function dependencyDetail(health: HealthResponse | undefined): string | undefined {
  if (!health) return undefined;
  const lines = Object.entries(health.dependencies).map(([name, dependency]) => `${name}: ${dependency.ok ? "ok" : "down"}${dependency.detail ? ` — ${dependency.detail}` : ""}${typeof dependency.latencyMs === "number" ? ` (${dependency.latencyMs} ms)` : ""}`);
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * "Connection: Healthy" is not a decoration — it degrades to the name of whichever
 * dependency /health says is down, and to the indexer when the read model is the
 * thing that is behind.
 */
function connectionState(health: HealthResponse | undefined, failed: unknown): { text: string; warn: boolean } | null {
  if (failed) return { text: "Unreachable", warn: true };
  if (!health) return null;
  const down = failingDependencies(health);
  if (down.length > 0) return { text: `${down.join(", ")} down`, warn: true };
  if (!health.indexer.running) return { text: "Indexer stopped", warn: true };
  const lag = health.indexer.lagBlocks;
  if (typeof lag === "number" && lag > INDEXER_CONFIRMATIONS) return { text: "Indexer lagging", warn: true };
  if (!health.ok) return { text: "Degraded", warn: true };
  return { text: "Healthy", warn: false };
}

/** Lime when the chain dependency is healthy and the index is caught up; coral when not; grey while unknown. */
function chainDotClass(health: HealthResponse | undefined, failed: unknown, mismatch: boolean): string {
  if (mismatch) return "live-dot dot-coral";
  if (failed) return "live-dot dot-coral";
  if (!health) return "live-dot dot-idle";
  const chain = health.dependencies.chain;
  const lag = health.indexer.lagBlocks ?? 0;
  if (chain && !chain.ok) return "live-dot dot-coral";
  if (lag > INDEXER_LAG_ALERT_BLOCKS) return "live-dot dot-coral";
  if (lag > INDEXER_CONFIRMATIONS) return "live-dot dot-sky";
  return "live-dot";
}

/**
 * The protocol role behind the connected address. There is no workspace entity in
 * ProofRelay, so this — Adjudicator / Keeper / Verifier / Task creator — is what the
 * rail can honestly say about a signer. `undefined` means the reads are still in flight.
 */
function useSignerRole(address: Address | undefined): string | undefined | null {
  const adjudicatorRole = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "ADJUDICATOR_ROLE", chainId: ACTIVE_CHAIN_ID, query: { staleTime: Infinity, gcTime: Infinity } });
  const keeperRole = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "KEEPER_ROLE", chainId: ACTIVE_CHAIN_ID, query: { staleTime: Infinity, gcTime: Infinity } });
  const isAdjudicator = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "hasRole", args: adjudicatorRole.data && address ? [adjudicatorRole.data, address] : undefined, chainId: ACTIVE_CHAIN_ID, query: { enabled: Boolean(adjudicatorRole.data && address), refetchInterval: 60_000 } });
  const isKeeper = useReadContract({ address: PROOFRELAY_ADDRESS, abi: proofRelayAbi, functionName: "hasRole", args: keeperRole.data && address ? [keeperRole.data, address] : undefined, chainId: ACTIVE_CHAIN_ID, query: { enabled: Boolean(keeperRole.data && address), refetchInterval: 60_000 } });
  const verifier = useOnchainVerifier(address);

  if (!address) return null;
  if (isAdjudicator.data === true) return "Adjudicator";
  if (isKeeper.data === true) return "Keeper";
  if (verifier.data?.registered === true) return "Verifier";
  if (isAdjudicator.data === undefined || isKeeper.data === undefined || verifier.data === undefined) return undefined;
  return "Task creator";
}

export default function DashboardLayout({ children, eyebrow, title }: { children: React.ReactNode; eyebrow: string; title: string }) {
  const [location, navigate] = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  const [menu, setMenu] = useState<OpenMenu>(null);

  const health = useHealth();
  const stats = useStats();
  const artifacts = useArtifacts({ limit: 1 });
  const signals = useActivity({ category: "Dispute", limit: 8 });
  const wallet = useWallet();
  const withdrawal = usePendingWithdrawal();
  const withdraw = useWithdraw();
  const role = useSignerRole(wallet.address);

  const checksummed = toChecksumAddress(wallet.address);
  const shortSigner = shortChecksumAddress(wallet.address);
  const apiChainId = health.data?.chainId;
  const apiNetwork = health.data?.network;
  const walletNetwork = chainName(wallet.chainId, wallet.chainId === apiChainId ? apiNetwork : null);
  const chainMismatch = wallet.isConnected && wallet.chainId !== undefined && apiChainId !== undefined && wallet.chainId !== apiChainId;
  // The strip under the topbar was correct and easy to miss: a connected wallet
  // on the wrong network read, on a busy page, as a connected wallet. The
  // prompt is the same fact made unmissable — and it can only offer a switch
  // when the API itself is on the chain this build signs against, which is the
  // same guard the strip's action already uses.
  const [promptDismissedFor, setPromptDismissedFor] = useState<number | null>(null);
  const showNetworkPrompt = chainMismatch && apiChainId === ACTIVE_CHAIN_ID && wallet.chainId !== promptDismissedFor;
  useEffect(() => { if (!wallet.isConnected) setPromptDismissedFor(null); }, [wallet.isConnected]);
  const switchToActive = async () => {
    try {
      await wallet.switchNetwork();
      toast.success(`Wallet switched to ${NETWORK_NAME}`);
    } catch (error) {
      toast.error("Network not switched", { description: writeErrorMessage(error, `The wallet refused to switch to ${NETWORK_NAME}.`) });
    }
  };
  const connection = connectionState(health.data, health.error);
  const indexedBlock = health.data?.indexer.lastBlock ?? null;
  const headBlock = health.data?.indexer.headBlock ?? null;
  const lagBlocks = health.data?.indexer.lagBlocks ?? null;
  const lagAlert = typeof lagBlocks === "number" && lagBlocks > INDEXER_LAG_ALERT_BLOCKS;
  const explorer = health.data?.explorer || EXPLORER_URL;
  const openSignals = signals.data?.summary.openSignals ?? 0;
  const disputeItems = signals.data?.items ?? [];
  const storage = health.data?.dependencies.storage;
  const compute = health.data?.dependencies.compute;
  const hashCoverage = percentLabel(artifacts.data?.summary.hashCoveragePct, 0);

  /** The rail shows the network the API is indexing; the chip shows the one the wallet is actually on. */
  const chipLabel = wallet.isConnected ? shortChainName(walletNetwork) : apiNetwork ? shortChainName(apiNetwork) : null;
  const dotClass = chainDotClass(health.data, health.error, chainMismatch);

  const counts = useMemo<Record<NavCount, { value: number | undefined; failed: boolean }>>(
    () => ({
      tasks: { value: stats.data?.activeTasks, failed: Boolean(stats.error) },
      artifacts: { value: artifacts.data?.summary.totalObjects, failed: Boolean(artifacts.error) },
    }),
    [artifacts.data?.summary.totalObjects, artifacts.error, stats.data?.activeTasks, stats.error],
  );

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => { const target = event.target as HTMLElement | null; if (target && target.closest("[data-menu-root]")) return; setMenu(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  const go = (path: string) => {
    navigate(path);
    setMobileNav(false);
    setMenu(null);
  };

  const connect = async () => {
    try {
      await wallet.connect();
    } catch (error) {
      toast.error("Wallet not connected", { description: writeErrorMessage(error, "The wallet rejected the connection.") });
    }
  };

  const disconnect = async () => {
    setMenu(null);
    await wallet.disconnect();
    toast("Wallet disconnected");
  };

  const copyAddress = async () => {
    if (!checksummed) return;
    await navigator.clipboard?.writeText(checksummed);
    toast.success("Address copied", { description: checksummed });
  };

  const openExplorer = () => {
    const url = explorerAddressUrl(explorer, checksummed);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const runWithdraw = async () => {
    try {
      const result = await withdraw.mutateAsync();
      toast.success("Withdrawal confirmed", { description: result.explorerUrl ?? `Block ${result.blockNumber}` });
    } catch (error) {
      toast.error("Withdrawal failed", { description: writeErrorMessage(error) });
    }
  };

  const walletMenu = (variant: "topbar" | "rail") => <div className={`topbar-pop ${variant === "rail" ? "pop-rail pop-above" : ""}`}><div className="topbar-pop-head"><span>Signer</span><span>{role === null ? "—" : role ?? "resolving"}</span></div><div className="topbar-pop-row"><span>Address</span><strong>{shortSigner ?? "—"}</strong></div><div className="topbar-pop-row"><span>Network</span><strong>{shortChainName(walletNetwork)}</strong></div><div className="topbar-pop-row"><span>Pending withdrawal</span><strong>{withdrawal.wei === undefined ? <Skeleton width={62} height={9} /> : formatToken(withdrawal.wei)}</strong></div>{chainMismatch && <p className="topbar-pop-note">The API indexes {apiNetwork ?? `chain ${apiChainId}`}. Switch the wallet before signing anything.</p>}<div className="topbar-pop-actions"><button onClick={runWithdraw} disabled={!withdrawal.hasBalance || withdraw.isPending || wallet.isWrongNetwork} title={wallet.isWrongNetwork ? `withdraw() is a transaction on chain ${ACTIVE_CHAIN_ID}; this wallet is on ${walletNetwork}.` : undefined}><ArrowDownToLine size={13} />{withdraw.isPending ? "Withdrawing…" : "Withdraw"}</button><button onClick={copyAddress}><Copy size={13} />Copy address</button><button onClick={openExplorer} disabled={!explorer}><ExternalLink size={13} />View on explorer</button><button onClick={disconnect}><LogOut size={13} />Disconnect</button></div></div>;

  return (
    <div className="app-shell" style={{ "--paperTexture": "url(/proofrelay-paper-texture.svg)" } as React.CSSProperties}>
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand-lockup"><img className="brand-logo" src={proofLogo} alt="ProofRelay — evidence onchain" /></div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <span className="nav-section-label">Workspace</span>
          {routes.slice(0, 4).map(({ label, path, icon: Icon, count }) => <button key={path} className={`nav-item ${isActive(location, path) ? "active" : ""}`} onClick={() => go(path)}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{count && <span className="nav-count">{counts[count].value === undefined ? counts[count].failed ? "—" : <Skeleton width={16} height={8} /> : counts[count].value}</span>}</button>)}
          <span className="nav-section-label second">Observe</span>
          {routes.slice(4).map(({ label, path, icon: Icon }) => <button key={path} className={`nav-item ${isActive(location, path) ? "active" : ""}`} onClick={() => go(path)}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-bottom"><div className="network-card"><div className="network-label" title={health.data ? `contract ${health.data.contract} · api ${health.data.version}` : undefined}><span className={dotClass} />{apiNetwork ?? (health.error ? "Network unknown" : <Skeleton width={104} height={9} />)}</div><div className="network-row" title={health.error ? errorMessage(health.error) : dependencyDetail(health.data)}><span>Connection</span><strong className={connection ? connection.warn ? "value-warn" : "" : "value-pending"}>{connection ? connection.text : <Skeleton width={52} height={9} />}</strong></div><div className="network-row" title={typeof headBlock === "number" ? `chain head ${blockLabel(headBlock)} · indexed ${blockLabel(indexedBlock)}` : undefined}><span>Latest block</span><strong className={indexedBlock === null ? "value-pending" : ""}>{indexedBlock === null ? health.error ? "—" : <Skeleton width={64} height={9} /> : blockLabel(indexedBlock)}</strong></div>{lagAlert && <div className="network-row"><span>Indexer lag</span><strong className="value-warn">{lagLabel(lagBlocks)}</strong></div>}</div><div className="rail-anchor" data-menu-root><button className="user-row" onClick={() => (wallet.isConnected ? setMenu(menu === "rail" ? null : "rail") : connect())}><div className="user-avatar">{checksummed ? checksummed.slice(2, 4).toUpperCase() : "—"}</div><div className="user-copy"><span>{wallet.isConnected ? shortSigner ?? "—" : "Not connected"}</span><small>{wallet.isConnected ? "Connected wallet" : wallet.isReconnecting ? "Reconnecting…" : wallet.isConnecting ? "Connecting…" : wallet.hasInjectedWallet ? "No wallet connected" : "No wallet detected"}</small></div><ChevronDown size={15} /></button>{menu === "rail" && walletMenu("rail")}</div></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><button className="mobile-menu icon-button" onClick={() => setMobileNav((current) => !current)} aria-label="Toggle navigation"><Menu size={20} /></button><div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{title}</strong></div><div className="topbar-actions"><div className="network-chip" title={chainMismatch ? `Wallet on ${walletNetwork}; API indexes ${apiNetwork ?? `chain ${apiChainId}`}` : dependencyDetail(health.data)}><span className={dotClass} />{chipLabel ?? <Skeleton width={68} height={9} />}</div><div className="topbar-anchor" data-menu-root><button className="icon-button notification-button" aria-label="Notifications" onClick={() => setMenu(menu === "signals" ? null : "signals")}><Bell size={17} />{openSignals > 0 && <span className="notification-badge">{openSignals}</span>}</button>{menu === "signals" && <div className="topbar-pop"><div className="topbar-pop-head"><span>Open signals</span><span>{signals.data ? openSignals : "…"}</span></div>{signals.error ? <p className="topbar-pop-note">{errorCode(signals.error)} — {errorMessage(signals.error)}</p> : !signals.data ? <div className="topbar-pop-list"><div className="signal-item"><span className="live-dot dot-idle" /><div><Skeleton width={112} height={9} /><Skeleton width={72} height={7} /></div></div></div> : openSignals === 0 ? <p className="topbar-pop-note">{signals.data.summary.openSignalDetail || "No dispute is open. Your task queue is clear."}</p> : <div className="topbar-pop-list">{disputeItems.map((event) => <div className="signal-item" key={event.id}><span className="live-dot dot-coral" /><div><strong>{event.title}</strong><small>{event.taskRef} · {event.time} UTC</small></div></div>)}</div>}<div className="topbar-pop-actions"><button onClick={() => go("/activity-log")}><Activity size={13} />Open activity log</button></div></div>}</div><div className="topbar-anchor" data-menu-root><button className={`wallet-button ${wallet.isConnected ? "connected" : ""}`} onClick={() => (wallet.isConnected ? setMenu(menu === "wallet" ? null : "wallet") : connect())}><WalletCards size={16} />{wallet.isConnected ? shortSigner ?? "Connected" : wallet.isConnecting ? "Connecting…" : wallet.isReconnecting ? "Reconnecting…" : "Connect wallet"}</button>{menu === "wallet" && walletMenu("topbar")}</div></div></header>
        {PROOFRELAY_ADDRESS_IS_UNSET && <NetworkBanner title="No contract address for this network" detail={`This build targets ${NETWORK_NAME} but VITE_PROOFRELAY_ADDRESS is not set, and the compiled-in fallback belongs to another chain. Every onchain read and write is inert until it is set.`} />}
        {showNetworkPrompt && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setPromptDismissedFor(wallet.chainId ?? null); }}><div className="modal-card network-prompt" role="alertdialog" aria-labelledby="network-prompt-title"><div className="modal-head"><div><span className="eyebrow">Wrong network</span><h2 id="network-prompt-title">Switch your wallet to {NETWORK_NAME}</h2></div><button className="icon-button" aria-label="Dismiss" onClick={() => setPromptDismissedFor(wallet.chainId ?? null)}>×</button></div><p className="modal-copy">Your wallet is on <strong>{walletNetwork}</strong>. ProofRelay's contract lives on {NETWORK_NAME} (chain {ACTIVE_CHAIN_ID}); a transaction signed on any other network never reaches it. If the wallet does not have {NETWORK_NAME} yet, it will offer to add it — switching signs nothing.</p><div className="modal-foot"><span className="modal-note"><ShieldAlert size={15} />Nothing on this page is signed until the wallet is on {NETWORK_NAME}</span><div className="network-prompt-actions"><button className="secondary-button" onClick={() => { void wallet.disconnect(); }}><LogOut size={15} />Disconnect</button><button className="primary-button" onClick={() => { void switchToActive(); }} disabled={wallet.isSwitchingNetwork}>{wallet.isSwitchingNetwork ? "Switching…" : `Switch to ${NETWORK_NAME}`} <ArrowUpRight size={16} /></button></div></div></div></div>}
        {chainMismatch && <NetworkBanner title={`Wallet is on ${walletNetwork}`} detail={`ProofRelay is indexed on ${apiNetwork ?? `chain ${apiChainId}`}. Nothing you sign here will reach the contract.`} actionLabel={apiChainId === ACTIVE_CHAIN_ID ? "Switch network" : undefined} onAction={apiChainId === ACTIVE_CHAIN_ID ? () => { void wallet.switchNetwork(); } : undefined} busy={wallet.isSwitchingNetwork} />}
        {health.error && <NetworkBanner title="ProofRelay API unreachable" detail={`${errorCode(health.error)} — ${errorMessage(health.error)}`} actionLabel="Retry" onAction={() => { void health.refetch(); }} busy={health.isFetching} />}
        {health.data?.paused && <NetworkBanner tone="ink" title="Contract paused" detail="Creating tasks, committing and opening challenges are blocked. Finalize, expire and withdraw still work." />}
        {lagAlert && <NetworkBanner tone="sky" title="Indexer is behind the chain" detail={`${lagLabel(lagBlocks)} — head ${blockLabel(headBlock) ?? "unknown"}, indexed ${blockLabel(indexedBlock) ?? "unknown"}.`} />}
        <div className="content-wrap"><div className="page-heading"><div><div className="overline"><span className="overline-mark" />{eyebrow}</div><h1>{title}</h1></div><div className="page-heading-rule" /></div>{children}<footer className="footer-strip"><div title={health.data ? `API ${health.data.version} · contract ${health.data.contract}` : undefined}><img className="footer-logo" src={proofLogo} alt="ProofRelay" />ProofRelay · live on {apiNetwork ?? NETWORK_NAME}</div><div className="footer-links"><span title={storage?.detail ?? undefined}><Database size={13} />{health.data ? `0G Storage ${health.data.drivers.storage} · ${storage?.ok ? "connected" : "unavailable"}` : health.error ? "0G Storage unknown" : <Skeleton width={132} height={9} />}</span><span title={compute?.detail ?? undefined}><span className={compute ? compute.ok ? "live-dot" : "live-dot dot-coral" : "live-dot dot-idle"} />{health.data ? `Compute ${health.data.drivers.compute} · ${compute?.ok ? "ready" : "unavailable"}` : health.error ? "Compute unknown" : <Skeleton width={118} height={9} />}</span><span>{hashCoverage ? `Canonical artifacts ${hashCoverage}` : artifacts.error ? "Canonical artifacts —" : <Skeleton width={124} height={9} />}</span></div></footer></div>
      </main>
    </div>
  );
}
