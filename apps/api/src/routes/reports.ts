/**
 * `GET /v1/reports/{reportHash}`.
 *
 * The contract holds a hash; 0G Storage holds bytes; a pointer is a retrieval
 * hint and nothing more. So this route never trusts the pointer it followed —
 * it hashes the bytes it actually received and compares them with the hash in
 * the URL, and `verified` is that comparison rather than a claim about where
 * the bytes came from.
 *
 * The two behaviours the runbook promises — a mismatch is never served, and a
 * storage outage degrades to the indexed copy rather than failing — live in
 * `services/verified-object.ts`, which `/v1/artifacts/{hash}` shares. This
 * route's own job is finding the pointer.
 */
import type { FastifyInstance } from "fastify";
import { ProofRelayError, ReportFetchResponse } from "@proofrelay/schemas";
import type { RouteContext } from "../app.js";
import { one } from "../db.js";
import { fetchVerifiedObject } from "../services/verified-object.js";

interface ReportParams {
  reportHash: string;
}

interface LocatedReport {
  pointer: string | null;
  body: unknown;
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export async function registerReportRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get<{ Params: ReportParams }>("/v1/reports/:reportHash", async (request) => {
    const raw = request.params.reportHash.trim();
    if (!HASH_PATTERN.test(raw)) {
      throw new ProofRelayError("VALIDATION_FAILED", "a report hash is 0x followed by 64 hex digits", {
        detail: { reportHash: raw.slice(0, 80) },
      });
    }
    const reportHash = raw.toLowerCase();

    // `reports` carries the pointer the chain published; `artifacts` carries the
    // body the indexer already proved against it. Either may be missing — a
    // report revealed one block ago has a pointer and no body yet.
    const located = await one<LocatedReport>(
      ctx.pool,
      `SELECT
         COALESCE(r.report_pointer, a.pointer) AS pointer,
         a.body                                AS body
       FROM (SELECT $1::text AS hash) k
       LEFT JOIN reports   r ON lower(r.report_hash) = k.hash
       LEFT JOIN artifacts a ON lower(a.object_hash) = k.hash
       LIMIT 1`,
      [reportHash],
    );

    const cached = located?.body ?? null;
    if (!located?.pointer && cached === null) {
      throw new ProofRelayError("REPORT_NOT_FOUND", `no report is indexed for ${reportHash}`, {
        detail: { reportHash },
      });
    }

    // The hash is a valid reference on its own — every adapter accepts one —
    // so a row with no pointer can still be fetched.
    const verified = await fetchVerifiedObject(ctx, {
      hash: reportHash,
      pointer: located?.pointer ?? null,
      cached,
      requestId: String(request.id),
      noun: "report",
    });

    return ReportFetchResponse.parse({
      reportHash,
      verified: true,
      source: verified.source,
      pointer: located?.pointer ?? null,
      report: verified.body,
    });
  });
}
