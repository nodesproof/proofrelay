// Evidence Ledger design: artifacts are treated like inspectable research objects, never opaque attachments.
// Nothing on this page is a literal any more. The three stat tiles, every row, the type filter and the
// object viewer all read GET /v1/artifacts and GET /v1/artifacts/{hash}; "Sync storage" replays the chain
// through POST /v1/tasks/{taskId}/sync and reports the pass it actually ran. Where a value has not arrived
// yet the design's loading state is rendered instead of a plausible number.
//
// Two hashes are deliberately kept apart everywhere on this page, because conflating them is the exact
// failure the protocol exists to prevent: the CONTENT HASH (keccak-256 over the canonical bytes, recorded
// onchain as manifestHash/reportHash/evidenceHash) is what verifies an object, while the POINTER — a 0G
// merkle root in `0g://0x…` or a local object id in `local://…` — only says where to look for the bytes.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUpRight, ChevronDown, Copy, Database, ExternalLink, FileCheck2, FileJson2, FileText, Fingerprint, Hash, Image, Search, SlidersHorizontal } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import Pagination from "@/components/Pagination";
import { EmptyState, EmptyStateBlock, ErrorState, ArtifactRowsSkeleton, Skeleton, StatCardsSkeleton, errorCode, errorMessage } from "@/components/states";
import { useArtifacts, useHealth } from "@/hooks/useProofRelay";
import { API_URL, syncTask } from "@/lib/api";
import { STORAGE_EXPLORER_URL } from "@/lib/wagmi";
import { blockLabel, percentLabel, plural, relativeTime, shortHash } from "@/lib/format";
import type { ApiErrorBody, ArtifactView, Bytes32, Iso, Pointer, SyncResponse } from "@/lib/types";

/**
 * The protocol's closed set of canonical object kinds (packages/schemas ArtifactKind),
 * rendered in the design's label style. There are six, there is no image kind, and
 * "evidence graph" is a field inside a verifier-report rather than an object of its own.
 */
const KINDS: Array<{ kind: string; label: string }> = [
  { kind: "task-manifest", label: "Task manifest" },
  { kind: "source-snapshot", label: "Source snapshot" },
  { kind: "verifier-report", label: "Verifier report" },
  { kind: "consensus-result", label: "Consensus result" },
  { kind: "challenge-evidence", label: "Challenge evidence" },
  { kind: "adjudication-report", label: "Adjudication report" },
];

/** ArtifactView.icon is a four-value enum on the wire; these are the four icons the design already uses. */
const ICONS = { json: FileJson2, text: FileText, check: FileCheck2, image: Image } as const;

/**
 * Eight rows a page. The API pages this table by `offset` rather than by the
 * keyset cursor the other list routes use, because a numbered pager has to be
 * able to address page 6 without walking pages 2 through 5 to get there.
 *
 * The cost of an offset is that it addresses a *position*, not a row: an
 * artifact indexed while the reader is on page 3 lands at the top of page 1 and
 * shifts everything down by one. That is inherent to numbered pagination over a
 * live list, and it is visible rather than hidden — the total in the pager and
 * the TOTAL OBJECTS tile both move at the same time.
 */
const PAGE_SIZE = 8;

/**
 * The API refuses an offset above 10 000, so the highest page it can address is
 * that offset divided by the page size. Rendering a button past it would offer
 * the reader a page the server answers with a 400 — a dead end inside the
 * control whose job is to be the way out of one. It takes 80 000 artifacts to
 * reach.
 */
const MAX_PAGE = Math.floor(10_000 / PAGE_SIZE);

/** `0g://0x<merkleRoot>` — the root locates the bytes on 0G Storage and is not the content hash. */
function merkleRoot(pointer: string): string | null {
  const match = /^0g:\/\/(0x[0-9a-fA-F]+)$/.exec(pointer.trim());
  return match ? match[1].toLowerCase() : null;
}

/** A pointer is 70+ characters; the column is not. Keep the scheme, shorten the reference, keep the full value in the title. */
function pointerLabel(pointer: string): string {
  const scheme = pointer.indexOf("://");
  if (scheme < 0) return shortHash(pointer);
  return `${pointer.slice(0, scheme + 3)}${shortHash(pointer.slice(scheme + 3))}`;
}

/** A source-snapshot body carries `sha256:…` over the fetched source bytes — a different hash family from the object hash. */
function sourceBodyHash(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).contentHash;
  return typeof value === "string" && value.startsWith("sha256:") ? value : null;
}

/**
 * GET /v1/artifacts/{contentHash} — the row-click object fetch
 * (FRONTEND_DATA_CONTRACT §2 ArtifactResponse, §3.5). The server refetches the bytes behind the
 * pointer and recomputes the canonical hash over them: `verified` is that comparison, and `source`
 * says whether 0G Storage or the index cache answered. A 409 CONTENT_HASH_MISMATCH is never served
 * as a 200, so a failure here is shown as the code it is rather than swallowed into a body.
 */
interface ArtifactResponse {
  contentHash: Bytes32;
  kind: string;
  pointer: Pointer;
  byteLength: number;
  verified: boolean;
  source: "storage" | "cache";
  fetchedAt: Iso;
  body: unknown;
}

async function fetchArtifact(contentHash: string, signal?: AbortSignal): Promise<ArtifactResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/artifacts/${encodeURIComponent(contentHash)}`, { headers: { Accept: "application/json" }, credentials: "omit", signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw Object.assign(new Error(`Cannot reach the ProofRelay API at ${API_URL}`), { code: "STORAGE_UNAVAILABLE" });
  }
  const payload = (await response.json().catch(() => null)) as (ApiErrorBody & Partial<ArtifactResponse>) | null;
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message ?? `${response.status} ${response.statusText || "request failed"}`), { code: payload?.error?.code ?? (response.status === 409 ? "CONTENT_HASH_MISMATCH" : response.status === 404 ? "ARTIFACT_NOT_FOUND" : `HTTP_${response.status}`) });
  return payload as unknown as ArtifactResponse;
}

export default function Artifacts() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ArtifactView | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { const tick = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(tick); }, []);
  useEffect(() => { if (!selected) return; const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); }; document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey); }, [selected]);

  /**
   * A narrowed filter renumbers the pages under the reader, so page 4 of the
   * old list is not page 4 of the new one. Reset during render rather than in
   * an effect: an effect cannot run until after the render that already changed
   * the filter, and that render would fetch the new filter at the old offset —
   * a request whose answer is thrown away before it arrives.
   */
  const filterKey = `${kind}\u0000${search}`;
  const [pagedFilter, setPagedFilter] = useState(filterKey);
  if (pagedFilter !== filterKey) {
    setPagedFilter(filterKey);
    setPage(0);
  }
  const requested = pagedFilter === filterKey ? page : 0;

  /**
   * The last total the API reported, held across a failure. `artifacts.data` is
   * undefined when the fetch for a *new* page key errors — react-query
   * substitutes placeholder data only while a query is pending, never while it
   * is in error — and a total of zero unmounts the pager, stranding the reader
   * on the page that failed with no control left to leave it by.
   *
   * It is also what bounds the page before the request goes out, so a page past
   * the end is corrected as a value rather than by an effect that fires a
   * render too late.
   */
  const [knownTotal, setKnownTotal] = useState(0);
  const lastPage = knownTotal > 0 ? Math.max(0, Math.min(Math.ceil(knownTotal / PAGE_SIZE) - 1, MAX_PAGE)) : MAX_PAGE;
  const shown = Math.min(requested, lastPage);

  const artifacts = useArtifacts({ kind: kind || undefined, q: search || undefined, limit: PAGE_SIZE, offset: shown * PAGE_SIZE });
  const health = useHealth();
  const selectedHash = selected?.hash ?? null;
  /** Objects are content-addressed, so a verified fetch stays valid forever and never refetches. */
  const object = useQuery<ArtifactResponse, Error>({ queryKey: ["proofrelay", "artifact", selectedHash], queryFn: ({ signal }) => fetchArtifact(selectedHash as string, signal), enabled: Boolean(selectedHash), staleTime: Infinity, gcTime: Infinity, retry: false });

  const items = useMemo(() => artifacts.data?.items ?? [], [artifacts.data]);
  const summary = artifacts.data?.summary;
  const total = summary?.totalObjects ?? knownTotal;
  useEffect(() => {
    if (summary && summary.totalObjects !== knownTotal) setKnownTotal(summary.totalObjects);
  }, [summary, knownTotal]);
  const filtering = search.length > 0 || kind.length > 0;
  const indexedBlock = health.data?.indexer.lastBlock ?? null;
  const storageExplorer = health.data?.storageExplorer || STORAGE_EXPLORER_URL;
  const storageLabel = summary ? (summary.driver === "zerog" ? "0G Storage" : `${summary.driver} storage`) : null;
  const coverage = percentLabel(summary?.hashCoveragePct, 0);
  const sampleHash = selected?.hash ?? items[0]?.hash ?? null;
  const scanTarget = selected?.storageExplorerUrl ?? items.find((item) => item.storageExplorerUrl)?.storageExplorerUrl ?? null;
  const body = object.data?.body;
  const bodyHash = sourceBodyHash(body);
  const selectedRoot = selected ? merkleRoot(selected.pointer) : null;

  /**
   * Re-verification is per task in this API, so the pass replays every task the
   * loaded page references — and the loaded page is eight rows, not the whole
   * registry. The toast counts the tasks it actually rescanned rather than
   * implying a full sync.
   */
  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const taskIds = Array.from(new Set(items.map((item) => item.taskId).filter((id): id is Bytes32 => typeof id === "string" && id.length > 0)));
      const passes = await Promise.allSettled(taskIds.map((taskId) => syncTask(taskId)));
      const done = passes.flatMap((pass) => (pass.status === "fulfilled" ? [pass.value as SyncResponse] : []));
      const failures = passes.flatMap((pass) => (pass.status === "rejected" ? [pass.reason as unknown] : []));
      const refreshed = await artifacts.refetch();
      const after = refreshed.data?.summary ?? summary ?? null;
      const events = done.reduce((total, pass) => total + pass.eventsProcessed, 0);
      const afterCoverage = percentLabel(after?.hashCoveragePct, 0);
      const found = after ? `${plural(after.totalObjects, "object")} indexed${afterCoverage ? `, ${afterCoverage} hash-verified` : ""}` : "the registry did not answer";
      if (done.length === 0 && failures.length > 0) toast.error("Storage sync failed", { description: `${errorCode(failures[0])} — ${errorMessage(failures[0])}` });
      else if (failures.length > 0) toast("Storage sync incomplete", { description: `${plural(done.length, "task")} rescanned · ${plural(failures.length, "task")} refused (${errorCode(failures[0])}) · ${found}` });
      else if (taskIds.length === 0) toast("Storage sync complete", { description: after && after.totalObjects === 0 ? "Nothing is indexed yet, so there were no bytes to re-verify." : `No loaded row carries a task id, so no chain range was replayed · ${found}` });
      else toast.success("Storage sync complete", { description: `${plural(taskIds.length, "task")} rescanned · ${plural(events, "chain event")} replayed · ${found}` });
    } catch (error) {
      toast.error("Storage sync failed", { description: `${errorCode(error)} — ${errorMessage(error)}` });
    } finally {
      setSyncing(false);
    }
  };

  const copyHash = async (hash: string | null) => {
    if (!hash) { toast("Nothing to copy yet", { description: "No canonical object is indexed, so there is no content hash to hand out." }); return; }
    await navigator.clipboard?.writeText(hash);
    toast.success("Hash copied", { description: hash });
  };

  const openStorageScan = () => {
    if (scanTarget) { window.open(scanTarget, "_blank", "noopener,noreferrer"); return; }
    if (summary && summary.driver !== "zerog") { toast("Storage Scan cannot resolve these objects", { description: `The API is running the ${summary.driver} storage driver, so every pointer is a local object id. Nothing on ${storageExplorer} will find them.` }); return; }
    window.open(storageExplorer, "_blank", "noopener,noreferrer");
  };

  return <DashboardLayout eyebrow="0G Storage registry" title="Artifacts">
    <div className="page-intro-row"><p className="page-intro">A canonical index of manifests, snapshots, verifier reports, and evidence graphs pinned to 0G Storage. Every object keeps its content hash visible.</p><button className="secondary-button" onClick={runSync} disabled={syncing} title={`Re-verify the ${PAGE_SIZE} objects on this page against 0G Storage by replaying the tasks they belong to`}><Database size={16} />{syncing ? "Syncing…" : "Sync storage"}</button></div>
    <section className="artifact-stat-grid">{summary ? <><div><span className="eyebrow">TOTAL OBJECTS</span><strong>{summary.totalObjects}</strong><small>Across {plural(summary.taskCount, "task")}</small></div><div><span className="eyebrow">STORAGE USED</span><strong>{summary.totalSizeLabel}</strong><small>{storageLabel} · {summary.network}</small></div><div><span className="eyebrow">HASH COVERAGE</span><strong>{coverage ?? "—"}</strong><small>Canonical objects only</small></div></> : artifacts.error ? <><div><span className="eyebrow">TOTAL OBJECTS</span><strong>—</strong><small>{errorCode(artifacts.error)}</small></div><div><span className="eyebrow">STORAGE USED</span><strong>—</strong><small>{errorCode(artifacts.error)}</small></div><div><span className="eyebrow">HASH COVERAGE</span><strong>—</strong><small>Canonical objects only</small></div></> : <StatCardsSkeleton cards={3} className="" />}</section>
    <section className="section-block page-section"><div className="toolbar-row"><div className="search-field"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search artifacts, task IDs, or hashes" /></div><div className="artifact-tools"><div className="filter-select"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option>{KINDS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}</select><ChevronDown size={14} /></div><button className="icon-button" title="Clear the search and type filter, then reload the registry" aria-label="Clear filters and reload the registry" onClick={() => { setQuery(""); setSearch(""); setKind(""); void artifacts.refetch(); }}><SlidersHorizontal size={16} /></button></div></div><div className="artifact-table" aria-busy={artifacts.isPlaceholderData}><div className="artifact-head"><span>Object</span><span>Type</span><span>Task</span><span>Storage pointer</span><span>Size</span><span>Created</span><span /></div>{artifacts.isPending ? <ArtifactRowsSkeleton /> : artifacts.error && !artifacts.data ? <ErrorState error={artifacts.error} onRetry={() => { void artifacts.refetch(); }} retrying={artifacts.isFetching} /> : items.length === 0 ? shown > 0 ? <EmptyStateBlock title="This page is empty" actionLabel="Back to the first page" onAction={() => setPage(0)}>{`Page ${shown + 1} has no rows. The registry changed while you were reading it, so the pages have been renumbered.`}</EmptyStateBlock> : filtering ? <EmptyState>No artifacts found.</EmptyState> : <EmptyStateBlock title="Nothing indexed yet">{indexedBlock === null ? "The indexer has not reported a processed block yet. Objects appear here as chain events name their hashes." : `The indexer is at ${blockLabel(indexedBlock)} and no canonical object has been recorded yet. Objects appear here as chain events name their hashes.`}</EmptyStateBlock> : items.map((artifact) => { const Icon = ICONS[artifact.icon]; const root = merkleRoot(artifact.pointer); return <button className="artifact-row" key={artifact.hash} onClick={() => setSelected(artifact)}><div className="artifact-name"><span className={`artifact-icon artifact-${artifact.tone}`}><Icon size={15} /></span><div><strong title={artifact.name}>{artifact.name}</strong><span title={`Content hash ${artifact.hash} — keccak-256 over the canonical bytes, the value that verifies this object`}>{artifact.shortHash}</span></div></div><span className="artifact-type">{artifact.typeLabel}</span><span className="mono-text" title={artifact.taskId ?? "No task references this object"}>{artifact.taskRef}</span><span className="storage-pointer" title={`${artifact.pointer}${root ? " — 0G Storage merkle root; it locates the bytes, it does not verify them" : " — local object id; it locates the bytes, it does not verify them"}`}><Database size={12} />{pointerLabel(artifact.pointer)}</span><span title={`${artifact.byteLength.toLocaleString("en-US")} bytes`}>{artifact.sizeLabel}</span><span className="muted-time" title={artifact.createdAt}>{relativeTime(artifact.createdAt, now)}</span><ArrowUpRight size={14} /></button>; })}</div><Pagination page={shown} pageSize={PAGE_SIZE} total={total} onPage={setPage} unit="objects" busy={artifacts.isPlaceholderData} maxPage={MAX_PAGE} /></section>
    <section className="artifact-detail-card"><div className="artifact-detail-icon"><Fingerprint size={23} /></div><div className="artifact-detail-copy"><div className="eyebrow">CONTENT-ADDRESSED STORAGE</div><h2>Evidence is portable by default.</h2><p>Export raw JSON, verify the content hash outside the UI, or open the 0G pointer directly. The database is an index—the artifact is the source of truth.</p></div><div className="artifact-detail-actions"><button className="secondary-button" onClick={() => { void copyHash(sampleHash); }}><Copy size={15} />Copy sample hash</button><button className="quiet-button" onClick={openStorageScan}>Open Storage Scan <ExternalLink size={13} /></button></div></section>
    {selected && <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setSelected(null); }}><div className="modal-card artifact-viewer"><div className="modal-head"><div><span className="eyebrow">{selected.typeLabel}</span><h2>{selected.name}</h2></div><button className="icon-button" onClick={() => setSelected(null)}>×</button></div>
      <div className="artifact-viewer-proof">{object.isPending ? <Skeleton className="sk-pill" width={104} /> : object.error ? <span className="pill pill-coral"><span className="pill-dot" />{errorCode(object.error)}</span> : object.data?.verified ? <span className="pill pill-lime"><span className="pill-dot" />HASH VERIFIED</span> : <span className="pill pill-coral"><span className="pill-dot" />HASH MISMATCH</span>}<span>{object.isPending ? "Fetching the bytes at the pointer and recomputing the object hash over them…" : object.error ? errorMessage(object.error) : object.data?.verified ? "The bytes behind this pointer hash to the content hash recorded onchain." : "The bytes behind this pointer do not hash to the recorded content hash. Nothing below is trustworthy."}</span></div>
      <div className="artifact-viewer-rows"><div className="artifact-viewer-row"><span><Hash size={11} />Content hash</span><strong>{selected.hash}</strong><small>keccak-256 over the canonical bytes — this is the value that verifies the object</small></div><div className="artifact-viewer-row"><span><Database size={11} />Storage pointer</span><strong>{selected.pointer}</strong><small>{selectedRoot ? "0G Storage merkle root — it locates the bytes, it does not verify them" : `${selected.driver} object id — it locates the bytes, it does not verify them`}</small></div>{bodyHash && <div className="artifact-viewer-row"><span><Fingerprint size={11} />Source body hash</span><strong>{bodyHash}</strong><small>sha256 over the fetched source bytes — a different hash family from the object hash above</small></div>}<div className="artifact-viewer-row"><span>Task</span><strong>{selected.taskRef}</strong><small>{selected.taskId ?? "no task references this object"}</small></div><div className="artifact-viewer-row"><span>Size</span><strong>{selected.sizeLabel}</strong><small>{selected.byteLength.toLocaleString("en-US")} bytes</small></div><div className="artifact-viewer-row"><span>Created</span><strong>{relativeTime(selected.createdAt, now)}</strong><small>{selected.createdAt}</small></div></div>
      {object.error ? <ErrorState error={object.error} onRetry={() => { void object.refetch(); }} retrying={object.isFetching} /> : <div className="code-block"><div className="code-head"><span><FileJson2 size={12} />{selected.name}</span><button onClick={() => { if (body === undefined) return; void navigator.clipboard?.writeText(JSON.stringify(body, null, 2)); toast.success("Object JSON copied"); }}>Copy JSON</button></div><pre>{object.isPending ? "Fetching object…" : body === undefined ? "The API answered without a body." : JSON.stringify(body, null, 2)}</pre></div>}
      <div className="modal-foot"><span className="modal-note"><Database size={15} />{object.data ? object.data.source === "cache" ? "Served from the index cache — the storage gateway was unreachable" : `Fetched from ${selected.driver} storage` : object.error ? "Not fetched" : "Fetching from storage…"}</span><div className="artifact-viewer-actions"><button className="secondary-button compact" onClick={() => { void copyHash(selected.hash); }}><Copy size={15} />Copy hash</button>{selectedRoot && <button className="quiet-button" onClick={openStorageScan}>Open Storage Scan <ExternalLink size={13} /></button>}</div></div>
    </div></div>}
  </DashboardLayout>;
}
