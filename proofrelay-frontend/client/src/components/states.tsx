// Evidence Ledger design: while a value is in flight the page shows the shape of the row it is
// waiting for, not a plausible number. Skeletons reuse the real grid classes so nothing reflows
// when the data lands; errors name the API's own error code; empty states say which kind of empty.
import { AlertTriangle, Inbox, RefreshCw, Search } from "lucide-react";

/* ── error normalisation ─────────────────────────────────────────────────── */

/**
 * The API answers failures with `{ error: { code, message, requestId } }`
 * (packages/schemas §ApiError). A thrown `TypeError` from `fetch` has neither.
 * Both must end up naming something real on screen — never "something went wrong".
 */
export function errorCode(error: unknown): string {
  if (!error) return "UNKNOWN";
  if (typeof error === "string") return error;
  const shell = error as Record<string, unknown>;
  const envelope = shell.error as Record<string, unknown> | undefined;
  const code = (envelope?.code ?? shell.code) as unknown;
  if (typeof code === "string" && code.length > 0) return code;
  const status = (shell.status ?? shell.statusCode) as unknown;
  if (typeof status === "number") return `HTTP_${status}`;
  if (error instanceof TypeError) return "API_UNREACHABLE";
  if (error instanceof Error && error.name && error.name !== "Error") return error.name;
  return "UNKNOWN";
}

export function errorMessage(error: unknown): string {
  if (!error) return "The request did not complete.";
  if (typeof error === "string") return error;
  const shell = error as Record<string, unknown>;
  const envelope = shell.error as Record<string, unknown> | undefined;
  const message = (envelope?.message ?? shell.message) as unknown;
  if (typeof message === "string" && message.length > 0) return message;
  return "The request did not complete.";
}

/**
 * A wallet write fails through viem, which puts the actionable sentence on
 * `shortMessage` and buries it inside a multi-paragraph `message`. A toast has
 * room for the first, not the second — and a reverted transaction carries the
 * contract's own reason on its message already.
 */
export function writeErrorMessage(error: unknown, fallback = "The transaction was not confirmed."): string {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  const shell = error as { name?: string; shortMessage?: string; details?: string; message?: string };
  if (shell.name === "TransactionRevertedError" && shell.message) return shell.message;
  const line = shell.shortMessage || shell.details || shell.message;
  return typeof line === "string" && line.trim().length > 0 ? line.trim().split("\n")[0] : fallback;
}

export function errorRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const shell = error as Record<string, unknown>;
  const envelope = shell.error as Record<string, unknown> | undefined;
  const requestId = (envelope?.requestId ?? shell.requestId) as unknown;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

/* ── skeleton primitives ─────────────────────────────────────────────────── */

export function Skeleton({ width, height, className = "" }: { width?: number | string; height?: number | string; className?: string }) {
  return <span aria-hidden className={`skeleton ${className}`.trim()} style={{ width: width ?? undefined, height: height ?? undefined }} />;
}

function Stack({ children }: { children: React.ReactNode }) {
  return <div className="skeleton-stack">{children}</div>;
}

function keys(count: number) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => index);
}

/* ── row skeletons: same classes, same grid cells, same heights ──────────── */

/** Overview "Latest tasks" and the Verification tasks table both render `.task-row`. */
export function TaskRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return <>{keys(rows).map((row) => <div className="task-row skeleton-row" key={row} aria-hidden><div className="task-main"><Skeleton className="sk-tile" /><Stack><Skeleton height={11} width="78%" /><Skeleton height={8} width="46%" /></Stack></div><Skeleton className="sk-pill" width={74} /><div className="agreement"><Skeleton width={54} height={4} /><Skeleton width={52} height={8} /></div><div className="task-bounty"><Skeleton width={58} height={10} /><Skeleton width={44} height={8} /></div><div className="task-time"><Skeleton width={48} height={10} /><Skeleton width={56} height={8} /></div><Skeleton className="sk-round" width={14} height={14} /></div>)}</>;
}

/** Artifacts table — seven columns including the trailing icon slot. */
export function ArtifactRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return <>{keys(rows).map((row) => <div className="artifact-row skeleton-row" key={row} aria-hidden><div className="artifact-name"><Skeleton className="sk-icon" /><div><Skeleton height={10} width="72%" /><Skeleton height={7} width="54%" /></div></div><Skeleton height={9} width="72%" /><Skeleton height={9} width={58} /><Skeleton height={9} width="84%" /><Skeleton height={9} width={44} /><Skeleton height={9} width={56} /><Skeleton className="sk-round" width={13} height={13} /></div>)}</>;
}

/** Verifier directory — avatar, identity, two stats, status, chevron. */
export function VerifierRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return <>{keys(rows).map((row) => <div className="verifier-directory-row skeleton-row" key={row} aria-hidden><Skeleton className="sk-round" width={29} height={29} /><div className="verifier-directory-main"><Skeleton height={11} width="46%" /><Skeleton height={8} width="82%" /></div><div className="directory-stat"><Skeleton height={7} width={44} /><Skeleton height={10} width={50} /></div><div className="directory-stat"><Skeleton height={7} width={44} /><Skeleton height={10} width={50} /></div><Skeleton className="sk-pill" width={62} height={14} /><Skeleton className="sk-round" width={14} height={14} /></div>)}</>;
}

/** Verifier network "Latest verifier events" — five columns. */
export function SignalRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return <>{keys(rows).map((row) => <div className="signal-row skeleton-row" key={row} aria-hidden><div><Skeleton className="sk-round" width={23} height={23} /><Skeleton height={10} width={112} /></div><Skeleton height={9} width="72%" /><Skeleton height={9} width={58} /><Skeleton height={9} width={52} /><Skeleton className="sk-round" width={13} height={13} /></div>)}</>;
}

/** Activity log timeline — the node keeps the connecting line in place. */
export function TimelineSkeleton({ rows = 5 }: { rows?: number }) {
  return <>{keys(rows).map((row) => <div className="timeline-entry skeleton-row" key={row} aria-hidden><div className="timeline-line"><Skeleton className="sk-node" /><div className="timeline-content"><div className="timeline-top"><Skeleton height={8} width={62} /><Skeleton height={8} width={54} /><Skeleton height={8} width={64} /></div><Skeleton height={12} width="42%" /><Skeleton height={10} width="78%" /><div className="timeline-meta"><Skeleton height={8} width={96} /><Skeleton height={8} width={112} /></div></div></div></div>)}</>;
}

/** Overview evidence trail — the claim rows under the task banner. */
export function EvidenceRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return <>{keys(rows).map((row) => <div className="evidence-item" key={row} aria-hidden><div className="evidence-head skeleton-row"><Skeleton className="sk-round" width={26} height={26} /><div className="evidence-title"><Skeleton height={11} width="82%" /><Skeleton height={9} width="44%" /></div><Skeleton className="sk-pill" width={86} /><Skeleton className="confidence" height={10} width={32} /><Skeleton className="sk-round" width={16} height={16} /></div></div>)}</>;
}

/** Overview metric cards. `.metric-card` keeps its own min-height, so nothing jumps. */
export function MetricCardsSkeleton({ cards = 4 }: { cards?: number }) {
  return <>{keys(cards).map((card) => <div className="metric-card skeleton-row" key={card} aria-hidden><div className="metric-topline"><Skeleton height={9} width={92} /><Skeleton className="sk-round" width={16} height={16} /></div><div className="metric-value"><Skeleton height={26} width={124} /></div><div className="metric-helper"><Skeleton height={9} width={108} /><Skeleton height={9} width={34} /></div></div>)}</>;
}

/**
 * The summary strips, network overview cards, artifact stat tiles and activity
 * summary tiles are one CSS rule with four wrapper class names, so one skeleton
 * serves all four — the caller passes the class its grid expects.
 */
export function StatCardsSkeleton({ cards = 3, className = "summary-strip" }: { cards?: number; className?: string }) {
  return <>{keys(cards).map((card) => <div className={`${className} skeleton-row`} key={card} aria-hidden><Skeleton height={8} width={86} /><Skeleton height={26} width={92} /><Skeleton height={9} width={128} /></div>)}</>;
}

/** 24 reveal-rate buckets while the history request is in flight. */
export function UptimeBarsSkeleton({ bars = 24 }: { bars?: number }) {
  return <div className="uptime-bars skeleton-row" aria-hidden>{keys(bars).map((bar) => <i className="bar-loading" key={bar} style={{ height: "100%" }} />)}</div>;
}

/* ── error ───────────────────────────────────────────────────────────────── */

/**
 * Shows the code the API actually returned (`CHAIN_UNAVAILABLE`,
 * `STORAGE_UNAVAILABLE`, `RATE_LIMITED`, …) so the runbook entry for it can be
 * found, plus the requestId when there is one, plus a retry.
 */
export function ErrorState({ error, onRetry, retrying = false, label = "Retry" }: { error: unknown; onRetry?: () => void; retrying?: boolean; label?: string }) {
  const code = errorCode(error);
  const requestId = errorRequestId(error);
  return <div className="state-error" role="alert"><AlertTriangle size={18} /><strong>This view could not be loaded.</strong><span className="state-error-code">{code}</span><p>{errorMessage(error)}</p>{requestId && <span className="state-error-request">request {requestId}</span>}{onRetry && <button className="state-retry" onClick={onRetry} disabled={retrying}><RefreshCw size={13} className={retrying ? "state-spin" : ""} />{retrying ? "Retrying…" : label}</button>}</div>;
}

/* ── empty ───────────────────────────────────────────────────────────────── */

/** The one-line form the tables already use. */
export function EmptyState({ children, icon = "search" }: { children: React.ReactNode; icon?: "search" | "inbox" }) {
  return <div className="empty-state">{icon === "inbox" ? <Inbox size={18} /> : <Search size={18} />}{children}</div>;
}

/**
 * The fuller form, for "nothing has been indexed yet" — which is a different
 * fact from "your filter matched nothing" and must not read the same.
 */
export function EmptyStateBlock({ title, children, actionLabel, onAction }: { title: string; children?: React.ReactNode; actionLabel?: string; onAction?: () => void }) {
  return <div className="empty-state-block"><span className="empty-state-mark" /><strong>{title}</strong>{children && <p>{children}</p>}{actionLabel && onAction && <button className="state-retry" onClick={onAction}>{actionLabel}</button>}</div>;
}

/**
 * Nothing is wrong and nothing is filtered — the chain simply has no history yet.
 * Callers pass whichever of the two blocks they actually know, so each one has to
 * be able to carry the sentence on its own; saying "the indexer has not reported a
 * processed block" while holding that very block would be a lie.
 */
export function IndexingState({ deployBlock, indexedBlock }: { deployBlock?: number | null; indexedBlock?: number | null }) {
  const from = typeof deployBlock === "number" ? deployBlock.toLocaleString("en-US") : null;
  const at = typeof indexedBlock === "number" ? indexedBlock.toLocaleString("en-US") : null;
  const detail = from
    ? `Indexing from block ${from}${at ? ` · currently at ${at}` : ""}. Rows appear as the indexer catches up.`
    : at
      ? `The indexer is at block ${at}. Rows appear as it records the matching logs.`
      : "The indexer has not reported a processed block yet. Rows appear as it catches up.";
  return <EmptyStateBlock title="Nothing indexed yet">{detail}</EmptyStateBlock>;
}

/** A wallet-scoped view with no wallet behind it. */
export function NotConnectedState({ what, onConnect }: { what: string; onConnect?: () => void }) {
  return <EmptyStateBlock title="No wallet connected" actionLabel={onConnect ? "Connect wallet" : undefined} onAction={onConnect}>{`Connect a wallet to see ${what}.`}</EmptyStateBlock>;
}

/* ── banners ─────────────────────────────────────────────────────────────── */

/**
 * The runbook's single most common demo failure is a wallet left on the wrong
 * chain, so the header — not a page — is where this has to be visible. Also
 * carries the paused, indexer-lag and API-unreachable conditions, which are the
 * other three states that invalidate everything below them.
 */
export function NetworkBanner({ tone = "coral", title, detail, actionLabel, onAction, busy = false }: { tone?: "coral" | "ink" | "sky"; title: string; detail?: string | null; actionLabel?: string; onAction?: () => void; busy?: boolean }) {
  return <div className={`network-banner banner-${tone}`} role="status"><AlertTriangle size={14} /><strong>{title}</strong>{detail && <span>{detail}</span>}{actionLabel && onAction && <button onClick={onAction} disabled={busy}>{busy ? "Switching…" : actionLabel}</button>}</div>;
}
