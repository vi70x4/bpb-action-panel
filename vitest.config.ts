import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/ledger/tests/**/*.test.ts"],
    globals: true,
  },
});
