import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tools/**/*.test.ts", "worker/src/**/*.test.ts"],
		globals: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "lcov", "clover", "json"],
			reportsDirectory: "./coverage",
			include: [
				"worker/src/**/*.ts",
				"tools/logging/**/*.ts",
				"tools/mock/**/*.ts",
				"tools/spec/**/*.ts",
				"tools/monitor/**/*.ts",
				"tools/ledger/src/**/*.ts",
			],
			exclude: ["**/*.test.ts", "**/types.ts", "**/node_modules/**"],
			thresholds: {
				branches: 60,
				functions: 60,
				lines: 60,
				statements: 60,
			},
			all: true,
		},
	},
});
