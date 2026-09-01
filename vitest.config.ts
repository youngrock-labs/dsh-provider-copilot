import { defineConfig } from "vitest/config";

// Coverage is opt-in — install `@vitest/coverage-v8` (matching your vitest
// version) and run `npx vitest run --coverage` to produce reports.
export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
    },
});
