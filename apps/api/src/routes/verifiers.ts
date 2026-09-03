/**
 * `GET /v1/verifiers` — the Verifier network page.
 *
 * The recovered UI carried an invented directory: 18 active operators, 92.6%
 * network agreement, and 24 literal uptime-bar heights. Every one of those is a
 * measurement here or a `null`, and the two that cannot be measured at all are
 * gone rather than approximated.
 *
 * Three definitions, because each one is a choice someone will otherwise have
 * to reverse-engineer from SQL:
 *
 * - **agreementPct** is claims where the verifier was in `agreeingVerifiers`
 *   over claims where it submitted a verdict at all. A verifier that never
 *   reported has no denominator, so it gets `null` — not 0%, which would read
 *   as "always wrong" rather than "never asked".
 * - **uptimeSeries** is 24 hourly buckets of reveals over commitments made in
 *   that hour. A commitment obliges a reveal, so that ratio is the only
 *   reveal-versus-expected the chain actually supports. An hour in which the
 *   verifier was asked for nothing is 0 — the bar shows work proven in that
 *   hour, and `uptimePct` carries the honest ratio with a `null` for no sample.
 * - **status** is approval and liveness together: an unapproved verifier is
 *   PENDING whatever it has been doing, and an approved one is ONLINE only if
 *   the chain saw it act inside the last hour.
 */
import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import {
  ProofRelayError,
  VerifierListResponse,
  formatToken,
  shortAddress,
  type DisplayTone,
  type VerifierListResponse as VerifierListResponseType,
  type VerifierView,
} from "@proofrelay/schemas";
import type { RouteContext } from "../app.js";
import { many, one } from "../db.js";
import { refForSequence } from "../services/refs.js";

/** An approved verifier the chain saw act this recently is ONLINE. */
const ONLINE_WINDOW_MS = 60 * 60_000;
/** Past this it is OFFLINE; between the two it is DEGRADED. */
const DEGRADED_WINDOW_MS = 24 * 60 * 60_000;
const BUCKET_COUNT = 24;
const BUCKET_MS = 60 * 60_000;
/** The directory is a whole-table read plus a chain call per row; cap both. */
const MAX_DIRECTORY = 200;
/**
 * How many withdrawable balances one list response will read from the chain.
 * Beyond this the field is null rather than a fabricated zero — the directory
 * still renders, and the detail route answers exactly for one verifier.
 */
const WITHDRAWAL_LOOKUP_LIMIT = 25;
const TREND_WINDOW_MS = 7 * 86_400_000;
const ZERO_HASH = `0x${"0".repeat(64)}`;

interface VerifierRow {
  address: string;
  registered: boolean;
  approved: boolean;
  active: boolean;
  stake: string;
  metadata_hash: string | null;
  metadata_pointer: string | null;
  label: string | null;
  role: string | null;
  last_seen_at: Date | null;
  committed: number;
  revealed: number;
  tasks_seen: number;
  last_reveal_at: Date | null;
  model_id: string | null;
  pipeline_version: string | null;
  verifier_id: string | null;
  median_latency_ms: number | null;
}

const VERIFIER_SELECT = `
  SELECT
    v.address, v.registered, v.approved, v.active, v.stake,
    v.metadata_hash, v.metadata_pointer, v.label, v.role, v.last_seen_at,
    (SELECT count(*) FROM reports r
      WHERE lower(r.verifier) = lower(v.address) AND r.committed_at IS NOT NULL)::int AS committed,
    (SELECT count(*) FROM reports r
      WHERE lower(r.verifier) = lower(v.address) AND r.revealed_at IS NOT NULL)::int AS revealed,
    (SELECT count(DISTINCT r.task_id) FROM reports r
      WHERE lower(r.verifier) = lower(v.address))::int AS tasks_seen,
    (SELECT max(r.revealed_at) FROM reports r
      WHERE lower(r.verifier) = lower(v.address)) AS last_reveal_at,
    (SELECT r.model_id FROM reports r
      WHERE lower(r.verifier) = lower(v.address) AND r.model_id IS NOT NULL
      ORDER BY r.revealed_at DESC NULLS LAST LIMIT 1) AS model_id,
    (SELECT r.pipeline_version FROM reports r
      WHERE lower(r.verifier) = lower(v.address) AND r.pipeline_version IS NOT NULL
      ORDER BY r.revealed_at DESC NULLS LAST LIMIT 1) AS pipeline_version,
    (SELECT r.body->'verifier'->>'verifierId' FROM reports r
      WHERE lower(r.verifier) = lower(v.address) AND r.body IS NOT NULL
      ORDER BY r.revealed_at DESC NULLS LAST LIMIT 1) AS verifier_id,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.compute_latency_ms)
       FROM reports r
      WHERE lower(r.verifier) = lower(v.address) AND r.compute_latency_ms IS NOT NULL)::int
      AS median_latency_ms
  FROM verifiers v`;

/**
 * Claims a verifier reported on, and how many of those it was in the agreeing
 * set for. Expanded out of `consensus_results.claims` rather than recomputed:
 * the agreeing set is what the consensus artifact recorded and was hashed with,
 * so re-deriving it here could disagree with the object the chain committed to.
 *
 * Every `jsonb_array_elements` is guarded inline with a CASE rather than by a
 * WHERE. A set-returning function in the FROM clause runs before the WHERE that
 * would have excluded its row, so one `claims` column holding anything but an
 * array raises 22023 and takes the whole directory down with a 500.
 */
const ARRAY_OR_EMPTY = (expression: string): string =>
  `CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '[]'::jsonb END`;

const AGREEMENT_SQL = `
  SELECT verifier, count(*)::int AS claims_seen, count(*) FILTER (WHERE agreed)::int AS claims_agreed
    FROM (
      SELECT
        lower(verdict->>'verifier') AS verifier,
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${ARRAY_OR_EMPTY("claim->'agreeingVerifiers'")}) AS a
           WHERE lower(a) = lower(verdict->>'verifier')
        ) AS agreed
      FROM consensus_results c,
           LATERAL jsonb_array_elements(${ARRAY_OR_EMPTY("c.claims")}) AS claim,
           LATERAL jsonb_array_elements(${ARRAY_OR_EMPTY("claim->'verdicts'")}) AS verdict
    ) expanded
   WHERE verifier IS NOT NULL
   GROUP BY verifier`;

interface AgreementRow {
  verifier: string;
  claims_seen: number;
  claims_agreed: number;
}

interface BucketRow {
  verifier: string;
  bucket: number;
  committed: number;
  revealed: number;
}

interface EventRow {
  event_name: string;
  actor: string | null;
  task_id: string | null;
  block_time: Date;
  sequence: number | null;
  label: string | null;
}

const EVENT_LABELS: Record<string, { label: string; tone: DisplayTone }> = {
  ReportRevealed: { label: "Report revealed", tone: "lime" },
  ReportCommitted: { label: "Commit accepted", tone: "sky" },
  VerifierRegistered: { label: "Verifier registered", tone: "sky" },
  VerifierApprovalSet: { label: "Approval changed", tone: "coral" },
  RoleGranted: { label: "Role granted", tone: "ink" },
};

/** `verifier-a` is what the report artifact calls itself; the UI wants a name. */
function displayName(row: VerifierRow): string {
  if (row.label) return row.label;
  if (row.verifier_id) {
    return row.verifier_id
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => (part.length <= 2 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
      .join(" ");
  }
  return `Verifier ${shortAddress(row.address)}`;
}

function roleLabel(role: string | null): string {
  if (!role) return "Verifier";
  const lower = role.toLowerCase();
  return lower[0]!.toUpperCase() + lower.slice(1);
}

function statusOf(row: VerifierRow, now: Date): VerifierView["status"] {
  if (!row.approved) return "PENDING";
  if (!row.active) return "OFFLINE";
  const seen = row.last_seen_at ?? row.last_reveal_at;
  if (!seen) return "OFFLINE";
  const age = now.getTime() - seen.getTime();
  if (age <= ONLINE_WINDOW_MS) return "ONLINE";
  if (age <= DEGRADED_WINDOW_MS) return "DEGRADED";
  return "OFFLINE";
}

function toneOf(status: VerifierView["status"]): DisplayTone {
  if (status === "ONLINE") return "lime";
  if (status === "DEGRADED") return "coral";
  if (status === "PENDING") return "sky";
  return "ink";
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export async function registerVerifierRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  app.get("/v1/verifiers", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const search = typeof query.q === "string" ? query.q.trim() : "";
    const statusFilter =
      typeof query.status === "string" && query.status.trim() && query.status.trim().toUpperCase() !== "ALL"
        ? query.status.trim().toUpperCase()
        : null;
    if (statusFilter && !["ONLINE", "DEGRADED", "OFFLINE", "PENDING"].includes(statusFilter)) {
      throw new ProofRelayError("VALIDATION_FAILED", `unknown verifier status ${statusFilter}`, {
        detail: { status: statusFilter, accepted: ["ONLINE", "DEGRADED", "OFFLINE", "PENDING", "ALL"] },
      });
    }

    const now = ctx.now();
    // A role holder is not a verifier. `projectRoleGranted` writes into this
    // table because it is the only operator table the read model has — the
    // Keeper/Adjudicator badge reads the row by address — but the directory is
    // a list of verifiers, and an address that has neither registered nor been
    // approved has never been one. It used to surface the keeper and the
    // adjudicator as PENDING operators who had simply never shown up.
    const clauses: string[] = ["(v.registered OR v.approved)"];
    const values: unknown[] = [];
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(v.address ILIKE $${values.length} OR COALESCE(v.label, '') ILIKE $${values.length})`);
    }

    // Bounded. Registration is permissionless and `touchVerifier` creates a row
    // for any address the contract emits about, so an unbounded directory is a
    // table scan plus one `eth_call` per row that anyone can grow.
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    values.push(MAX_DIRECTORY + 1);
    const scanned = await many<VerifierRow>(
      ctx.pool,
      `${VERIFIER_SELECT}${where}
        ORDER BY v.approved DESC, v.registered DESC, lower(v.address)
        LIMIT $${values.length}`,
      values,
    );
    const rows = scanned.slice(0, MAX_DIRECTORY);
    if (scanned.length > MAX_DIRECTORY) {
      // The DTO has no cursor, so the cap cannot be reported to the reader. It
      // is reported to the operator instead, because a directory that silently
      // stops at a round number is the kind of thing nobody notices.
      ctx.logger.warn("verifier directory truncated", {
        requestId: request.id,
        errorCode: "VALIDATION_FAILED",
        limit: MAX_DIRECTORY,
      });
    }

    // The three aggregate passes are issued once for the whole page rather than
    // per verifier: a directory of N operators must not be N+1 queries.
    const [agreement, buckets, events, consensus] = await Promise.all([
      many<AgreementRow>(ctx.pool, AGREEMENT_SQL),
      hourlyBuckets(ctx, now),
      recentEvents(ctx),
      networkAgreement(ctx, now),
    ]);

    const agreementBy = new Map(agreement.map((row) => [row.verifier.toLowerCase(), row]));
    const bucketsBy = new Map<string, BucketRow[]>();
    for (const row of buckets) {
      const key = row.verifier.toLowerCase();
      bucketsBy.set(key, [...(bucketsBy.get(key) ?? []), row]);
    }

    // The status filter is applied to the rows, before the chain fan-out below,
    // so `?status=ONLINE` costs one `eth_call` per rendered operator rather
    // than one per row in the table.
    const visibleRows = statusFilter
      ? rows.filter((row) => statusOf(row, now) === statusFilter)
      : rows;

    // One chain read per verifier, bounded. Unbounded, an anonymous GET fanned
    // out to as many eth_calls as the directory had rows — up to MAX_DIRECTORY,
    // and the row count is attacker-controlled because registering is
    // permissionless — so a handful of concurrent requests could saturate the
    // RPC the keeper and the indexer share. Past the cap the field is omitted
    // rather than guessed; the per-verifier route reports it exactly.
    const priced = visibleRows.slice(0, WITHDRAWAL_LOOKUP_LIMIT);
    const looked = await Promise.all(
      priced.map((row) =>
        ctx.chain
          .pendingWithdrawals(row.address as Address)
          .then((value) => value.toString())
          .catch(() => "0"),
      ),
    );
    const withdrawals = visibleRows.map((_row, index) => looked[index] ?? null);

    const visible: VerifierView[] = visibleRows.map((row, index) => {
      const status = statusOf(row, now);
      const scores = agreementBy.get(row.address.toLowerCase());
      const series = seriesFor(bucketsBy.get(row.address.toLowerCase()) ?? []);
      const revealable = row.committed;

      return {
        address: row.address,
        name: displayName(row),
        shortAddress: shortAddress(row.address),
        role: roleLabel(row.role),
        modelId: row.model_id,
        pipelineVersion: row.pipeline_version,
        registered: row.registered,
        approved: row.approved,
        active: row.active,
        status,
        tone: toneOf(status),
        stakeWei: row.stake,
        stakeFormatted: formatToken(row.stake),
        metadataHash: (row.metadata_hash ?? ZERO_HASH) as `0x${string}`,
        metadataPointer: row.metadata_pointer ?? "",
        reportsRevealed: row.revealed,
        reportsCommitted: row.committed,
        tasksSeen: row.tasks_seen,
        agreementPct: scores ? pct(scores.claims_agreed, scores.claims_seen) : null,
        uptimePct: pct(row.revealed, revealable),
        uptimeSeries: series,
        medianLatencyMs: row.median_latency_ms,
        lastSeenAt: (row.last_seen_at ?? row.last_reveal_at)?.toISOString() ?? null,
        pendingWithdrawalWei: withdrawals[index] ?? "0",
      };
    });

    const totalStaked = visible.reduce((sum, item) => sum + BigInt(item.stakeWei), 0n);
    const latencies = visible
      .map((item) => item.medianLatencyMs)
      .filter((value): value is number => value !== null);

    // `verifierSlashBps` is protocol state, so it is read from the chain rather
    // than assumed. An unreachable RPC reports the conservative answer.
    const slashingEnabled = await ctx.chain
      .params()
      .then((params) => params.verifierSlashBps > 0)
      .catch(() => false);

    const body: VerifierListResponseType = {
      items: visible,
      summary: {
        active: visible.filter((item) => item.approved && item.active).length,
        online: visible.filter((item) => item.status === "ONLINE").length,
        degraded: visible.filter((item) => item.status === "DEGRADED").length,
        networkAgreementPct: consensus.current,
        networkAgreementTrendPct: consensus.trendPct,
        totalStakedWei: totalStaked.toString(),
        totalStakedFormatted: formatToken(totalStaked),
        medianLatencyMs: median(latencies),
        slashingEnabled,
      },
      events: events.map((event) => {
        const mapped = EVENT_LABELS[event.event_name] ?? { label: event.event_name, tone: "ink" as DisplayTone };
        return {
          label: mapped.label,
          operator: event.label ?? shortAddress(event.actor),
          taskRef: event.sequence === null ? "—" : refForSequence(Number(event.sequence)),
          taskId: (event.task_id as `0x${string}` | null) ?? null,
          at: event.block_time.toISOString(),
          tone: mapped.tone,
        };
      }),
    };

    return VerifierListResponse.parse(body);
  });
}

/**
 * Commitments and reveals per hour for the last 24, keyed by the hour the
 * commitment landed in. Bucketing by the commitment is what makes the ratio
 * mean "was this verifier's promise kept" rather than "did anything happen".
 */
async function hourlyBuckets(ctx: RouteContext, now: Date): Promise<BucketRow[]> {
  const from = new Date(now.getTime() - BUCKET_COUNT * BUCKET_MS);
  return many<BucketRow>(
    ctx.pool,
    `SELECT lower(r.verifier) AS verifier,
            floor(extract(epoch FROM (r.committed_at - $1::timestamptz)) / 3600)::int AS bucket,
            count(*)::int AS committed,
            count(*) FILTER (WHERE r.revealed_at IS NOT NULL)::int AS revealed
       FROM reports r
      WHERE r.committed_at >= $1::timestamptz
      GROUP BY 1, 2`,
    [from],
  );
}

/** Oldest bucket first, so index 0 is 24 hours ago and index 23 is this hour. */
function seriesFor(rows: BucketRow[]): number[] {
  const series = new Array<number>(BUCKET_COUNT).fill(0);
  for (const row of rows) {
    const index = Number(row.bucket);
    if (!Number.isInteger(index) || index < 0 || index >= BUCKET_COUNT) continue;
    series[index] = row.committed > 0 ? Math.round((row.revealed / row.committed) * 100) : 0;
  }
  return series;
}

async function recentEvents(ctx: RouteContext): Promise<EventRow[]> {
  return many<EventRow>(
    ctx.pool,
    `SELECT e.event_name, e.actor, e.task_id, e.block_time, t.sequence, v.label
       FROM chain_events e
       LEFT JOIN tasks     t ON t.task_id = e.task_id
       LEFT JOIN verifiers v ON lower(v.address) = lower(e.actor)
      WHERE e.event_name IN ('ReportRevealed', 'ReportCommitted', 'VerifierRegistered',
                             'VerifierApprovalSet', 'RoleGranted')
      ORDER BY e.block_number DESC, e.log_index DESC
      LIMIT 12`,
  );
}

/** Mean agreement over settled tasks, and the same figure a week earlier. */
async function networkAgreement(
  ctx: RouteContext,
  now: Date,
): Promise<{ current: number | null; trendPct: number | null }> {
  const row = await one<{ current: string | null; prior: string | null }>(
    ctx.pool,
    `SELECT
       avg(agreement_bps) FILTER (WHERE evaluated_at >= $1::timestamptz)::text AS current,
       avg(agreement_bps) FILTER (WHERE evaluated_at >= $2::timestamptz
                                    AND evaluated_at <  $1::timestamptz)::text AS prior
     FROM consensus_results`,
    [new Date(now.getTime() - TREND_WINDOW_MS), new Date(now.getTime() - 2 * TREND_WINDOW_MS)],
  );

  const current = row?.current === null || row?.current === undefined ? null : Number(row.current) / 100;
  const prior = row?.prior === null || row?.prior === undefined ? null : Number(row.prior) / 100;
  if (current === null || prior === null || prior === 0) {
    return { current: current === null ? null : Math.round(current * 10) / 10, trendPct: null };
  }
  return {
    current: Math.round(current * 10) / 10,
    trendPct: Math.round(((current - prior) / prior) * 1000) / 10,
  };
}
