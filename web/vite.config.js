import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "chrome100",
    outDir: "dist",
    emptyOutDir: true,
  },
});
