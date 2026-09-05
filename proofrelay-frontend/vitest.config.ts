import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest reads this instead of `vite.config.ts`, and `vite build` still reads
 * that one — which is the point. The build's root is `client/`, because that is
 * where `index.html` lives; the tests are not all under it. `server/` holds the
 * share-card logic, and running the suite from the client root left those files
 * outside every glob: `vitest run server` reported "no test files found" and
 * exited 1 with nothing wrong.
 *
 * The plugins from `vite.config.ts` are deliberately absent. Nothing under test
 * is JSX or Tailwind, and the Manus dev-server plugins have no business in a
 * test run.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    include: ["client/src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
