/**
 * `GET /v1/stats` — the Overview page's headline numbers.
 *
 * Every field is computed in `workspaceStats`, which carries the rule that
 * matters: a metric with no sample is `null` next to its sample size, never a
 * plausible-looking figure. The route exists only to bind that to a URL.
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

export async function registerStatsRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/v1/stats", async () => ctx.tasks.workspaceStats());
}
