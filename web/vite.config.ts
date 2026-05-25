import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Local dev: proxy /api → the api container so the browser
    // doesn't need CORS. In prod the nginx in the `web` container
    // handles the same job at port 8080.
    proxy: {
      "/api": {
        target: "http://api:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Vite's default build dir is "assets" — which collides with the
    // app's own /assets SPA route (the assets module). nginx would
    // 301 /assets → /assets/ and serve the static bundle dir instead
    // of the SPA. Namespace the build output so app routes are free.
    assetsDir: "static",
    // Bumping the warning threshold past the React + ecosystem
    // vendor chunk; the manual splits below keep page chunks tiny.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Manual chunk strategy: keep slow-moving vendors in their
        // own files so they cache across redeploys instead of
        // re-downloading on every app-code change.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("/scheduler/")) {
            return "vendor-react";
          }
          if (id.includes("@tanstack/react-query")) return "vendor-react-query";
          if (id.includes("react-router")) return "vendor-react-router";
          if (id.includes("react-markdown") || id.includes("remark") || id.includes("micromark") || id.includes("mdast")) {
            return "vendor-markdown";
          }
          if (id.includes("qrcode")) return "vendor-qrcode";
          if (id.includes("lucide-react")) return "vendor-icons";
          // Everything else from node_modules goes into a generic
          // vendor bundle.
          return "vendor";
        },
      },
    },
  },
});
