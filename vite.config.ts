import { resolve } from "node:path";
import { defineConfig } from "vite";

const injectedHookName = "src/panel/injected-hook";

export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "src/devtools/devtools": resolve(__dirname, "src/devtools/devtools.html"),
        "src/panel/panel": resolve(__dirname, "src/panel/panel.html"),
        [injectedHookName]: resolve(__dirname, "src/panel/injected-hook.ts"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === injectedHookName) {
            return "src/panel/injected-hook.js";
          }

          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
