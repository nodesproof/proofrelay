/**
 * The HTTP surface, driven through `fastify.inject()` rather than a socket.
 *
 * Two things are being asserted, and they are different:
 *
 * - **The contract.** Every list route's body is parsed with the same zod
 *   schema the UI imports. A route that quietly drops a field or renames one
 *   fails here rather than in a browser.
 * - **The failure modes.** A dependency being down is a 503, an unknown task is
 *   a 404 with a code, a report whose bytes do not rehash is a 409 — and the
 *   409 is asserted from *both* directions, because "never serve mismatched
 *   bytes" has to hold when 0G Storage answers wrongly and when it does not
 *   answer at all.
 *
 * The chain and storage are fakes; Postgres is real, because every one of these
 * routes is a query and a suite that mocked the database would prove nothing
 * about the SQL. The read-model half skips with a printed reason when
 * DATABASE_URL is unreachable.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { loadConfig, loadEnv, repoRoot, type Config } from "@proofrelay/config";
import type {
  DisputeOnChain,
  ProtocolParams,
  ReportOnChain,
  TaskOnChain,
  VerifierOnChain,
} from "@proofrelay/chain-client";
import type {
  DependencyHealth,
  FetchedObject,
  StorageAdapter,
  StoredObject,
} from "@proofrelay/storage-adapter";
import {
  ActivityListResponse,
  ArtifactFetchResponse,
  ArtifactListResponse,
  HealthResponse,
  ProofRelayError,
  TaskDetail,
  TaskListResponse,
  VerifierListResponse,
  WorkspaceStats,
  bytesObjectHash,
  canonicalBytes,
  objectHash,
} from "@proofrelay/schemas";
import { buildApp, type AppChain, type ComputeProbe } from "../app.js";
import { Logger } from "../observability.js";

loadEnv();

const SCHEMA = `proofrelay_routes_test_${process.pid}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const CONTRACT = "0xc1E353cb44eA09729143f06Af97E51FB952b33D7" as Address;
const CREATOR = "0x33d2b4aa407b450aff307f81fec812ff6cd26266" as Address;
const VERIFIER_A = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as Address;
const VERIFIER_B = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as Address;

const TASK_ID = `0x${"a1".repeat(32)}`;
const MANIFEST_HASH = `0x${"b2".repeat(32)}`;
const MANIFEST_POINTER = `local://${"b2".repeat(32)}`;
const REPORT_HASH = `0x${"c3".repeat(32)}`;
const REPORT_POINTER = `local://${"c3".repeat(32)}`;
/** Indexed with a pointer but never fetched, so the cache branch has nothing. */
const ORPHAN_HASH = `0x${"d4".repeat(32)}`;
const TX_HASH = `0x${"e5".repeat(32)}`;

/* ── fakes ───────────────────────────────────────────────────────────────── */

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

const TASK: TaskOnChain = {
  creator: CREATOR,
  bounty: 4_000_000_000_000_000n,
  verifierCount: 2,
  commitDeadline: 1_788_176_097,
  revealDeadline: 1_788_176_997,
  disputeWindow: 900,
  consensusAt: 1_788_176_208,
  committedCount: 2,
  revealedCount: 2,
  rewardBps: 10_000,
  status: 7,
  outcome: 1,
  manifestHash: MANIFEST_HASH as Hex,
  ruleId: `0x${"11".repeat(32)}` as Hex,
  resultHash: `0x${"22".repeat(32)}` as Hex,
  manifestPointer: MANIFEST_POINTER,
};

const PARAMS: ProtocolParams = {
  conflictRateBps: 3_000,
  challengeBondBps: 1_000,
  challengerRewardBps: 5_000,
  adjudicatorSplitBps: 2_000,
  verifierSlashBps: 500,
  minBounty: 100_000_000_000_000n,
  minVerifierStake: 10_000_000_000_000_000n,
  keeperGracePeriod: 259_200,
  adjudicationWindow: 604_800,
  claimGracePeriod: 2_592_000,
};

class FakeChain implements AppChain {
  readonly chainId = 16602;
  readonly contract = CONTRACT;
  paused = false;
  head = 52_400_000n;

  async getTask(): Promise<TaskOnChain> {
    return TASK;
  }
  async getReport(_taskId: Hex, verifier: Address): Promise<ReportOnChain> {
    return {
      verifier,
      commitment: `0x${"cc".repeat(32)}` as Hex,
      revealed: true,
      reportHash: REPORT_HASH as Hex,
      reportPointer: REPORT_POINTER,
      committedAt: 1_788_176_000,
      revealedAt: 1_788_176_200,
    };
  }
  async getTaskVerifiers(): Promise<readonly Address[]> {
    return [VERIFIER_A, VERIFIER_B];
  }
  async getDispute(): Promise<DisputeOnChain> {
    return {
      challenger: `0x${"0".repeat(40)}` as Address,
      bond: 0n,
      evidenceHash: ZERO_HASH,
      evidencePointer: "",
      resolved: false,
      upheld: false,
      outcome: 0,
      openedAt: 0,
      deadline: 0,
      adjudicationHash: ZERO_HASH,
      adjudicationPointer: "",
    };
  }
  async allocationOf(): Promise<bigint> {
    return 2_000_000_000_000_000n;
  }
  async creatorNonce(): Promise<bigint> {
    return 3n;
  }
  async params(): Promise<ProtocolParams> {
    return PARAMS;
  }
  async isPaused(): Promise<boolean> {
    return this.paused;
  }
  async blockNumber(): Promise<bigint> {
    return this.head;
  }
  async getVerifier(): Promise<VerifierOnChain> {
    return {
      registered: true,
      approved: true,
      active: true,
      stake: 10_000_000_000_000_000n,
      slashed: 0n,
      metadataHash: ZERO_HASH,
      metadataPointer: "",
      };
  }
  /** Counted, because "one chain read per rendered operator" is a claim to test. */
  withdrawalReads: Address[] = [];
  async pendingWithdrawals(account: Address): Promise<bigint> {
    this.withdrawalReads.push(account);
    return 0n;
  }
}

/** An in-memory store keyed by both the object hash and the pointer it minted. */
class FakeStorage implements StorageAdapter {
  readonly driver = "local";
  failing = false;
  private readonly objects = new Map<string, Buffer>();

  seed(pointer: string, hash: string, bytes: Buffer): void {
    this.objects.set(pointer, bytes);
    this.objects.set(hash.toLowerCase(), bytes);
  }

  async put(kind: string, value: unknown): Promise<StoredObject> {
    return this.putBytes(kind, canonicalBytes(value));
  }

  async putBytes(kind: string, bytes: Buffer): Promise<StoredObject> {
    const hash = bytesObjectHash(bytes);
    this.seed(`local://${hash.slice(2)}`, hash, bytes);
    return {
      hash,
      objectId: hash.slice(2),
      pointer: `local://${hash.slice(2)}`,
      kind,
      byteLength: bytes.byteLength,
      driver: this.driver,
      latencyMs: 0,
      deduplicated: false,
    };
  }

  async get(reference: string): Promise<FetchedObject> {
    if (this.failing) {
      throw new ProofRelayError("STORAGE_UNAVAILABLE", "fake storage is offline");
    }
    const bytes = this.objects.get(reference) ?? this.objects.get(reference.toLowerCase());
    if (!bytes) {
      throw new ProofRelayError("ARTIFACT_NOT_FOUND", `no object ${reference}`);
    }
    return { bytes, hash: bytesObjectHash(bytes), pointer: reference, source: "storage", kind: null };
  }

  async getJson<T>(reference: string): Promise<T> {
    return JSON.parse((await this.get(reference)).bytes.toString("utf8")) as T;
  }

  async has(reference: string): Promise<boolean> {
    return this.objects.has(reference);
  }

  async health(): Promise<DependencyHealth> {
    return this.failing
      ? { ok: false, detail: "fake storage is offline", latencyMs: 1 }
      : { ok: true, detail: "fake", latencyMs: 1 };
  }
}

class FakeCompute implements ComputeProbe {
  readonly driver = "local";
  failing = false;
  async health(): Promise<DependencyHealth> {
    return this.failing
      ? { ok: false, detail: "fake compute is offline", latencyMs: 1 }
      : { ok: true, detail: "fake", latencyMs: 1 };
  }
}

const config: Config = loadConfig();

function withContract(base: Config): Config {
  return { ...base, chain: { ...base.chain, contract: CONTRACT, chainId: 16602 } };
}

/* ── the app with no reachable database ──────────────────────────────────── */

describe("routes without a database", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;

  beforeAll(async () => {
    // Port 1 refuses immediately, so a probe fails fast rather than hanging the
    // suite on a connect timeout.
    pool = new pg.Pool({
      connectionString: "postgres://nobody:nobody@127.0.0.1:1/nothing",
      connectionTimeoutMillis: 500,
      max: 1,
    });
    pool.on("error", () => undefined);
    app = await buildApp({
      config: withContract(config),
      pool,
      chain: new FakeChain(),
      storage: new FakeStorage(),
      compute: new FakeCompute(),
      logger: new Logger("error"),
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end().catch(() => undefined);
  });

  it("answers /health/live without touching a dependency", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, version: config.version });
  });

  it("returns 503 from /health when a dependency is down", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    const body = HealthResponse.parse(response.json());
    expect(body.ok).toBe(false);
    expect(body.dependencies.database?.ok).toBe(false);
    // The reachable dependencies still report honestly; a 503 is not a blanket
    // "everything is broken".
    expect(body.dependencies.storage?.ok).toBe(true);
    expect(body.dependencies.chain?.ok).toBe(true);
    expect(body.chainId).toBe(16602);
    expect(body.contract).toBe(CONTRACT);
  });

  it("serves /metrics as Prometheus text", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("http_request_latency_ms");
    expect(response.body).toContain("chain_sync_lag_blocks");
  });

  it("echoes the request id it was given", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "trace-abc-123" },
    });
    expect(response.headers["x-request-id"]).toBe("trace-abc-123");
  });

  it("reports the rate limit budget on every response", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.headers["x-ratelimit-limit"]).toBe(String(config.api.rateLimitMax));
    expect(Number(response.headers["x-ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
  });

  it("returns the validation error shape for a malformed body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/nonce",
      payload: { address: "not-an-address" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: { code: string; message: string; detail: { fields: { path: string }[] } };
    };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.detail.fields[0]?.path).toBe("address");
  });

  it("requires an Idempotency-Key on prepare", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks/prepare",
      payload: { title: "t", question: "q", claims: ["c"], bountyWei: "1" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { detail: { header: string } } }).error.detail.header).toBe(
      "Idempotency-Key",
    );
  });

  it("answers an unknown route with the same error envelope", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe("TASK_NOT_FOUND");
  });
});

/* ── the app against the read model ──────────────────────────────────────── */

const reachable = await probeDatabase(DATABASE_URL);
if (!reachable.ok) {
  console.warn(
    `\n[routes.test] READ-MODEL TESTS SKIPPED — ${reachable.detail}\n` +
      "  Point DATABASE_URL at a Postgres and run `npm run migrate`, then re-run to\n" +
      "  exercise /v1/tasks, /v1/verifiers, /v1/artifacts, /v1/activity and /v1/stats.\n",
  );
}
const describeDb = reachable.ok ? describe : describe.skip;

async function probeDatabase(url: string): Promise<{ ok: boolean; detail: string }> {
  if (!url) return { ok: false, detail: "DATABASE_URL is not set" };
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true, detail: "reachable" };
  } catch (error) {
    return { ok: false, detail: String((error as Error).message).slice(0, 160) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

describeDb("routes against the read model", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let storage: FakeStorage;
  let compute: FakeCompute;
  let chain: FakeChain;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();

    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
      max: 4,
    });
    pool.on("error", () => undefined);
    await pool.query(readFileSync(resolve(repoRoot(), "infra/migrations/001_init.sql"), "utf8"));
    await seed(pool);

    storage = new FakeStorage();
    compute = new FakeCompute();
    chain = new FakeChain();
    // The manifest body is stored under the pointer the seeded task names, so
    // the detail route can fetch, rehash and render it.
    const manifest = { kind: "task-manifest", title: "seeded" };
    storage.seed(MANIFEST_POINTER, MANIFEST_HASH, canonicalBytes(manifest));

    app = await buildApp({
      config: withContract(config),
      pool,
      chain,
      storage,
      compute,
      logger: new Logger("error"),
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end().catch(() => undefined);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it("is healthy when every dependency answers", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = HealthResponse.parse(response.json());
    expect(body.ok).toBe(true);
    expect(body.drivers).toEqual({ storage: "local", compute: "local" });
    expect(body.indexer.running).toBe(false);
    expect(body.queue).toMatchObject({ PENDING: 0 });
  });

  it("returns 503 when only storage is down", async () => {
    storage.failing = true;
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      const body = HealthResponse.parse(response.json());
      expect(body.dependencies.database?.ok).toBe(true);
      expect(body.dependencies.storage?.ok).toBe(false);
    } finally {
      storage.failing = false;
    }
  });

  it("lists tasks with per-status counts", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/tasks" });
    expect(response.statusCode).toBe(200);
    const body = TaskListResponse.parse(response.json());
    expect(body.total).toBe(1);
    expect(body.items[0]?.ref).toBe("PR-1048");
    expect(body.counts.VERIFIED).toBe(1);
  });

  it("filters the task list by display status", async () => {
    const verified = await app.inject({ method: "GET", url: "/v1/tasks?status=VERIFIED" });
    expect(TaskListResponse.parse(verified.json()).items).toHaveLength(1);
    const disputed = await app.inject({ method: "GET", url: "/v1/tasks?status=DISPUTED" });
    expect(TaskListResponse.parse(disputed.json()).items).toHaveLength(0);
  });

  it("resolves a PR-1048 handle to the same task as its id", async () => {
    const byRef = await app.inject({ method: "GET", url: "/v1/tasks/PR-1048" });
    expect(byRef.statusCode).toBe(200);
    const detail = TaskDetail.parse(byRef.json());
    expect(detail.taskId).toBe(TASK_ID);

    const byId = await app.inject({ method: "GET", url: `/v1/tasks/${TASK_ID}` });
    expect(TaskDetail.parse(byId.json()).ref).toBe("PR-1048");
  });

  it("404s an unknown task with TASK_NOT_FOUND", async () => {
    const unknown = await app.inject({ method: "GET", url: `/v1/tasks/0x${"9".repeat(64)}` });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe("TASK_NOT_FOUND");

    const unknownRef = await app.inject({ method: "GET", url: "/v1/tasks/PR-9999" });
    expect(unknownRef.statusCode).toBe(404);
    expect((unknownRef.json() as { error: { code: string } }).error.code).toBe("TASK_NOT_FOUND");
  });

  it("serves a verified report from storage", async () => {
    const body = { kind: "verifier-report", note: "the real one" };
    const hash = objectHash(body);
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified, body)
       VALUES ($1, 'verifier-report', $2, $3, 42, 'local', 'r.json', TRUE, $4::jsonb)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`, JSON.stringify(body)],
    );
    storage.seed(`local://${hash.slice(2)}`, hash, canonicalBytes(body));

    const response = await app.inject({ method: "GET", url: `/v1/reports/${hash}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ verified: true, source: "storage" });
  });

  it("409s when storage returns bytes that do not rehash to the report hash", async () => {
    // The pointer resolves, the bytes come back, and they are somebody else's.
    storage.seed(REPORT_POINTER, REPORT_HASH, canonicalBytes({ kind: "verifier-report", tampered: true }));
    const response = await app.inject({ method: "GET", url: `/v1/reports/${REPORT_HASH}` });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; detail: { expected: string } } };
    expect(body.error.code).toBe("CONTENT_HASH_MISMATCH");
    expect(body.error.detail.expected).toBe(REPORT_HASH);
  });

  it("409s rather than serving a mismatched indexed copy when storage is down", async () => {
    storage.failing = true;
    try {
      const response = await app.inject({ method: "GET", url: `/v1/reports/${REPORT_HASH}` });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "CONTENT_HASH_MISMATCH",
      );
    } finally {
      storage.failing = false;
    }
  });

  it("serves the indexed copy as source=cache when storage is down", async () => {
    const body = { kind: "verifier-report", note: "cached and proven" };
    const hash = objectHash(body);
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified, body)
       VALUES ($1, 'verifier-report', $2, $3, 42, 'local', 'c.json', TRUE, $4::jsonb)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`, JSON.stringify(body)],
    );
    storage.failing = true;
    try {
      const response = await app.inject({ method: "GET", url: `/v1/reports/${hash}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ verified: true, source: "cache" });
    } finally {
      storage.failing = false;
    }
  });

  it("404s a report nothing has indexed, and 400s a malformed hash", async () => {
    const missing = await app.inject({ method: "GET", url: `/v1/reports/0x${"7".repeat(64)}` });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("REPORT_NOT_FOUND");

    const malformed = await app.inject({ method: "GET", url: "/v1/reports/not-a-hash" });
    expect(malformed.statusCode).toBe(400);
  });

  it("propagates a storage outage for an artifact it has no copy of", async () => {
    storage.failing = true;
    try {
      const response = await app.inject({ method: "GET", url: `/v1/reports/${ORPHAN_HASH}` });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "STORAGE_UNAVAILABLE",
      );
    } finally {
      storage.failing = false;
    }
  });

  it("returns the verifier directory with 24 uptime buckets", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/verifiers" });
    expect(response.statusCode).toBe(200);
    const body = VerifierListResponse.parse(response.json());
    expect(body.items).toHaveLength(2);
    for (const verifier of body.items) {
      expect(verifier.uptimeSeries).toHaveLength(24);
    }
    const a = body.items.find((item) => item.address.toLowerCase() === VERIFIER_A.toLowerCase());
    expect(a?.name).toBe("Verifier A");
    // One claim, in the agreeing set: 100%. The other verifier dissented.
    expect(a?.agreementPct).toBe(100);
    expect(
      body.items.find((item) => item.address.toLowerCase() === VERIFIER_B.toLowerCase())
        ?.agreementPct,
    ).toBe(0);
    expect(body.summary.slashingEnabled).toBe(true);
    expect(body.summary.networkAgreementPct).toBe(100);
    expect(body.events.length).toBeGreaterThan(0);
    // Every row in this feed opens its transaction, and a registry event has no
    // taskId to fall back on, so the tx is the one field that must never be
    // absent. chain_events.tx_hash is NOT NULL, so a null here is a bug in the
    // query or the mapper rather than missing data.
    for (const event of body.events) {
      expect(event.tx.txHash).toBeTruthy();
      expect(event.tx.explorerUrl).toContain(event.tx.txHash);
    }
  });

  it("returns the artifact index with real aggregates", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/artifacts" });
    expect(response.statusCode).toBe(200);
    const body = ArtifactListResponse.parse(response.json());
    expect(body.summary.totalObjects).toBe(body.items.length);
    expect(body.summary.totalBytes).toBeGreaterThan(0);
    expect(body.summary.hashCoveragePct).toBeGreaterThan(0);
    expect(body.types).toContain("verifier-report");

    const manifest = body.items.find((item) => item.kind === "task-manifest");
    expect(manifest?.taskRef).toBe("PR-1048");
    // `local://` has no explorer page, and inventing one would be a dead link.
    expect(manifest?.storageExplorerUrl).toBeNull();
  });

  it("filters artifacts by type and rejects an unknown one", async () => {
    const filtered = await app.inject({ method: "GET", url: "/v1/artifacts?type=Task%20manifest" });
    const body = ArtifactListResponse.parse(filtered.json());
    expect(body.items.every((item) => item.kind === "task-manifest")).toBe(true);

    const bad = await app.inject({ method: "GET", url: "/v1/artifacts?type=Evidence%20graph" });
    expect(bad.statusCode).toBe(400);
  });

  /**
   * `kind` is the name the frontend data contract gives this parameter and the
   * name the UI has always sent. The route read `type`, so the type filter did
   * nothing at all — and the test above did not catch it because it asked with
   * the same wrong name the route was reading.
   */
  it("filters artifacts by kind, the name the data contract gives the parameter", async () => {
    const all = ArtifactListResponse.parse(
      (await app.inject({ method: "GET", url: "/v1/artifacts" })).json(),
    );
    const filtered = await app.inject({ method: "GET", url: "/v1/artifacts?kind=task-manifest" });
    expect(filtered.statusCode).toBe(200);
    const body = ArtifactListResponse.parse(filtered.json());

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.kind === "task-manifest")).toBe(true);
    // The summary describes the filtered set, so it is what a page count can be
    // built on. An ignored filter would leave it equal to the unfiltered total.
    expect(body.summary.totalObjects).toBe(body.items.length);
    expect(body.summary.totalObjects).toBeLessThan(all.summary.totalObjects);

    const bad = await app.inject({ method: "GET", url: "/v1/artifacts?kind=evidence-graph" });
    expect(bad.statusCode).toBe(400);
  });

  it("falls through to the type alias when kind is present but empty", async () => {
    // `?kind=&type=task-manifest` is what a form with an untouched "all types"
    // select sends alongside a second filter. Reading `kind` merely because the
    // key exists would drop the filter the caller actually set.
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts?kind=&type=task-manifest",
    });
    expect(response.statusCode).toBe(200);
    const body = ArtifactListResponse.parse(response.json());
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.kind === "task-manifest")).toBe(true);
  });

  it("pages by offset without dropping or repeating a row", async () => {
    const all = ArtifactListResponse.parse(
      (await app.inject({ method: "GET", url: "/v1/artifacts" })).json(),
    );
    const total = all.summary.totalObjects;
    expect(total).toBeGreaterThan(2);

    const walked: string[] = [];
    for (let offset = 0; offset < total; offset += 2) {
      const page = await app.inject({ method: "GET", url: `/v1/artifacts?limit=2&offset=${offset}` });
      expect(page.statusCode).toBe(200);
      const body = ArtifactListResponse.parse(page.json());
      expect(body.items.length).toBe(Math.min(2, total - offset));
      walked.push(...body.items.map((item) => item.hash));
    }
    // Same rows, same order, no gaps and no repeats.
    expect(walked).toEqual(all.items.map((item) => item.hash));
  });

  it("addresses the same page by offset as by the cursor it minted", async () => {
    const first = ArtifactListResponse.parse(
      (await app.inject({ method: "GET", url: "/v1/artifacts?limit=2" })).json(),
    );
    expect(first.nextCursor).not.toBeNull();

    const byCursor = await app.inject({
      method: "GET",
      url: `/v1/artifacts?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    });
    const byOffset = await app.inject({ method: "GET", url: "/v1/artifacts?limit=2&offset=2" });
    expect(ArtifactListResponse.parse(byOffset.json()).items.map((i) => i.hash)).toEqual(
      ArtifactListResponse.parse(byCursor.json()).items.map((i) => i.hash),
    );
  });

  it("refuses a cursor and an offset together rather than silently picking one", async () => {
    const first = ArtifactListResponse.parse(
      (await app.inject({ method: "GET", url: "/v1/artifacts?limit=2" })).json(),
    );
    const both = await app.inject({
      method: "GET",
      url: `/v1/artifacts?limit=2&offset=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    });
    expect(both.statusCode).toBe(400);
    expect((both.json() as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  /**
   * `GET /v1/artifacts/{hash}` — the object the Artifacts table links to. The
   * page has always called it; until now the route did not exist, so every row
   * click answered 404.
   */
  it("serves one artifact by its content hash, proved against the bytes", async () => {
    const body = { kind: "consensus-result", note: "the real one" };
    const hash = objectHash(body);
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified, body)
       VALUES ($1, 'consensus-result', $2, $3, 42, 'local', 'c.json', TRUE, $4::jsonb)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`, JSON.stringify(body)],
    );
    storage.seed(`local://${hash.slice(2)}`, hash, canonicalBytes(body));

    const response = await app.inject({ method: "GET", url: `/v1/artifacts/${hash}` });
    expect(response.statusCode).toBe(200);
    const parsed = ArtifactFetchResponse.parse(response.json());
    expect(parsed).toMatchObject({ contentHash: hash, verified: true, source: "storage", kind: "consensus-result" });
    expect(parsed.body).toEqual(body);
    // The size of what was hashed, not the number the index happened to record.
    expect(parsed.byteLength).toBe(canonicalBytes(body).length);
    expect(parsed.byteLength).not.toBe(42);
  });

  it("takes the kind from the bytes it proved, not from the indexed column", async () => {
    // The column is the indexer's reading; the body is inside the hash.
    const body = { kind: "adjudication-report", note: "authoritative" };
    const hash = objectHash(body);
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified, body)
       VALUES ($1, 'task-manifest', $2, $3, 10, 'local', 'k.json', TRUE, $4::jsonb)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`, JSON.stringify(body)],
    );
    storage.seed(`local://${hash.slice(2)}`, hash, canonicalBytes(body));

    const response = await app.inject({ method: "GET", url: `/v1/artifacts/${hash}` });
    expect(ArtifactFetchResponse.parse(response.json()).kind).toBe("adjudication-report");
  });

  it("409s rather than serving an artifact whose bytes do not rehash to its hash", async () => {
    const body = { kind: "task-manifest", note: "genuine" };
    const hash = objectHash(body);
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified)
       VALUES ($1, 'task-manifest', $2, $3, 42, 'local', 'm.json', TRUE)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`],
    );
    // The pointer resolves, the bytes come back, and they are somebody else's.
    storage.seed(`local://${hash.slice(2)}`, hash, canonicalBytes({ kind: "task-manifest", tampered: true }));

    const response = await app.inject({ method: "GET", url: `/v1/artifacts/${hash}` });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("CONTENT_HASH_MISMATCH");
  });

  it("serves the indexed copy as source=cache when storage is down", async () => {
    const body = { kind: "source-snapshot", note: "cached and proven" };
    const hash = objectHash(body);
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified, body)
       VALUES ($1, 'source-snapshot', $2, $3, 42, 'local', 's.json', TRUE, $4::jsonb)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`, JSON.stringify(body)],
    );
    storage.failing = true;
    try {
      const response = await app.inject({ method: "GET", url: `/v1/artifacts/${hash}` });
      expect(response.statusCode).toBe(200);
      expect(ArtifactFetchResponse.parse(response.json())).toMatchObject({ verified: true, source: "cache" });
    } finally {
      storage.failing = false;
    }
  });

  it("409s rather than serving a mismatched indexed copy when storage is down", async () => {
    // A row whose body was corrupted after it was written. The outage must not
    // become cover for serving it.
    const hash = `0x${"7c".repeat(32)}`;
    await pool.query(
      `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name, hash_verified, body)
       VALUES ($1, 'task-manifest', $2, $3, 42, 'local', 'x.json', TRUE, $4::jsonb)`,
      [hash, TASK_ID, `local://${hash.slice(2)}`, JSON.stringify({ kind: "task-manifest", corrupted: true })],
    );
    storage.failing = true;
    try {
      const response = await app.inject({ method: "GET", url: `/v1/artifacts/${hash}` });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe("CONTENT_HASH_MISMATCH");
    } finally {
      storage.failing = false;
    }
  });

  it("404s for a hash nobody indexed, and 400s for something that is not a hash", async () => {
    const missing = await app.inject({ method: "GET", url: `/v1/artifacts/0x${"ab".repeat(32)}` });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("ARTIFACT_NOT_FOUND");

    for (const bad of ["not-a-hash", "0x123", `0x${"zz".repeat(32)}`]) {
      const response = await app.inject({ method: "GET", url: `/v1/artifacts/${bad}` });
      expect(response.statusCode, bad).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("does not shadow the list route", async () => {
    // `/v1/artifacts` and `/v1/artifacts/:contentHash` are different routes and
    // registering the second must not capture the first.
    const list = await app.inject({ method: "GET", url: "/v1/artifacts?limit=2" });
    expect(list.statusCode).toBe(200);
    expect(ArtifactListResponse.parse(list.json()).items.length).toBeGreaterThan(0);
  });

  it("refuses an out-of-range offset instead of clamping it to the cap", async () => {
    // Clamping would answer a request for offset 1e30 with the rows at the cap:
    // content the caller never asked for, served as though it had.
    for (const offset of ["100000", "1e30", "Infinity"]) {
      const response = await app.inject({ method: "GET", url: `/v1/artifacts?limit=2&offset=${offset}` });
      expect(response.statusCode, `offset=${offset}`).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    }
    // In range but past the data is an empty page, not an error.
    const past = await app.inject({ method: "GET", url: "/v1/artifacts?limit=2&offset=9000" });
    expect(past.statusCode).toBe(200);
    const body = ArtifactListResponse.parse(past.json());
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();

    // And an offset that is merely absent or malformed is zero, because "?offset="
    // is what an empty form field sends.
    for (const offset of ["", "abc", "-5"]) {
      const response = await app.inject({ method: "GET", url: `/v1/artifacts?limit=2&offset=${offset}` });
      expect(response.statusCode, `offset=${offset}`).toBe(200);
      expect(ArtifactListResponse.parse(response.json()).items.length).toBe(2);
    }
  });

  it("returns activity newest first with a day bucket and a summary", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/activity" });
    expect(response.statusCode).toBe(200);
    const body = ActivityListResponse.parse(response.json());
    expect(body.items.map((item) => item.title)).toEqual([
      "Report revealed",
      "Commit accepted",
      "Task created",
    ]);
    expect(body.items[0]?.category).toBe("Verification");
    expect(body.items[0]?.day).toMatch(/^(TODAY|YESTERDAY|\d{2} [A-Z]{3} \d{4})$/);
    expect(body.summary.lastBlock).toBe(52_352_130);
    expect(body.summary.openSignals).toBe(0);
    expect(body.categories).toContain("Compute");
  });

  it("filters activity by category", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/activity?category=Settlement" });
    const body = ActivityListResponse.parse(response.json());
    expect(body.items).toHaveLength(0);

    const bad = await app.inject({ method: "GET", url: "/v1/activity?category=Nonsense" });
    expect(bad.statusCode).toBe(400);
  });

  it("pages activity with an opaque cursor", async () => {
    const first = await app.inject({ method: "GET", url: "/v1/activity?limit=1" });
    const page = ActivityListResponse.parse(first.json());
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/v1/activity?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    });
    const next = ActivityListResponse.parse(second.json());
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
  });

  it("rejects a hand-edited cursor with a 400 rather than a database error", async () => {
    const cursor = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    for (const url of [
      "/v1/activity?cursor=bm90LWEtY3Vyc29y",
      `/v1/activity?cursor=${cursor("abc|def")}`,
      `/v1/artifacts?cursor=${cursor("not-a-date|0xabc")}`,
      // Every one of these is a value JavaScript accepts and the column does
      // not. `Number.isInteger(1e30)` is true and 1e30 reaches Postgres as the
      // literal `1e+30`; 999999999999 overflows `log_index`'s int4;
      // `new Date` parses both the GMT+9999 form and `+275760-09-13`, and
      // `timestamptz` parses neither. All four used to be 500 INTERNAL.
      `/v1/activity?cursor=${cursor("1e30|0")}`,
      `/v1/activity?cursor=${cursor("0|1e30")}`,
      `/v1/activity?cursor=${cursor("0|999999999999")}`,
      `/v1/activity?cursor=${cursor("-1|-1")}`,
      `/v1/artifacts?cursor=${cursor("Sat Sep 02 2026 12:00:00 GMT+9999|0xaa")}`,
      `/v1/tasks?cursor=${cursor("+275760-09-13T00:00:00.000Z|0xaa")}`,
      `/v1/tasks?cursor=${cursor("2026-09-02|0xaa")}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("still pages with a cursor it minted itself", async () => {
    const first = await app.inject({ method: "GET", url: "/v1/artifacts?limit=1" });
    const page = ArtifactListResponse.parse(first.json());
    expect(page.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: "GET",
      url: `/v1/artifacts?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(ArtifactListResponse.parse(second.json()).items[0]?.hash).not.toBe(page.items[0]?.hash);
  });

  it("rejects a status filter the column cannot hold rather than 500ing", async () => {
    // `t.status = ANY($1::int[])` with 2^31 raises 22003 in Postgres, which the
    // mapper can only render as INTERNAL. A status outside the enum is a
    // client mistake and has to say so.
    for (const status of ["2147483648", "99999999999999999999"]) {
      const response = await app.inject({ method: "GET", url: `/v1/tasks?status=${status}` });
      expect(response.statusCode, status).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    }
    // The contract's own codes still work, including the numeric spelling the
    // runbook's curl examples use.
    const open = await app.inject({ method: "GET", url: "/v1/tasks?status=7" });
    expect(open.statusCode).toBe(200);
    expect(TaskListResponse.parse(open.json()).items).toHaveLength(1);
  });

  it("reads the chain once per rendered operator, not once per row", async () => {
    chain.withdrawalReads = [];
    const all = await app.inject({ method: "GET", url: "/v1/verifiers" });
    expect(VerifierListResponse.parse(all.json()).items).toHaveLength(2);
    expect(chain.withdrawalReads).toHaveLength(2);

    // A filter that renders nobody must cost no chain read at all; the fan-out
    // used to run over every row in the table before the filter was applied.
    chain.withdrawalReads = [];
    const none = await app.inject({ method: "GET", url: "/v1/verifiers?status=OFFLINE" });
    expect(VerifierListResponse.parse(none.json()).items).toHaveLength(0);
    expect(chain.withdrawalReads).toHaveLength(0);
  });

  it("survives a consensus row whose claims column is not an array", async () => {
    // Guarded because a set-returning function in the FROM clause runs before
    // the WHERE that would have excluded its row: one malformed row used to
    // take the whole verifier directory down with a 500.
    await pool.query("UPDATE consensus_results SET claims = '{\"not\":\"an array\"}'::jsonb");
    try {
      const verifiers = await app.inject({ method: "GET", url: "/v1/verifiers" });
      expect(verifiers.statusCode).toBe(200);
      const body = VerifierListResponse.parse(verifiers.json());
      // No claims can be expanded, so there is no agreement sample — null,
      // not a plausible-looking percentage.
      expect(body.items.every((item) => item.agreementPct === null)).toBe(true);

      const stats = await app.inject({ method: "GET", url: "/v1/stats" });
      expect(stats.statusCode).toBe(200);
      expect(WorkspaceStats.parse(stats.json()).evidenceCoverageSampleSize).toBe(0);
    } finally {
      await pool.query("UPDATE consensus_results SET claims = $1::jsonb", [
        JSON.stringify([
          {
            claimId: "claim-001",
            agreeingVerifiers: [VERIFIER_A.toLowerCase()],
            dissentingVerifiers: [VERIFIER_B.toLowerCase()],
            verdicts: [
              { verifier: VERIFIER_A.toLowerCase(), verdict: "SUPPORTED", confidence: 0.9 },
              { verifier: VERIFIER_B.toLowerCase(), verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.4 },
            ],
          },
        ]),
      ]);
    }
  });

  it("returns workspace stats", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/stats" });
    expect(response.statusCode).toBe(200);
    const body = WorkspaceStats.parse(response.json());
    expect(body.totalTasks).toBe(1);
    expect(body.verifiedTasks).toBe(1);
    expect(body.bountiesSettledWei).toBe("4000000000000000");
  });
});

/* ── seed ────────────────────────────────────────────────────────────────── */

/**
 * One settled task with two verifiers, one of whom dissented on the only claim.
 * That single shape exercises every list route: a task with a display status, a
 * consensus artifact with an agreeing set, two report rows, three chain events
 * and three indexed artifacts.
 */
async function seed(pool: pg.Pool): Promise<void> {
  const createdAt = new Date("2026-09-02T08:00:00.000Z");
  const revealedAt = new Date("2026-09-02T11:30:00.000Z");
  const committedAt = new Date("2026-09-02T11:00:00.000Z");

  await pool.query(
    `INSERT INTO manifests (manifest_hash, manifest_pointer, chain_id, creator, rule_id,
                            title, question, claim_count, source_count, body, verified)
     VALUES ($1, $2, 16602, $3, $4, 'Seeded task', 'Does the seed work?', 1, 1, $5::jsonb, TRUE)`,
    [
      MANIFEST_HASH,
      MANIFEST_POINTER,
      CREATOR,
      TASK.ruleId,
      JSON.stringify({ kind: "task-manifest", title: "seeded" }),
    ],
  );

  await pool.query(
    `INSERT INTO tasks (task_id, sequence, creator, status, outcome, bounty, verifier_count,
                        committed_count, revealed_count, reward_bps, manifest_hash, manifest_pointer,
                        rule_id, result_hash, commit_deadline, reveal_deadline, dispute_deadline,
                        consensus_at, title, question, claim_count, source_count, primary_source,
                        manifest_verified, created_block, tx_hash, created_at, updated_at)
     VALUES ($1, 48, $2, 7, 1, '4000000000000000', 2, 2, 2, 10000, $3, $4, $5, $6,
             $7, $8, $9, $10, 'Seeded task', 'Does the seed work?', 1, 1, 'docs.0g.ai',
             TRUE, 52352128, $11, $12, $13)`,
    [
      TASK_ID,
      CREATOR,
      MANIFEST_HASH,
      MANIFEST_POINTER,
      TASK.ruleId,
      TASK.resultHash,
      new Date("2026-09-02T09:00:00.000Z"),
      new Date("2026-09-02T11:45:00.000Z"),
      new Date("2026-09-02T12:15:00.000Z"),
      revealedAt,
      TX_HASH,
      createdAt,
      revealedAt,
    ],
  );

  for (const [index, verifier] of [VERIFIER_A, VERIFIER_B].entries()) {
    await pool.query(
      `INSERT INTO verifiers (address, registered, approved, active, stake, metadata_hash,
                              metadata_pointer, last_seen_at, updated_at)
       VALUES ($1, TRUE, TRUE, TRUE, '10000000000000000', $2, $3, $4, now())`,
      [verifier, `0x${"f".repeat(64)}`, "local://meta", revealedAt],
    );
    await pool.query(
      `INSERT INTO reports (task_id, verifier, commitment, report_hash, report_pointer, status,
                            model_id, pipeline_version, body, supported, contradicted, insufficient,
                            mean_confidence, compute_latency_ms, body_verified,
                            committed_at, revealed_at, commit_tx, reveal_tx)
       VALUES ($1, $2, $3, $4, $5, 'REVEALED', 'qwen2.5-omni', 'entailment-v1', $6::jsonb,
               1, 0, 0, 0.9, $7, TRUE, $8, $9, $10, $10)`,
      [
        TASK_ID,
        verifier,
        `0x${"cc".repeat(32)}`,
        index === 0 ? REPORT_HASH : ORPHAN_HASH,
        index === 0 ? REPORT_POINTER : `local://${"d4".repeat(32)}`,
        JSON.stringify({
          kind: "verifier-report",
          verifier: { verifierId: index === 0 ? "verifier-a" : "verifier-b" },
        }),
        180 + index * 40,
        committedAt,
        revealedAt,
        TX_HASH,
      ],
    );
  }

  await pool.query(
    `INSERT INTO consensus_results (task_id, outcome, agreement_bps, result_hash, result_pointer,
                                    conflicts, rewarded_verifiers, claims, evaluated_at)
     VALUES ($1, 'CONSENSUS', 10000, $2, 'local://result', '[]'::jsonb, $3::jsonb, $4::jsonb, $5)`,
    [
      TASK_ID,
      TASK.resultHash,
      JSON.stringify([VERIFIER_A.toLowerCase()]),
      JSON.stringify([
        {
          claimId: "claim-001",
          agreeingVerifiers: [VERIFIER_A.toLowerCase()],
          dissentingVerifiers: [VERIFIER_B.toLowerCase()],
          verdicts: [
            { verifier: VERIFIER_A.toLowerCase(), verdict: "SUPPORTED", confidence: 0.9 },
            { verifier: VERIFIER_B.toLowerCase(), verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.4 },
          ],
        },
      ]),
      revealedAt,
    ],
  );

  const events: [string, number, number, string | null, Date, Record<string, unknown>][] = [
    ["TaskCreated", 52_352_128, 0, CREATOR, createdAt, { taskId: TASK_ID, bounty: "4000000000000000" }],
    ["ReportCommitted", 52_352_129, 0, VERIFIER_A, committedAt, { taskId: TASK_ID, verifier: VERIFIER_A }],
    ["ReportRevealed", 52_352_130, 0, VERIFIER_A, revealedAt, { taskId: TASK_ID, reportHash: REPORT_HASH }],
  ];
  for (const [name, block, logIndex, actor, blockTime, payload] of events) {
    await pool.query(
      `INSERT INTO chain_events (chain_id, tx_hash, log_index, block_number, block_time,
                                 event_name, task_id, actor, payload)
       VALUES (16602, $1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        `0x${block.toString(16).padStart(64, "0")}`,
        logIndex,
        block,
        blockTime,
        name,
        TASK_ID,
        actor,
        JSON.stringify(payload),
      ],
    );
  }

  // `hash_verified` is TRUE on the report row while its body is somebody else's:
  // the row that was proven on the way in and corrupted afterwards. That is the
  // case `/v1/reports` re-hashes for, and the one this seed exists to produce.
  await pool.query(
    `INSERT INTO artifacts (object_hash, kind, task_id, pointer, byte_length, driver, name,
                            hash_verified, body, artifact_created_at, first_seen_block)
     VALUES ($1, 'task-manifest', $2, $3, 1802, 'local', 'task-manifest_PR-1048.json',
             TRUE, NULL, $4, 52352128),
            ($5, 'verifier-report', $2, $6, 4096, 'local', 'verifier-report_PR-1048.json',
             TRUE, $10::jsonb, $7, 52352130),
            ($8, 'verifier-report', $2, $9, 4096, 'local', 'verifier-report_b.json',
             FALSE, NULL, $7, 52352130)`,
    [
      MANIFEST_HASH,
      TASK_ID,
      MANIFEST_POINTER,
      createdAt,
      REPORT_HASH,
      REPORT_POINTER,
      revealedAt,
      ORPHAN_HASH,
      `local://${"d4".repeat(32)}`,
      JSON.stringify({ kind: "verifier-report", note: "corrupted after it was verified" }),
    ],
  );

  // What the contract actually paid out; `bountiesSettledWei` sums this table
  // rather than the escrow, because an allocation is money someone can claim.
  await pool.query(
    `INSERT INTO allocations (task_id, beneficiary, amount, tx_hash)
     VALUES ($1, $2, '2000000000000000', $4), ($1, $3, '2000000000000000', $4)`,
    [TASK_ID, VERIFIER_A, VERIFIER_B, TX_HASH],
  );
}
