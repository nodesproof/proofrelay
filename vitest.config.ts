import { defineConfig } from "vitest/config";

/**
 * The database-backed suites isolate their writes in a transaction they roll
 * back, but a rollback cannot hide rows that were already there — and pointing
 * them at the development database means the indexer's real tasks make
 * "this metric has no sample" fail for reasons that have nothing to do with the
 * code. So the tests get their own database by default.
 *
 * Create it once with:
 *   createdb proofrelay_test && DATABASE_URL=$TEST_DATABASE_URL npm run migrate
 *
 * A suite whose database is unreachable skips itself with an explanation rather
 * than failing, so `npx vitest run` still works on a machine with no Postgres.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres:///proofrelay_test?host=%2Fvar%2Frun%2Fpostgresql";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "workers/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "proofrelay-frontend/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
});
