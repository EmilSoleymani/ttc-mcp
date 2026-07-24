import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/smoke/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Transport/IO glue (entry points, the network+unzip ingest driver) is
      // covered by the real ingest run + smoke workflow rather than the unit
      // gate (stack-baseline: inherits go-planner's test-architecture spec §1).
      exclude: [
        "src/entry/**",
        "src/gtfs/run-ingest.ts",
        "src/**/*.test.ts",
        "src/**/test-support.ts",
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
