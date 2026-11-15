import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "node:zlib": new URL("./src/browser-zlib.ts", import.meta.url).pathname,
    },
  },
  server: {
    strictPort: true,
    port: 4173,
    proxy: {
      "/market-api": {
        target:
          loadEnv(mode, ".", "BUYER_GATEWAY_URL").BUYER_GATEWAY_URL ??
          "http://127.0.0.1:4180",
      },
      "/buyer-api": {
        target:
          loadEnv(mode, ".", "BUYER_GATEWAY_URL").BUYER_GATEWAY_URL ??
          "http://127.0.0.1:4180",
      },
    },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 1600 },
}));
