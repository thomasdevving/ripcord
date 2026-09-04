/**
 * Vitest's own config. It exists because vitest falls back to `vite.config.ts`
 * when there is no vitest config, and that one sets `root: "web"` for the
 * browser build — so adding it silently made vitest look for tests under web/,
 * find none, and exit 1. "No test files found" reads as a tooling hiccup rather
 * than as the entire suite having stopped running, so the root and include glob
 * are pinned here and the two configurations stay independent.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // `fileURLToPath`, NOT `.pathname`. A file URL keeps its path
      // percent-encoded, so `.pathname` yields ".../Exit%20Window/server/shared"
      // for any checkout whose path contains a space — a directory that does not
      // exist, which makes every test importing `@shared` fail to load with a
      // module-resolution error. It works on CI only because the repository is
      // checked out as `ripcord`, with no space to encode.
      "@shared": fileURLToPath(new URL("./server/shared", import.meta.url)),
    },
  },
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    // No network in CI, per the project's testing convention: pure-logic unit
    // tests only. Fixture verification against real mainnet targets is a manual
    // pass with a recorded result, never a silently-skipped CI job.
    environment: "node",
    /**
     * Test FILES run one at a time. `test/webappJobs.test.ts` forks real child
     * processes to exercise the job manager's worker lifecycle; running that
     * alongside the rest of the suite means forking children from inside an
     * already-forked pool worker while every core is busy, and child startup
     * then misses even a generous bound. Measured: parallel 14s with one
     * failure, sequential 6.5s and green — a test-harness interaction, not a
     * product defect, and nothing to trade.
     */
    fileParallelism: false,
    // A backstop above vitest's 5s default, not the working bound: the job
    // suite's own `until()` helper fails first, at 15s, with a message naming
    // the condition that was not met.
    testTimeout: 25_000,
  },
});
