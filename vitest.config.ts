import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"tools/**/*.test.ts",
			"worker/src/**/*.test.ts",
			"src/**/*.test.ts",
		],
		globals: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "lcov", "clover", "json"],
			reportsDirectory: "./coverage",
			include: ["worker/src/**/*.ts", "src/**/*.ts", "tools/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/types.ts",
				"scripts/**/*",
				"**/node_modules/**",
				// CLI entry points — no public API, main() runs on import
				"src/index.ts",
				"tools/bootstrap/validate-bootstrap.ts",
				"tools/ci/ci-pipeline.ts",
				"tools/harness/index.ts",
				"tools/sim/dht-cluster-sim.ts",
				// Barrel re-exports — all re-exported symbols are tested at source
				"tools/ledger/src/index.ts",
			],
			thresholds: {
				branches: 85,
				functions: 85,
				lines: 80,
				statements: 80,
			},
			all: true,
		},
	},
});
