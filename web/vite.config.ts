import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@polysignal/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, "..")] },
    proxy: {
      "/api": "http://localhost:8788",
      "/ws": { target: "ws://localhost:8788", ws: true },
    },
  },
});
