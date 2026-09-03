#!/usr/bin/env node
/**
 * Exercises every HTTP route against a running API, including the failure
 * paths — a suite that only walks the happy path proves the API answers, not
 * that it refuses what it should.
 *
 * Each case asserts the status AND, where the response is a DTO, that the body
 * parses against the zod schema the UI consumes. A route that returns 200 with
 * a shape the frontend cannot read is a failure here.
 *
 *   node scripts/checks/api-surface.mjs
 */
import {
  ActivityListResponse,
  ArtifactFetchResponse,
  ArtifactListResponse,
  HealthResponse,
  ReportFetchResponse,
  TaskDetail,
  TaskListResponse,
  VerifierListResponse,
  WorkspaceStats,
} from "@proofrelay/schemas";
import { loadConfig } from "@proofrelay/config";

const config = loadConfig();
const BASE = process.env.API_URL ?? `http://127.0.0.1:${config.api.port}`;

let passed = 0;
const failures = [];
const skipped = [];

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

/**
 * @param name   what is being asserted, in the voice of the requirement
 * @param check  async () => true | string | {skip: reason}
 *
 * A check that cannot run against the data this database happens to hold is a
 * third outcome, not a pass. Returning `true` for it would report a guarantee
 * nothing verified — which is how an assertion that only ever early-returns
 * gets to look green for its whole life.
 */
async function expect(name, check) {
  try {
    const result = await check();
    if (result && typeof result === "object" && result.skip) {
      skipped.push([name, result.skip]);
      console.log(`  skip  ${name}\n          ${result.skip}`);
    } else if (result === true) {
      passed += 1;
      console.log(`  ok    ${name}`);
    } else {
      failures.push([name, String(result)]);
      console.log(`  FAIL  ${name}\n          ${result}`);
    }
  } catch (error) {
    failures.push([name, String(error?.message ?? error)]);
    console.log(`  FAIL  ${name}\n          ${String(error?.message ?? error).slice(0, 200)}`);
  }
}

const parses = (schema, body) => {
  const result = schema.safeParse(body);
  return result.success ? true : `body does not match its schema: ${result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
};

console.log(`API surface — ${BASE}\n`);

/* ── health and observability ────────────────────────────────────────────── */
console.log("health");
await expect("GET /health/live answers without touching a dependency", async () => {
  const { status } = await call("/health/live");
  return status === 200 || `status ${status}`;
});
await expect("GET /health reports every dependency and parses", async () => {
  const { status, body } = await call("/health");
  if (status !== 200) return `status ${status} — a dependency is down: ${JSON.stringify(body?.dependencies)}`;
  const shape = parses(HealthResponse, body);
  if (shape !== true) return shape;
  const missing = ["database", "storage", "compute", "chain"].filter((k) => !body.dependencies[k]);
  return missing.length ? `missing dependency probes: ${missing}` : true;
});
await expect("GET /health names the chain and contract it is really on", async () => {
  const { body } = await call("/health");
  return body.chainId === config.chain.chainId && body.contract.toLowerCase() === config.chain.contract.toLowerCase()
    ? true
    : `reports chain ${body.chainId} contract ${body.contract}`;
});
await expect("GET /metrics exposes the runbook's metric names", async () => {
  const { status, body } = await call("/metrics");
  if (status !== 200) return `status ${status}`;
  const required = [
    "task_created_total", "task_completed_total", "verifier_commit_total", "verifier_reveal_total",
    "dispute_opened_total", "payout_total", "job_retry_total", "chain_sync_lag_blocks",
    "compute_request_latency_ms", "storage_upload_latency_ms", "http_request_latency_ms",
  ];
  const missing = required.filter((m) => !String(body).includes(m));
  return missing.length ? `missing metrics: ${missing.join(", ")}` : true;
});

/* ── read routes ─────────────────────────────────────────────────────────── */
console.log("\nread model");
let firstTaskId = null;
let firstRef = null;

await expect("GET /v1/tasks returns a list that parses", async () => {
  const { status, body } = await call("/v1/tasks?limit=5");
  if (status !== 200) return `status ${status}`;
  const shape = parses(TaskListResponse, body);
  if (shape !== true) return shape;
  firstTaskId = body.items[0]?.taskId ?? null;
  firstRef = body.items[0]?.ref ?? null;
  return body.items.length > 0 ? true : "no tasks indexed — run npm run seed first";
});
await expect("GET /v1/tasks filters by display status", async () => {
  const { status, body } = await call("/v1/tasks?status=VERIFIED&limit=20");
  if (status !== 200) return `status ${status}`;
  const wrong = body.items.filter((t) => t.status !== "VERIFIED");
  return wrong.length === 0 ? true : `returned ${wrong.length} non-VERIFIED rows`;
});
await expect("GET /v1/tasks search narrows the result", async () => {
  const all = await call("/v1/tasks?limit=50");
  const hit = await call(`/v1/tasks?q=${encodeURIComponent(firstRef ?? "PR-")}&limit=50`);
  return hit.status === 200 && hit.body.items.length <= all.body.items.length
    ? true
    : `search returned ${hit.body?.items?.length} of ${all.body?.items?.length}`;
});
await expect("GET /v1/tasks rejects a cursor it did not mint", async () => {
  const { status } = await call("/v1/tasks?cursor=" + Buffer.from("1e30|0").toString("base64url"));
  return status === 400 ? true : `status ${status}, expected 400`;
});
await expect("GET /v1/tasks survives an injection attempt in a filter", async () => {
  const { status } = await call(`/v1/tasks?q=${encodeURIComponent("'; DROP TABLE tasks; --")}`);
  if (status !== 200) return `status ${status}`;
  const after = await call("/v1/tasks?limit=1");
  return after.status === 200 ? true : "the tasks table did not survive";
});
await expect("GET /v1/tasks/:taskId returns a detail that parses", async () => {
  if (!firstTaskId) return "no task to read";
  const { status, body } = await call(`/v1/tasks/${firstTaskId}`);
  if (status !== 200) return `status ${status}`;
  return parses(TaskDetail, body);
});
await expect("GET /v1/tasks/:ref resolves the PR-#### handle to the same task", async () => {
  if (!firstRef) return "no ref to read";
  const { status, body } = await call(`/v1/tasks/${firstRef}`);
  return status === 200 && body.taskId === firstTaskId ? true : `status ${status}, got ${body?.taskId}`;
});
await expect("GET /v1/tasks/:taskId is 404 for a task that does not exist", async () => {
  const { status, body } = await call(`/v1/tasks/0x${"ab".repeat(32)}`);
  return status === 404 && body?.error?.code === "TASK_NOT_FOUND" ? true : `status ${status} code ${body?.error?.code}`;
});
await expect("GET /v1/stats parses and never invents a metric", async () => {
  const { status, body } = await call("/v1/stats");
  if (status !== 200) return `status ${status}`;
  const shape = parses(WorkspaceStats, body);
  if (shape !== true) return shape;
  // A metric with no sample must be null, not zero pretending to be measured.
  if (body.evidenceCoverageSampleSize === 0 && body.evidenceCoveragePct !== null) {
    return "evidenceCoveragePct is a number with an empty sample";
  }
  if (body.medianVerificationSampleSize === 0 && body.medianVerificationSec !== null) {
    return "medianVerificationSec is a number with an empty sample";
  }
  return true;
});
await expect("GET /v1/verifiers parses and reports real uptime buckets", async () => {
  const { status, body } = await call("/v1/verifiers");
  if (status !== 200) return `status ${status}`;
  const shape = parses(VerifierListResponse, body);
  if (shape !== true) return shape;
  const bad = body.items.filter((v) => v.uptimeSeries.length !== 24);
  return bad.length === 0 ? true : `${bad.length} verifiers without 24 hourly buckets`;
});
await expect("GET /v1/artifacts parses and every row carries a hash", async () => {
  const { status, body } = await call("/v1/artifacts?limit=25");
  if (status !== 200) return `status ${status}`;
  const shape = parses(ArtifactListResponse, body);
  if (shape !== true) return shape;
  const noHash = body.items.filter((a) => !/^0x[0-9a-f]{64}$/.test(a.hash));
  return noHash.length === 0 ? true : `${noHash.length} artifacts without a content hash`;
});
/* The Artifacts table pages by offset, and the filter it pages within is the
   one the reader chose. Both had a way of being silently wrong: the route read
   `type` while every caller sent `kind`, so the type filter did nothing at all
   and the page count described a set nobody asked for. */
await expect("GET /v1/artifacts?kind= actually filters, and the summary follows it", async () => {
  const all = await call("/v1/artifacts?limit=1");
  if (all.status !== 200) return `status ${all.status}`;
  const kind = all.body.types?.[0];
  if (!kind) return "the response named no artifact kinds to filter by";
  const filtered = await call(`/v1/artifacts?limit=25&kind=${encodeURIComponent(kind)}`);
  if (filtered.status !== 200) return `status ${filtered.status}`;
  const wrong = filtered.body.items.filter((a) => a.kind !== kind);
  if (wrong.length) return `${wrong.length} rows of another kind came back for kind=${kind}`;
  if (filtered.body.summary.totalObjects > all.body.summary.totalObjects) {
    return "the filtered total exceeds the unfiltered one";
  }
  // The bug this pins: an ignored filter returns the whole table, so the two
  // totals match exactly while the rows look plausible.
  return filtered.body.summary.totalObjects < all.body.summary.totalObjects ||
    all.body.summary.totalObjects === filtered.body.items.length
    ? true
    : `kind=${kind} did not narrow anything — the filter is being ignored`;
});
await expect("GET /v1/artifacts pages by offset without dropping or repeating a row", async () => {
  const size = 8;
  const first = await call(`/v1/artifacts?limit=${size}`);
  if (first.status !== 200) return `status ${first.status}`;
  const total = first.body.summary.totalObjects;
  if (total <= size) return { skip: `only ${total} artifacts indexed — one page, so there is no paging to walk` };
  const seen = [];
  for (let offset = 0; offset < total; offset += size) {
    const { status, body } = await call(`/v1/artifacts?limit=${size}&offset=${offset}`);
    if (status !== 200) return `status ${status} at offset ${offset}`;
    // The indexer writes to this table while the walk runs. A row inserted
    // mid-walk lands at the top (the sort is newest first) and shifts every
    // later page by one, so a mismatch here is only a defect if the set did
    // not change underneath us — which the total says.
    if (body.summary.totalObjects !== total) {
      return { skip: `the registry grew from ${total} to ${body.summary.totalObjects} rows mid-walk` };
    }
    const expected = Math.min(size, total - offset);
    if (body.items.length !== expected) {
      return `offset ${offset} returned ${body.items.length} rows, expected ${expected}`;
    }
    seen.push(...body.items.map((a) => a.hash));
  }
  if (seen.length !== total) return `walked ${seen.length} rows, the summary claims ${total}`;
  return new Set(seen).size === total ? true : `${total - new Set(seen).size} rows appeared on two pages`;
});
await expect("GET /v1/artifacts offset and cursor address the same page", async () => {
  const size = 8;
  const first = await call(`/v1/artifacts?limit=${size}`);
  if (first.status !== 200) return `status ${first.status}`;
  if (!first.body.nextCursor) return { skip: "one page of artifacts — no second page to compare the two paging modes on" };
  const viaCursor = await call(`/v1/artifacts?limit=${size}&cursor=${encodeURIComponent(first.body.nextCursor)}`);
  const viaOffset = await call(`/v1/artifacts?limit=${size}&offset=${size}`);
  if (viaCursor.status !== 200 || viaOffset.status !== 200) {
    return `cursor ${viaCursor.status}, offset ${viaOffset.status}`;
  }
  const a = viaCursor.body.items.map((x) => x.hash).join(",");
  const b = viaOffset.body.items.map((x) => x.hash).join(",");
  return a === b ? true : "the keyset walk and the offset disagree about page 2";
});
await expect("GET /v1/artifacts refuses a cursor and an offset together", async () => {
  const first = await call("/v1/artifacts?limit=8");
  if (!first.body?.nextCursor) {
    return { skip: "one page of artifacts — no cursor exists to pair with an offset" };
  }
  const { status, body } = await call(
    `/v1/artifacts?limit=8&offset=8&cursor=${encodeURIComponent(first.body.nextCursor)}`,
  );
  return status === 400 && body?.error?.code === "VALIDATION_FAILED"
    ? true
    : `status ${status} code ${body?.error?.code} — two paging modes at once were accepted`;
});
await expect("GET /v1/artifacts answers an offset past the end with an empty page", async () => {
  const { status, body } = await call("/v1/artifacts?limit=8&offset=9000");
  if (status !== 200) return `status ${status}`;
  return body.items.length === 0 && body.nextCursor === null
    ? true
    : `${body.items.length} rows past the end, nextCursor ${body.nextCursor}`;
});
await expect("GET /v1/artifacts refuses an out-of-range offset instead of clamping it", async () => {
  // Clamping would answer a request for offset 1e30 with the rows at the cap —
  // content the caller never asked for, served as though it had.
  for (const offset of ["100000", "1e30", "Infinity"]) {
    const { status, body } = await call(`/v1/artifacts?limit=8&offset=${offset}`);
    if (status !== 400 || body?.error?.code !== "VALIDATION_FAILED") {
      return `offset=${offset} answered ${status} ${body?.error?.code ?? "with rows"}`;
    }
  }
  // And an offset that is merely wrong-looking is still treated as zero rather
  // than refused, because "?offset=" is what an empty form field sends.
  const benign = await call("/v1/artifacts?limit=3&offset=");
  return benign.status === 200 && benign.body.items.length === 3
    ? true
    : `an empty offset answered ${benign.status} with ${benign.body?.items?.length} rows`;
});
await expect("GET /v1/activity parses and is ordered newest first", async () => {
  const { status, body } = await call("/v1/activity?limit=25");
  if (status !== 200) return `status ${status}`;
  const shape = parses(ActivityListResponse, body);
  if (shape !== true) return shape;
  const times = body.items.map((e) => Date.parse(e.at));
  const ordered = times.every((t, i) => i === 0 || times[i - 1] >= t);
  return ordered ? true : "events are not in descending time order";
});
await expect("GET /v1/activity filters by category", async () => {
  const { status, body } = await call("/v1/activity?category=Settlement&limit=20");
  if (status !== 200) return `status ${status}`;
  const wrong = body.items.filter((e) => e.category !== "Settlement");
  return wrong.length === 0 ? true : `${wrong.length} rows outside the requested category`;
});

/* ── artifact integrity ──────────────────────────────────────────────────── */
console.log("\nintegrity");
await expect("GET /v1/reports/:hash returns a hash-verified body", async () => {
  const list = await call("/v1/artifacts?limit=50");
  const report = list.body.items.find((a) => a.kind === "verifier-report" && a.byteLength > 0);
  if (!report) return "no verifier report indexed to check";
  const { status, body } = await call(`/v1/reports/${report.hash}`);
  if (status !== 200) return `status ${status} for ${report.hash}`;
  const shape = parses(ReportFetchResponse, body);
  if (shape !== true) return shape;
  return body.verified === true ? true : `served a report it could not verify (source ${body.source})`;
});
await expect("GET /v1/reports/:hash is 404 for a hash nobody stored", async () => {
  const { status } = await call(`/v1/reports/0x${"cd".repeat(32)}`);
  return status === 404 ? true : `status ${status}, expected 404`;
});
/* The route the Artifacts table links every row to. It did not exist until now,
   so every row click on that page answered 404 with "no route for GET". */
await expect("GET /v1/artifacts/:hash proves the object it serves", async () => {
  const list = await call("/v1/artifacts?limit=50");
  const artifact = list.body.items?.find((a) => a.byteLength > 0);
  if (!artifact) return { skip: "no indexed object with a known size to fetch" };
  const { status, body } = await call(`/v1/artifacts/${artifact.hash}`);
  if (status !== 200) return `status ${status} for ${artifact.hash}`;
  const shape = parses(ArtifactFetchResponse, body);
  if (shape !== true) return shape;
  if (body.contentHash !== artifact.hash) return "answered with a different hash than was asked for";
  // `verified` is a comparison the route performed, so a 200 that is not
  // verified would mean the guarantee had been quietly downgraded to a flag.
  return body.verified === true ? true : `served an object it could not verify (source ${body.source})`;
});
await expect("GET /v1/artifacts/:hash agrees with the list row it came from", async () => {
  const list = await call("/v1/artifacts?limit=50");
  const artifact = list.body.items?.find((a) => a.byteLength > 0);
  if (!artifact) return { skip: "no indexed object with a known size to fetch" };
  const { status, body } = await call(`/v1/artifacts/${artifact.hash}`);
  if (status !== 200) return `status ${status}`;
  if (body.kind !== artifact.kind) return `list says kind ${artifact.kind}, object says ${body.kind}`;
  return body.pointer === artifact.pointer ? true : `list says pointer ${artifact.pointer}, object says ${body.pointer}`;
});
await expect("GET /v1/artifacts/:hash is 404 for a hash nobody stored", async () => {
  const { status, body } = await call(`/v1/artifacts/0x${"cd".repeat(32)}`);
  return status === 404 && body?.error?.code === "ARTIFACT_NOT_FOUND"
    ? true
    : `status ${status} code ${body?.error?.code}`;
});
await expect("GET /v1/artifacts/:hash rejects a malformed hash rather than querying with it", async () => {
  for (const bad of ["not-a-hash", "0x123"]) {
    const { status, body } = await call(`/v1/artifacts/${bad}`);
    if (status !== 400 || body?.error?.code !== "VALIDATION_FAILED") {
      return `${bad} answered ${status} ${body?.error?.code}`;
    }
  }
  return true;
});
await expect("GET /v1/reports rejects a malformed hash rather than querying with it", async () => {
  const { status } = await call("/v1/reports/not-a-hash");
  return status === 400 || status === 404 ? true : `status ${status}`;
});

/* ── mutation guards ─────────────────────────────────────────────────────── */
console.log("\nguards");
const prepareBody = (over = {}) => ({
  creator: "0x33D2b4aA407b450aFF307F81fEC812FF6CD26266",
  title: "surface check",
  question: "Is this API refusing what it should?",
  claims: ["0G Storage can be used standalone."],
  sources: [{ inlineText: "0G Storage can be used standalone.", label: "https://docs.0g.ai/" }],
  verifierCount: 2,
  commitWindowSec: 120,
  revealWindowSec: 120,
  disputeWindowSec: 120,
  bountyWei: "1000000000000000",
  ...over,
});
const post = (path, body, headers = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

await expect("POST /v1/tasks/prepare refuses an unauthenticated caller with no creator", async () => {
  const body = prepareBody();
  delete body.creator;
  const { status, body: out } = await post("/v1/tasks/prepare", body, { "idempotency-key": `guard-${Date.now()}` });
  return status === 401 && out?.error?.code === "UNAUTHORIZED" ? true : `status ${status} code ${out?.error?.code}`;
});
await expect("POST /v1/tasks/prepare requires an Idempotency-Key", async () => {
  const { status, body } = await post("/v1/tasks/prepare", prepareBody());
  return status === 400 ? true : `status ${status} code ${body?.error?.code}`;
});
await expect("POST /v1/tasks/prepare rejects an email address hidden in a claim", async () => {
  const { status, body } = await post(
    "/v1/tasks/prepare",
    prepareBody({ claims: ["Release notes were sent to alice.brown@example.com on 10 August."] }),
    { "idempotency-key": `pii-${Date.now()}` },
  );
  if (status !== 400 || body?.error?.code !== "PERSONAL_DATA_REJECTED") {
    return `status ${status} code ${body?.error?.code}`;
  }
  return JSON.stringify(body).includes("alice.brown@example.com")
    ? "the rejection echoed the address back"
    : true;
});
await expect("POST /v1/tasks/prepare rejects a Luhn-valid card number", async () => {
  const { status, body } = await post(
    "/v1/tasks/prepare",
    prepareBody({ claims: ["The charge landed on card 4111111111111111 yesterday."] }),
    { "idempotency-key": `pan-${Date.now()}` },
  );
  return status === 400 && body?.error?.code === "PERSONAL_DATA_REJECTED" ? true : `status ${status} code ${body?.error?.code}`;
});
await expect("POST /v1/tasks/prepare refuses a source pointing at link-local metadata", async () => {
  const { status, body } = await post(
    "/v1/tasks/prepare",
    prepareBody({ sources: ["http://169.254.169.254/latest/meta-data/"] }),
    { "idempotency-key": `ssrf-${Date.now()}` },
  );
  // Either the request is refused outright, or the source is snapshotted as
  // blocked and carries a reason — never fetched. Prepare answers 201.
  if (status === 400) return true;
  if (status >= 200 && status < 300) {
    const blocked = body.sources?.every((s) => s.status !== "OK");
    return blocked ? true : "a link-local source was fetched";
  }
  return `status ${status}`;
});
await expect("POST /v1/tasks/prepare refuses a loopback source", async () => {
  const { status, body } = await post(
    "/v1/tasks/prepare",
    prepareBody({ sources: ["http://127.0.0.1:8080/health"] }),
    { "idempotency-key": `lo-${Date.now()}` },
  );
  if (status === 400) return true;
  if (status >= 200 && status < 300) {
    const blocked = body.sources?.every((s) => s.status !== "OK");
    return blocked ? true : "a loopback source was fetched";
  }
  return `status ${status}`;
});
await expect("POST /v1/tasks/prepare rejects a bounty below the contract minimum", async () => {
  const { status } = await post("/v1/tasks/prepare", prepareBody({ bountyWei: "1" }), {
    "idempotency-key": `low-${Date.now()}`,
  });
  return status === 400 ? true : `status ${status}, expected 400`;
});
await expect("POST /v1/tasks/prepare rejects a verifier count outside the contract bounds", async () => {
  const { status } = await post("/v1/tasks/prepare", prepareBody({ verifierCount: 99 }), {
    "idempotency-key": `vc-${Date.now()}`,
  });
  return status === 400 ? true : `status ${status}, expected 400`;
});

/* ── auth ────────────────────────────────────────────────────────────────── */
console.log("\nauth");
let nonce = null;
await expect("POST /v1/auth/nonce issues a single-use challenge", async () => {
  const { status, body } = await post("/v1/auth/nonce", { address: "0x33D2b4aA407b450aFF307F81fEC812FF6CD26266" });
  if (status !== 200) return `status ${status}`;
  nonce = body.nonce;
  const bindsChain = String(body.message).includes(String(config.chain.chainId));
  return nonce && bindsChain ? true : "the challenge does not bind the chain id";
});
await expect("POST /v1/auth/verify rejects a signature that is not one", async () => {
  const { status, body } = await post("/v1/auth/verify", {
    address: "0x33D2b4aA407b450aFF307F81fEC812FF6CD26266",
    signature: `0x${"11".repeat(65)}`,
    nonce: nonce ?? "missing",
  });
  return status === 401 ? true : `status ${status} code ${body?.error?.code}`;
});
await expect("POST /v1/auth/verify rejects an unknown nonce", async () => {
  const { status } = await post("/v1/auth/verify", {
    address: "0x33D2b4aA407b450aFF307F81fEC812FF6CD26266",
    signature: `0x${"22".repeat(65)}`,
    nonce: "nonce-that-was-never-issued",
  });
  return status === 401 ? true : `status ${status}`;
});

/* ── rate limiting ───────────────────────────────────────────────────────── */
console.log("\nlimits");
await expect("every response carries rate-limit headers", async () => {
  const { headers } = await call("/v1/stats");
  return headers.get("x-ratelimit-limit") ? true : "no x-ratelimit-limit header";
});
await expect("every response carries a correlation id", async () => {
  const { headers } = await call("/v1/stats");
  return headers.get("x-request-id") ? true : "no x-request-id header";
});
await expect("an oversized body is refused", async () => {
  const { status } = await post(
    "/v1/tasks/prepare",
    prepareBody({ question: "x".repeat(3 * 1024 * 1024) }),
    { "idempotency-key": `big-${Date.now()}` },
  );
  return status === 400 || status === 413 ? true : `status ${status}`;
});
await expect("an unknown route is a 404, not a stack trace", async () => {
  const { status, body } = await call("/v1/does-not-exist");
  return status === 404 && !String(JSON.stringify(body)).includes("at ") ? true : `status ${status}`;
});

/* ── report ──────────────────────────────────────────────────────────────── */
console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const [name, why] of failures) console.log(`  ${name}\n    ${why}`);
}
process.exit(failures.length === 0 ? 0 : 1);
