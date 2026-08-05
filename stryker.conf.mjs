/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "bun",
  plugins: ["@hughescr/stryker-bun-runner"],
  coverageAnalysis: "perTest",
  // cli.ts is only exercised via spawned subprocesses, which per-test
  // coverage cannot observe — every mutant in it would report NoCoverage.
  mutate: ["src/**/*.ts", "!src/cli.ts"],
  reporters: ["html", "clear-text", "progress"],
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
};
