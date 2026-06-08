import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // occt-import-js is an Emscripten/WASM module (the STEP-preview CAD kernel).
  // esbuild's dev pre-bundler mangles Emscripten glue + can't see the `?url`
  // wasm import, so exclude it — it's lazy-loaded only when a STEP is opened.
  optimizeDeps: { exclude: ["occt-import-js"] },
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
          // three.js (~600KB) is reached ONLY via the lazy STL renderer
          // (core-file-preview). Returning undefined keeps it out of the
          // eager `vendor` bundle so Rollup leaves it in the dynamic
          // chunk — it loads only when an STL is actually previewed.
          if (id.includes("node_modules/three")) return undefined;
          // @zxing (the camera-scan compatibility decoder) is reached ONLY
          // via the lazy `import("@zxing/browser")` on /scan/camera when the
          // native BarcodeDetector is absent (older iOS Safari). It's a
          // UMD-style bundle whose top-level `exports` assignment crashes the
          // SPA if pulled into the EAGER vendor chunk (same failure mode as
          // the @xyflow incident). Return undefined so Rollup keeps it in the
          // dynamic chunk — it loads only when the fallback actually runs.
          if (id.includes("node_modules/@zxing")) return undefined;
          // Everything else from node_modules goes into a generic
          // vendor bundle.
          return "vendor";
        },
      },
    },
  },
});
