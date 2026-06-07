import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ESM-aware fake timers need this
    fakeTimers: { shouldAdvanceTime: false },
  },
});
