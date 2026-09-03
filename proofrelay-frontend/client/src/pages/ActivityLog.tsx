// Evidence Ledger design: activity is a forensic timeline where every state change has a time and an accountable actor.
// Nothing on this page is a literal any more. The timeline, the day grouping, the category tabs, the search and the
// three summary tiles all come from GET /v1/activity; the block-sync tile is cross-read against GET /health so the
// dot can go coral on real indexer lag; "View payload" prints the decoded log the indexer stored for that event; and
// "Export activity" writes the rows that are actually on screen to a CSV file. Where a value has not landed yet the
// design's loading state is rendered — never a zero, never a placeholder percentage.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Activity, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Database, FileCheck2, GitBranch, Hash, Search, ShieldAlert, SlidersHorizontal, WalletCards, Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { EmptyState, EmptyStateBlock, ErrorState, IndexingState, Skeleton, StatCardsSkeleton, TimelineSkeleton } from "@/components/states";
import { useActivity, useHealth } from "@/hooks/useProofRelay";
import { ACTIVITY_CATEGORIES } from "@/lib/types";
import type { ActivityEvent } from "@/lib/types";
import { blockLabel, lagLabel, pad2, percentLabel, plural, relativeTime } from "@/lib/format";

/** The tab that sends no `category` at all; every other tab is a category the API itself reported. */
const ALL_EVENTS = "All events";
/** RUNBOOK alert threshold — the sync dot goes coral once the indexer is this far behind. */
const INDEXER_LAG_ALERT_BLOCKS = 20;
/** INDEXER_CONFIRMATIONS — a lag at or under this is the normal confirmation depth, not a degradation. */
const INDEXER_CONFIRMATIONS = 2;
/** The timeline is a head view; §3.6 of the data contract sizes it at 50 rows per fetch. */
const TIMELINE_LIMIT = 50;
/** "8 sec ago" has to keep counting between the 10 s activity polls. */
const CLOCK_TICK_MS = 5_000;

/** The lucide set this page already draws with, keyed so `ActivityEvent.icon` can name one of them. */
const EVENT_ICONS: Record<string, typeof Activity> = { activity: Activity, checkcircle2: CheckCircle2, chevrondown: ChevronDown, clock3: Clock3, database: Database, filecheck2: FileCheck2, gitbranch: GitBranch, hash: Hash, search: Search, shieldalert: ShieldAlert, slidershorizontal: SlidersHorizontal, walletcards: WalletCards, zap: Zap };
/** The fallback when the API names an icon this build does not carry: the category's own icon. */
const CATEGORY_ICONS: Record<string, typeof Activity> = { Verification: GitBranch, Storage: Database, Settlement: CheckCircle2, Dispute: ShieldAlert, Compute: Zap, Registry: FileCheck2 };

function eventIcon(event: ActivityEvent): typeof Activity {
  return EVENT_ICONS[event.icon.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? CATEGORY_ICONS[event.category] ?? Activity;
}

/**
 * `hash` is already shortened by the API (it applies packages/schemas/src/format.ts),
 * and a compute requestId like `local-c3500d125c212d9e` must not be re-shortened into
 * nonsense — so only a full-length hex value that arrived unshortened is trimmed here.
 */
function metaHash(hash: string): string {
  if (!/^0x[0-9a-fA-F]{40,}$/.test(hash)) return hash;
  return `0x${hash.slice(2, 6)}…${hash.slice(-4)}`;
}

/* ── CSV export ──────────────────────────────────────────────────────────── */

const CSV_COLUMNS = ["id", "occurredAt", "day", "time", "category", "title", "detail", "actor", "actorAddress", "taskRef", "taskId", "hash", "txHash", "blockNumber", "explorerUrl"] as const;

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(items: ActivityEvent[]): string {
  const rows = items.map((event) => [event.id, event.at, event.day, event.time, event.category, event.title, event.detail, event.actor, event.actorAddress, event.taskRef, event.taskId, event.hash, event.tx.txHash, event.tx.blockNumber, event.tx.explorerUrl].map(csvCell).join(","));
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n");
}

export default function ActivityLog() {
  const [filter, setFilter] = useState(ALL_EVENTS);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [payloadEvent, setPayloadEvent] = useState<ActivityEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /** The search box filters server-side (`GET /v1/activity?q=`), debounced so it is not one request per keystroke. */
  useEffect(() => { const id = window.setTimeout(() => setSearch(query.trim()), 300); return () => window.clearTimeout(id); }, [query]);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS); return () => window.clearInterval(id); }, []);

  const activity = useActivity({ category: filter === ALL_EVENTS ? undefined : filter, q: search || undefined, limit: TIMELINE_LIMIT });
  const health = useHealth();

  const items = activity.data?.items ?? [];
  const summary = activity.data?.summary;
  const filters = useMemo(() => [ALL_EVENTS, ...(activity.data?.categories ?? ACTIVITY_CATEGORIES)], [activity.data?.categories]);
  const isFiltered = filter !== ALL_EVENTS || search.length > 0;
  const loading = !activity.data && !activity.error;

  const indexedBlock = summary?.lastBlock ?? health.data?.indexer.lastBlock ?? null;
  const headBlock = health.data?.indexer.headBlock ?? null;
  const lagBlocks = health.data?.indexer.lagBlocks ?? null;
  const syncFailed = Boolean(activity.error && health.error);
  const syncDot = syncFailed ? "live-dot dot-coral" : lagBlocks === null ? "live-dot dot-idle" : lagBlocks > INDEXER_LAG_ALERT_BLOCKS ? "live-dot dot-coral" : lagBlocks > INDEXER_CONFIRMATIONS ? "live-dot dot-sky" : "live-dot";
  const syncTitle = headBlock === null ? undefined : `chain head ${blockLabel(headBlock)} · indexed ${blockLabel(indexedBlock)}${lagBlocks === null ? "" : ` · ${lagLabel(lagBlocks)}`}`;
  /** `lastBlockAgeSec` is measured at fetch time; anchoring it once lets the label keep counting on the tick. */
  const syncedAt = useMemo(() => (typeof summary?.lastBlockAgeSec === "number" ? new Date(Date.now() - summary.lastBlockAgeSec * 1000) : null), [summary?.lastBlockAgeSec, activity.dataUpdatedAt]);

  const exportActivity = () => {
    if (items.length === 0) return;
    const scope = filter === ALL_EVENTS ? "all" : filter.toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const blob = new Blob([toCsv(items)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `proofrelay-activity-${scope}-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success("Activity exported", { description: `${plural(items.length, "event")} written to ${link.download}.` });
  };

  return <DashboardLayout eyebrow="Forensic timeline" title="Activity log">
    <div className="page-intro-row"><p className="page-intro">Follow every material state change across tasks, verifier workers, storage objects, and settlement. The log mirrors the event stream indexed from 0G Chain.</p><button className="secondary-button" onClick={exportActivity} disabled={items.length === 0}><ArrowUpRight size={15} />Export activity</button></div>
    <section className="activity-summary">{loading ? <StatCardsSkeleton cards={3} /> : <><div><span className="eyebrow">EVENTS TODAY</span><strong>{summary ? summary.eventsToday : "—"}</strong>{!summary ? <span>—</span> : summary.trendPct === null ? <span>{plural(summary.eventsYesterday, "event")} yesterday</span> : <span>{summary.trendPct < 0 ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />}{percentLabel(Math.abs(summary.trendPct), 0)} vs yesterday</span>}</div><div title={syncTitle}><span className="eyebrow">LAST BLOCK SYNC</span><strong>{blockLabel(indexedBlock) ?? "—"}</strong><span><span className={syncDot} />{syncedAt ? relativeTime(syncedAt, new Date(now)) : syncFailed || activity.error ? "—" : <Skeleton width={58} height={9} />}</span></div><div><span className="eyebrow">OPEN SIGNALS</span><strong>{summary ? pad2(summary.openSignals) : "—"}</strong><span className={summary && summary.openSignals > 0 ? "warning-copy" : ""}><ShieldAlert size={12} />{summary ? summary.openSignalDetail : "—"}</span></div></>}</section>
    <section className="section-block page-section"><div className="toolbar-row"><div className="search-field"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search activity, task IDs, or actors" /></div><div className="filter-tabs activity-filters">{filters.map((item) => <button className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div></div><div className="activity-timeline">{loading ? <TimelineSkeleton rows={5} /> : activity.error && !activity.data ? <ErrorState error={activity.error} onRetry={() => { void activity.refetch(); }} retrying={activity.isFetching} /> : items.map((event, index) => { const Icon = eventIcon(event); const previous = items[index - 1]; const onchain = Boolean(event.tx.txHash); return <div key={event.id} className="timeline-entry">{(!previous || previous.day !== event.day) && <div className="timeline-day">{event.day}</div>}<div className="timeline-line"><div className={`timeline-node timeline-${event.tone}`}><Icon size={14} /></div><div className="timeline-content"><div className="timeline-top"><time dateTime={event.at}>{event.time} UTC</time><span className="event-type">{event.category}</span>{event.taskRef && <span className="timeline-task">{event.taskRef}</span>}</div><h3>{event.title}</h3><p>{event.detail}</p><div className="timeline-meta"><span title={event.actorAddress ?? undefined}><Activity size={12} />{event.actor}{!onchain && <em className="meta-origin">offchain</em>}</span>{onchain && event.tx.explorerUrl ? <a href={event.tx.explorerUrl} target="_blank" rel="noreferrer" title={event.tx.txHash ?? undefined}><Hash size={12} />{metaHash(event.hash)}</a> : <span title={event.hash}><Hash size={12} />{metaHash(event.hash)}</span>}<button onClick={() => setPayloadEvent(event)} disabled={event.payload === null || event.payload === undefined} title={event.payload === null || event.payload === undefined ? "The indexer stored no decoded payload for this event." : undefined}>View payload <ArrowUpRight size={12} /></button></div></div></div></div>; })}{activity.data && items.length === 0 && (isFiltered ? <EmptyState>No activity matches this filter.</EmptyState> : indexedBlock === null ? <IndexingState indexedBlock={indexedBlock} /> : <EmptyStateBlock title="Nothing indexed yet">{`Indexed to block ${blockLabel(indexedBlock)}${headBlock === null ? "" : ` of ${blockLabel(headBlock)}`}. Rows appear here as the indexer records events.`}</EmptyStateBlock>)}</div></section>
    {payloadEvent && <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setPayloadEvent(null); }}><div className="modal-card"><div className="modal-head"><div><span className="eyebrow">Decoded event payload</span><h2>{payloadEvent.title}</h2></div><button className="icon-button" onClick={() => setPayloadEvent(null)}>×</button></div><p className="modal-copy">{payloadEvent.category} · {payloadEvent.day} {payloadEvent.time} UTC{payloadEvent.tx.blockNumber === null ? "" : ` · block ${blockLabel(payloadEvent.tx.blockNumber)}`}{payloadEvent.taskRef ? ` · ${payloadEvent.taskRef}` : ""}</p><div className="code-block payload-block"><pre>{JSON.stringify(payloadEvent.payload, null, 2)}</pre></div><div className="modal-foot"><span className="modal-note"><Hash size={15} />{payloadEvent.tx.txHash ?? payloadEvent.hash}</span>{payloadEvent.tx.explorerUrl ? <button className="primary-button" onClick={() => window.open(payloadEvent.tx.explorerUrl as string, "_blank", "noopener,noreferrer")}>View transaction <ArrowUpRight size={16} /></button> : <button className="secondary-button" onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(payloadEvent.payload, null, 2)); toast.success("Payload copied", { description: `${payloadEvent.category} · ${payloadEvent.id}` }); }}>Copy payload <ArrowUpRight size={15} /></button>}</div></div></div>}
  </DashboardLayout>;
}
