import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Writes dist/sw.js: the service worker (src/sw/service-worker.js) with the
 *  request rules (src/sw/sw-logic.js) inlined and, in front, this build's id
 *  and the files an offline launch needs: the shell and every chunk the entry
 *  loads eagerly, with their CSS. Lazy route chunks are kept as they are first
 *  loaded. Computed from the bundle itself, so the list cannot drift from what
 *  was built (#4226). */
function serviceWorker(): Plugin {
  return {
    name: "cobblr-service-worker",
    apply: "build",
    generateBundle(_opts, bundle) {
      const entry = Object.values(bundle).find((f) => f.type === "chunk" && f.isEntry);
      if (!entry) this.error("no entry chunk to build the service worker's precache from");
      const eager = new Set<string>();
      const walk = (name: string) => {
        const c = bundle[name];
        if (!c || eager.has(name)) return;
        eager.add(name);
        if (c.type !== "chunk") return;
        c.imports.forEach(walk);
        for (const css of c.viteMetadata?.importedCss ?? []) eager.add(css);
      };
      walk(entry.fileName);
      const precache = ["/", "/prepaint.js", "/favicon.svg", "/icon-192.png", ...[...eager].sort().map((f) => `/${f}`)];
      const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
      const logic = read("./src/sw/sw-logic.js").replace(/^export /gm, "");
      const build = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const BUILD = ${JSON.stringify(build)};\nconst PRECACHE = ${JSON.stringify(precache)};\n${logic}\n${read("./src/sw/service-worker.js")}`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
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
        target: process.env.VITE_API_PROXY ?? "http://api:4000",
        changeOrigin: true,
      },
    },
  },
  // `vite preview` serves the BUILT app, and it does not inherit server.proxy,
  // so without this every /api call from a previewed build 404s. It matters for
  // the nightly tour: a recording should be made against the same built assets
  // the product ships (the rig serves the built web image), not against a dev
  // server that transpiles on demand and is a different thing on camera.
  preview: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://api:4000",
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
          // rrule (~30KB gz) is reached ONLY via the lazy
          // `import("../lib/cadence-expand")` a heatmap fires when its view
          // declares an expected cadence — a rare, opt-in case. ViewsPage is
          // imported EAGERLY by App, so without this line the dynamic import
          // buys nothing: this map would still sweep rrule into the PRELOADED
          // `vendor` bundle and tax every first load for a grid most people
          // never open. (Measured: it did exactly that until this was added.)
          // Return undefined so Rollup leaves it in the dynamic chunk.
          if (id.includes("node_modules/rrule")) return undefined;
          // Everything else from node_modules goes into a generic
          // vendor bundle.
          return "vendor";
        },
      },
    },
  },
});
