import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    reporters: process.env.GITHUB_ACTIONS ? ["default", "github-actions"] : ["default"],
  },
});
