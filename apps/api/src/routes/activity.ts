/**
 * `GET /v1/activity` — the timeline, straight off `chain_events`.
 *
 * Every row here was decoded from a log the indexer really saw, which is why
 * `payload` is served verbatim: the "View payload" drawer is the thing that
 * makes the rest of the page checkable, and a summarised payload would defeat
 * it.
 *
 * The category list is the one the DTO pins, and `Compute` is deliberately in
 * it while producing no rows: compute happens off-chain inside a verifier, and
 * the only durable record of it is the `compute[]` trace inside a verifier
 * report. Offering a filter that always returns nothing is honest; inventing
 * chain events for it would not be.
 *
 * Ordering is `(block_number, log_index)` descending, which is also the cursor.
 * Both are immutable once written, so a page boundary cannot drift while
 * someone is reading.
 */
import type { FastifyInstance } from "fastify";
import {
  ACTIVITY_CATEGORIES,
  ActivityListResponse,
  ProofRelayError,
  dayBucket,
  formatToken,
  outcomeName,
  shortAddress,
  utcClock,
  type ActivityEvent,
  type ActivityListResponse as ActivityListResponseType,
  type DisplayTone,
} from "@proofrelay/schemas";
import { txUrl } from "@proofrelay/chain-client";
import { cursorInteger, decodeCursor, encodeCursor, type RouteContext } from "../app.js";
import { many, one } from "../db.js";
import { refForSequence } from "../services/refs.js";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

type Category = (typeof ACTIVITY_CATEGORIES)[number];

interface EventRow {
  id: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: Date;
  event_name: string;
  task_id: string | null;
  actor: string | null;
  payload: Record<string, unknown> | null;
  sequence: number | null;
  verifier_label: string | null;
}

interface Descriptor {
  category: Category;
  title: string;
  icon: string;
  tone: DisplayTone;
  detail: (payload: Record<string, unknown>, ref: string) => string;
}

const DESCRIPTORS: Record<string, Descriptor> = {
  TaskCreated: {
    category: "Verification",
    title: "Task created",
    icon: "file-plus",
    tone: "sky",
    detail: (payload, ref) => `${ref} escrowed ${formatToken(String(payload.bounty ?? "0"))}`,
  },
  TaskManifest: {
    category: "Storage",
    title: "Manifest anchored",
    icon: "database",
    tone: "sky",
    detail: (payload, ref) => `${ref} manifest at ${String(payload.manifestPointer ?? "—")}`,
  },
  ReportCommitted: {
    category: "Verification",
    title: "Commit accepted",
    icon: "lock",
    tone: "sky",
    detail: (_payload, ref) => `${ref} received a sealed verdict`,
  },
  ReportRevealed: {
    category: "Verification",
    title: "Report revealed",
    icon: "eye",
    tone: "lime",
    detail: (payload, ref) => `${ref} report ${String(payload.reportPointer ?? payload.reportHash ?? "—")}`,
  },
  ConsensusReached: {
    category: "Verification",
    title: "Consensus reached",
    icon: "scale",
    tone: "lime",
    // The event carries rewardBps — the share of the bounty the named
    // beneficiaries split — not the agreement ratio. Labelling it "agreement"
    // reads as 0% on every conflict, which is precisely the case where the
    // real agreement figure matters most; the consensus artifact holds that
    // number and the task detail shows it.
    detail: (payload, ref) => {
      const outcome = outcomeName(Number(payload.outcome ?? 0));
      const bps = Number(payload.rewardBps ?? 0);
      return bps > 0
        ? `${ref} ${outcome.toLowerCase().replace("_", " ")} · ${bps / 100}% of the bounty to the named verifiers`
        : `${ref} ${outcome.toLowerCase().replace("_", " ")} · the contract derives each share`;
    },
  },
  TaskFinalized: {
    category: "Settlement",
    title: "Task finalized",
    icon: "check-circle",
    tone: "lime",
    detail: (payload, ref) => `${ref} settled as ${outcomeName(Number(payload.outcome ?? 0)).toLowerCase().replace("_", " ")}`,
  },
  RewardAllocated: {
    category: "Settlement",
    title: "Reward allocated",
    icon: "coins",
    tone: "lime",
    detail: (payload, ref) => `${ref} ${formatToken(String(payload.amount ?? "0"))} allocated`,
  },
  ChallengeOpened: {
    category: "Dispute",
    title: "Challenge opened",
    icon: "gavel",
    tone: "coral",
    detail: (payload, ref) => `${ref} bond ${formatToken(String(payload.bond ?? "0"))}`,
  },
  DisputeResolved: {
    category: "Dispute",
    title: "Dispute resolved",
    icon: "gavel",
    tone: "coral",
    detail: (payload, ref) => `${ref} ${payload.upheld === true ? "upheld" : "rejected"}`,
  },
  VerifierRegistered: {
    category: "Registry",
    title: "Verifier registered",
    icon: "user-plus",
    tone: "sky",
    detail: (payload) => `stake ${formatToken(String(payload.stake ?? "0"))}`,
  },
  VerifierApprovalSet: {
    category: "Registry",
    title: "Approval changed",
    icon: "shield-check",
    tone: "coral",
    detail: (payload) => (payload.approved === true ? "approved" : "approval withdrawn"),
  },
  RoleGranted: {
    category: "Registry",
    title: "Role granted",
    icon: "key",
    tone: "ink",
    detail: (payload) => `role ${String(payload.role ?? "—")}`,
  },
};

const FALLBACK: Descriptor = {
  category: "Verification",
  title: "Chain event",
  icon: "activity",
  tone: "ink",
  detail: (_payload, ref) => ref,
};

function categoryFilter(raw: unknown): Category | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase() === "ALL") return null;
  const match = ACTIVITY_CATEGORIES.find(
    (category) => category.toLowerCase() === trimmed.toLowerCase(),
  );
  if (!match) {
    throw new ProofRelayError("VALIDATION_FAILED", `unknown activity category ${trimmed}`, {
      detail: { category: trimmed, accepted: [...ACTIVITY_CATEGORIES, "ALL"] },
    });
  }
  return match;
}

/** The event names that belong to a category — the filter runs in SQL, not in JS. */
function namesFor(category: Category): string[] {
  return Object.entries(DESCRIPTORS)
    .filter(([, descriptor]) => descriptor.category === category)
    .map(([name]) => name);
}

export async function registerActivityRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  app.get("/v1/activity", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
    );
    const category = categoryFilter(query.category);
    const search = typeof query.q === "string" ? query.q.trim() : "";
    const now = ctx.now();

    const clauses: string[] = [];
    const values: unknown[] = [];
    if (category) {
      values.push(namesFor(category));
      clauses.push(`e.event_name = ANY($${values.length}::text[])`);
    }
    if (search) {
      values.push(`%${search}%`);
      const placeholder = `$${values.length}`;
      clauses.push(
        `(COALESCE(e.task_id, '') ILIKE ${placeholder} OR COALESCE(e.actor, '') ILIKE ${placeholder} ` +
          `OR e.event_name ILIKE ${placeholder} OR e.tx_hash ILIKE ${placeholder})`,
      );
    }

    const cursor = decodeCursor(typeof query.cursor === "string" ? query.cursor : undefined, 2);
    if (cursor) {
      // Bound-checked against the columns, not against `Number.isInteger`, which
      // accepts 1e30 — a value that reaches Postgres as the literal `1e+30` and
      // comes back as a 500 with no error code the client can act on.
      const block = cursorInteger(cursor[0], 64, query.cursor);
      const logIndex = cursorInteger(cursor[1], 32, query.cursor);
      values.push(block, logIndex);
      clauses.push(
        `(e.block_number, e.log_index) < ($${values.length - 1}::bigint, $${values.length}::int)`,
      );
    }
    values.push(limit + 1);

    const rows = await many<EventRow>(
      ctx.pool,
      `SELECT e.id, e.tx_hash, e.log_index, e.block_number, e.block_time, e.event_name,
              e.task_id, e.actor, e.payload, t.sequence, v.label AS verifier_label
         FROM chain_events e
         LEFT JOIN tasks     t ON t.task_id = e.task_id
         LEFT JOIN verifiers v ON lower(v.address) = lower(e.actor)
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY e.block_number DESC, e.log_index DESC
        LIMIT $${values.length}`,
      values,
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor([last.block_number, last.log_index]) : null;

    const items: ActivityEvent[] = page.map((row) => {
      const descriptor = DESCRIPTORS[row.event_name] ?? FALLBACK;
      const payload = row.payload ?? {};
      const ref = row.sequence === null ? "—" : refForSequence(Number(row.sequence));
      const at = row.block_time.toISOString();
      return {
        // `${txHash}:${logIndex}` rather than the surrogate key: it is stable
        // across a read-model rebuild, which the surrogate is not.
        id: `${row.tx_hash}:${row.log_index}`,
        day: dayBucket(at, now),
        at,
        time: utcClock(at),
        title: descriptor.title,
        detail: descriptor.detail(payload, ref),
        actor: row.verifier_label ?? shortAddress(row.actor),
        actorAddress: (row.actor as `0x${string}` | null) ?? null,
        taskRef: ref,
        taskId: (row.task_id as `0x${string}` | null) ?? null,
        category: descriptor.category,
        icon: descriptor.icon,
        tone: descriptor.tone,
        hash: row.tx_hash,
        tx: {
          txHash: row.tx_hash,
          blockNumber: Number(row.block_number),
          explorerUrl: txUrl(ctx.config.chain.chainId, row.tx_hash),
        },
        payload,
      };
    });

    const summary = await summarise(ctx, now);

    const body: ActivityListResponseType = {
      items,
      nextCursor,
      summary,
      categories: [...ACTIVITY_CATEGORIES],
    };

    return ActivityListResponse.parse(body);
  });
}

/**
 * The four numbers above the timeline. `openSignals` is unresolved disputes —
 * the only thing on this page that asks an operator to act — and its detail
 * line says so rather than leaving a bare count to be interpreted.
 */
async function summarise(
  ctx: RouteContext,
  now: Date,
): Promise<ActivityListResponseType["summary"]> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterdayStart = new Date(dayStart.getTime() - 86_400_000);

  const row = await one<{
    events_today: number;
    events_yesterday: number;
    last_block: number | null;
    last_block_time: Date | null;
  }>(
    ctx.pool,
    `SELECT
       count(*) FILTER (WHERE block_time >= $1::timestamptz)::int AS events_today,
       count(*) FILTER (WHERE block_time >= $2::timestamptz
                          AND block_time <  $1::timestamptz)::int AS events_yesterday,
       max(block_number)::int AS last_block,
       max(block_time) AS last_block_time
     FROM chain_events`,
    [dayStart, yesterdayStart],
  );

  const disputes = await one<{ open: number }>(
    ctx.pool,
    "SELECT count(*) FILTER (WHERE NOT resolved)::int AS open FROM disputes",
  );

  const today = row?.events_today ?? 0;
  const yesterday = row?.events_yesterday ?? 0;
  const open = disputes?.open ?? 0;

  return {
    eventsToday: today,
    eventsYesterday: yesterday,
    // No prior day is not a 0% change, it is no measurement.
    trendPct: yesterday === 0 ? null : Math.round(((today - yesterday) / yesterday) * 1000) / 10,
    lastBlock: row?.last_block ?? null,
    lastBlockAgeSec: row?.last_block_time
      ? Math.max(0, Math.round((now.getTime() - row.last_block_time.getTime()) / 1_000))
      : null,
    openSignals: open,
    openSignalDetail:
      open === 0 ? "no challenge is open" : `${open} challenge${open === 1 ? "" : "s"} awaiting adjudication`,
  };
}
