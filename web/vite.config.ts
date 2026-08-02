import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@polysignal/shared": path.resolve(dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(dirname, "..")] },
    proxy: {
      "/api": "http://localhost:8788",
      "/ws": { target: "ws://localhost:8788", ws: true },
    },
  },
});
