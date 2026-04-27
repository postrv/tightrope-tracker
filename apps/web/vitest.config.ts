import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environmentMatchGlobs: [
      // Component / DOM tests opt into happy-dom by filename.
      ["src/components/**/*.test.ts", "happy-dom"],
      ["src/components/**/*.test.tsx", "happy-dom"],
      ["src/pages/**/*.test.ts", "happy-dom"],
    ],
  },
});
