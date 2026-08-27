import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: mode === "pages" ? "/Chess-Leak/" : "./",
  build: {
    target: "chrome100",
    outDir: "dist",
    emptyOutDir: true,
  },
}));
