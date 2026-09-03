/**
 * `GET /v1/artifacts` — the object index.
 *
 * 0G Storage has no filenames and no listing: the key is the hash. So this
 * reads the `artifacts` table the indexer maintains, which is a cache of things
 * whose identity is proven elsewhere. Two consequences show up in the DTO:
 *
 * - `hashCoveragePct` is the share of listed objects whose bytes were fetched
 *   and rehashed to the value the chain recorded. It is the honest measure of
 *   how much of this page is proven rather than merely referenced, and it drops
 *   when 0G Storage is unreachable — which is exactly when the reader should
 *   know.
 * - `storageExplorerUrl` is null for a `local://` object, because there is no
 *   explorer for one. For a `0g://` object it is the upload transaction, since
 *   `storagescan-galileo.0g.ai/tx/<merkleRoot>` is a dead end (0G_STORAGE.md,
 *   "Dead ends" — it 308s to the chain explorer and treats the root as a tx
 *   hash). With no upload transaction indexed, the gateway permalink is used
 *   instead: it is the only URL that really renders the bytes.
 *
 * The summary aggregates the *filtered* set rather than the whole table, so the
 * numbers above the list always describe the list below it — and because it is
 * measured before paging is applied, `summary.totalObjects` is also what turns
 * a page into "page 3 of 8".
 *
 * Paging comes in two forms. `cursor` is the keyset walk every other list route
 * uses: stable while rows are inserted, but forward-only. `offset` addresses a
 * page directly, which is what numbered pagination needs; it is safe here
 * because the sort is a total order (`object_hash` is the primary key). Passing
 * both is refused rather than resolved.
 */
import type { FastifyInstance } from "fastify";
import {
  ArtifactFetchResponse,
  ArtifactKind,
  ArtifactListResponse,
  ProofRelayError,
  formatBytes,
  shortHash,
  type ArtifactListResponse as ArtifactListResponseType,
  type ArtifactView,
  type DisplayTone,
} from "@proofrelay/schemas";
import { cursorTimestamp, decodeCursor, encodeCursor, type RouteContext } from "../app.js";
import { many, one } from "../db.js";
import { fetchVerifiedObject } from "../services/verified-object.js";
import { refForSequence } from "../services/refs.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** 1 250 pages of 8. Past this the caller wants a filter, not a page number. */
const MAX_OFFSET = 10_000;

interface ArtifactRow {
  object_hash: string;
  kind: string;
  task_id: string | null;
  pointer: string;
  root_hash: string | null;
  byte_length: number;
  driver: string;
  name: string;
  hash_verified: boolean;
  upload_tx: string | null;
  created_at: Date;
  sequence: number | null;
}

const KIND_LABELS: Record<string, string> = {
  "source-snapshot": "Source snapshot",
  "task-manifest": "Task manifest",
  "verifier-report": "Verifier report",
  "consensus-result": "Consensus result",
  "challenge-evidence": "Challenge evidence",
  "adjudication-report": "Adjudication report",
};

const KIND_TONES: Record<string, DisplayTone> = {
  "source-snapshot": "ink",
  "task-manifest": "sky",
  "verifier-report": "lime",
  "consensus-result": "lime",
  "challenge-evidence": "coral",
  "adjudication-report": "coral",
};

const KIND_ICONS: Record<string, ArtifactView["icon"]> = {
  "source-snapshot": "text",
  "task-manifest": "json",
  "verifier-report": "json",
  "consensus-result": "check",
  "challenge-evidence": "json",
  "adjudication-report": "check",
};

function bareHex(hash: string): string {
  return hash.startsWith("0x") ? hash.slice(2) : hash;
}

function merkleRoot(pointer: string, rootHash: string | null): string | null {
  if (rootHash) return rootHash.startsWith("0x") ? rootHash : `0x${rootHash}`;
  const match = /^0g:\/\/(0x[0-9a-fA-F]+)$/.exec(pointer.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

function explorerUrl(ctx: RouteContext, row: ArtifactRow): string | null {
  const root = merkleRoot(row.pointer, row.root_hash);
  if (!root) return null;
  const explorer = ctx.config.storage.explorer;
  if (row.upload_tx && explorer) return `${explorer}/tx/${row.upload_tx}`;
  const gateway = ctx.config.storage.indexerRpc;
  return gateway ? `${gateway}/file?root=${root}` : null;
}

export async function registerArtifactRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  app.get("/v1/artifacts", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
    );
    // Bounded for the same reason `limit` is: an unbounded OFFSET is a request
    // for the database to walk arbitrarily far before returning nothing.
    //
    // Refused rather than clamped. Clamping answers a request for offset 1e30
    // with the rows at offset 10 000, which is content the caller never asked
    // for dressed as content it did — and a client that computes its offset
    // from the total it was just given cannot produce one this large by
    // accident, so an out-of-range offset is a bug worth reporting.
    const offset = Math.max(0, Math.trunc(Number(query.offset ?? 0)) || 0);
    if (offset > MAX_OFFSET) {
      throw new ProofRelayError("VALIDATION_FAILED", `offset may not exceed ${MAX_OFFSET}`, {
        detail: { offset: query.offset, maxOffset: MAX_OFFSET },
      });
    }
    const search = typeof query.q === "string" ? query.q.trim() : "";
    // `kind` is the name the frontend data contract gives this parameter and
    // the name the UI has always sent; this route read `type` and therefore
    // ignored the type filter entirely — `?kind=task-manifest` returned all 62
    // objects while `?type=task-manifest` returned 18. Both are accepted now so
    // the fix cannot break a caller that learned to use the wrong one.
    // First non-empty wins, rather than first present: `?kind=&type=x` is what a
    // form with an untouched "all types" select and a second filter sends, and
    // reading `kind` merely because it exists would throw the real filter away.
    const rawKind = [query.kind, query.type]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => value.length > 0) ?? "";
    const kindFilter = rawKind && rawKind.toUpperCase() !== "ALL" ? normaliseKind(rawKind) : null;

    const clauses: string[] = [];
    const values: unknown[] = [];
    if (kindFilter) {
      values.push(kindFilter);
      clauses.push(`a.kind = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      const placeholder = `$${values.length}`;
      clauses.push(
        `(a.object_hash ILIKE ${placeholder} OR a.pointer ILIKE ${placeholder} ` +
          `OR a.name ILIKE ${placeholder} OR COALESCE(a.task_id, '') ILIKE ${placeholder})`,
      );
    }
    const filter = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

    // The summary is measured before the cursor is applied, so paging forward
    // does not shrink the totals under the reader.
    const summaryRow = await one<{
      total_objects: number;
      task_count: number;
      total_bytes: string;
      verified: number;
    }>(
      ctx.pool,
      `SELECT count(*)::int AS total_objects,
              count(DISTINCT a.task_id)::int AS task_count,
              COALESCE(sum(a.byte_length), 0)::text AS total_bytes,
              count(*) FILTER (WHERE a.hash_verified)::int AS verified
         FROM artifacts a${filter}`,
      values,
    );

    const pageValues = [...values];
    const pageClauses = [...clauses];
    const cursor = decodeCursor(typeof query.cursor === "string" ? query.cursor : undefined, 2);

    /**
     * Numbered pages need to address a page directly, which a keyset cursor
     * cannot do — it only ever walks forward from where you are. `offset` is
     * offered alongside it, not instead of it: the ordering below is a total
     * one (`object_hash` is the primary key), so an offset addresses exactly
     * one page, and the filtered `totalObjects` in the summary is what turns
     * that into "page 3 of 8".
     *
     * Sending both is a client bug rather than a preference, so it is refused
     * instead of silently resolved in favour of one of them.
     */
    if (cursor && offset > 0) {
      throw new ProofRelayError("VALIDATION_FAILED", "pass cursor or offset, not both", {
        detail: { cursor: query.cursor, offset },
      });
    }
    if (cursor) {
      // Same reason as in `activity.ts`, and checked against `timestamptz`
      // rather than against `new Date`: the two disagree about
      // `Sat Sep 02 2026 GMT+9999` and about `+275760-09-13`, and the
      // disagreement surfaces as a 500 rather than a 400 the client can act on.
      pageValues.push(cursorTimestamp(cursor[0], query.cursor), cursor[1]);
      pageClauses.push(
        `(COALESCE(a.artifact_created_at, a.created_at), a.object_hash) < ` +
          `($${pageValues.length - 1}::timestamptz, $${pageValues.length}::text)`,
      );
    }
    pageValues.push(limit + 1);
    const limitPlaceholder = pageValues.length;
    pageValues.push(offset);

    const rows = await many<ArtifactRow>(
      ctx.pool,
      `SELECT a.object_hash, a.kind, a.task_id, a.pointer, a.root_hash, a.byte_length,
              a.driver, a.name, a.hash_verified, a.upload_tx,
              COALESCE(a.artifact_created_at, a.created_at) AS created_at,
              t.sequence
         FROM artifacts a
         LEFT JOIN tasks t ON t.task_id = a.task_id
        ${pageClauses.length ? `WHERE ${pageClauses.join(" AND ")}` : ""}
        ORDER BY COALESCE(a.artifact_created_at, a.created_at) DESC, a.object_hash DESC
        LIMIT $${limitPlaceholder} OFFSET $${pageValues.length}`,
      pageValues,
    );

    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeCursor([page[page.length - 1]!.created_at.toISOString(), page[page.length - 1]!.object_hash])
        : null;

    const items: ArtifactView[] = page.map((row) => ({
      name: row.name,
      kind: row.kind,
      typeLabel: KIND_LABELS[row.kind] ?? row.kind,
      taskRef: row.sequence === null ? "—" : refForSequence(Number(row.sequence)),
      taskId: (row.task_id as `0x${string}` | null) ?? null,
      objectId: bareHex(row.object_hash),
      pointer: row.pointer,
      hash: row.object_hash,
      shortHash: shortHash(row.object_hash),
      byteLength: Number(row.byte_length),
      // An artifact known only by its hash — the consensus result of a task
      // whose pointer was never written onchain — has no size yet. "0 B" would
      // assert an empty file; the size is simply not known until the object is
      // fetched, and the row already says so through hash_verified.
      sizeLabel: Number(row.byte_length) > 0 ? formatBytes(Number(row.byte_length)) : "—",
      createdAt: row.created_at.toISOString(),
      driver: row.driver,
      icon: KIND_ICONS[row.kind] ?? "json",
      tone: KIND_TONES[row.kind] ?? "ink",
      storageExplorerUrl: explorerUrl(ctx, row),
    }));

    const totalObjects = summaryRow?.total_objects ?? 0;
    const verified = summaryRow?.verified ?? 0;

    const body: ArtifactListResponseType = {
      items,
      nextCursor,
      summary: {
        totalObjects,
        taskCount: summaryRow?.task_count ?? 0,
        totalBytes: Number(summaryRow?.total_bytes ?? "0"),
        totalSizeLabel: formatBytes(Number(summaryRow?.total_bytes ?? "0")),
        hashCoveragePct:
          totalObjects === 0 ? 0 : Math.round((verified / totalObjects) * 1000) / 10,
        driver: ctx.storage.driver,
        network: ctx.config.chain.network,
      },
      types: [...ArtifactKind.options],
    };

    return ArtifactListResponse.parse(body);
  });
}

/**
 * Accepts either the kind the chain uses (`verifier-report`) or the label the
 * dropdown renders (`Verifier report`); the UI sends whichever it happens to
 * hold, and a filter that silently matches nothing is worse than a 400.
 */
/** `0x` followed by 64 hex digits — the shape of every content hash here. */
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

interface LocatedArtifact {
  pointer: string | null;
  kind: string | null;
  body: unknown;
}

/**
 * `GET /v1/artifacts/{contentHash}` — one object, proved before it is served.
 *
 * The list route above is an index: it reports what the indexer recorded. This
 * one goes back to the bytes. It follows the pointer, rehashes what comes back,
 * and compares with the hash in the URL — so `verified` is a comparison this
 * request performed rather than a column it read, and a body that fails it is a
 * 409 rather than a 200 with a warning attached.
 */
export async function registerArtifactObjectRoute(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  app.get<{ Params: { contentHash: string } }>("/v1/artifacts/:contentHash", async (request) => {
    const raw = request.params.contentHash.trim();
    if (!HASH_PATTERN.test(raw)) {
      throw new ProofRelayError("VALIDATION_FAILED", "a content hash is 0x followed by 64 hex digits", {
        detail: { contentHash: raw.slice(0, 80) },
      });
    }
    const contentHash = raw.toLowerCase();

    // The pointer can come from the artifact index or from the report the chain
    // published — a report revealed a block ago has a pointer and no indexed
    // body yet, and this route should still be able to serve it.
    const located = await one<LocatedArtifact>(
      ctx.pool,
      `SELECT
         COALESCE(a.pointer, r.report_pointer) AS pointer,
         a.kind                                AS kind,
         a.body                                AS body
       FROM (SELECT $1::text AS hash) k
       LEFT JOIN artifacts a ON lower(a.object_hash) = k.hash
       LEFT JOIN reports   r ON lower(r.report_hash) = k.hash
       LIMIT 1`,
      [contentHash],
    );

    const cached = located?.body ?? null;
    if (!located?.pointer && cached === null) {
      throw new ProofRelayError("ARTIFACT_NOT_FOUND", `no object is indexed for ${contentHash}`, {
        detail: { contentHash },
      });
    }

    const verified = await fetchVerifiedObject(ctx, {
      hash: contentHash,
      pointer: located?.pointer ?? null,
      cached,
      requestId: String(request.id),
      noun: "artifact",
    });

    // The body's own `kind` is inside the bytes that were just proved; the
    // column is the indexer's reading of them. Prefer the proved one.
    const declared =
      verified.body && typeof verified.body === "object"
        ? (verified.body as { kind?: unknown }).kind
        : undefined;

    return ArtifactFetchResponse.parse({
      contentHash,
      kind: typeof declared === "string" && declared.length > 0 ? declared : located?.kind ?? "unknown",
      pointer: located?.pointer ?? null,
      byteLength: verified.bytes.length,
      verified: true,
      source: verified.source,
      fetchedAt: ctx.now().toISOString(),
      body: verified.body,
    });
  });
}

function normaliseKind(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if ((ArtifactKind.options as readonly string[]).includes(slug)) return slug;
  throw new ProofRelayError("VALIDATION_FAILED", `unknown artifact type ${raw}`, {
    detail: { type: raw, accepted: [...ArtifactKind.options, "ALL"] },
  });
}
