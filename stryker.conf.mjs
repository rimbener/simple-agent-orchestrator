/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "bun",
  plugins: ["@hughescr/stryker-bun-runner"],
  coverageAnalysis: "perTest",
  // The initial (dry) run must finish inside bun.timeout plus the runner's fixed
  // drain allowance (~30s). The default of 10s capped that at ~40s total, which the
  // suite outgrew during M4 (~46s) — the dry run then "times out" spuriously.
  bun: { timeout: 120_000 },
  // cli.ts is only exercised via spawned subprocesses, which per-test
  // coverage cannot observe — every mutant in it would report NoCoverage.
  mutate: ["src/**/*.ts", "!src/cli.ts"],
  reporters: ["html", "clear-text", "progress"],
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
};
