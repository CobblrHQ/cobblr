import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withImportAgain } from "./src/lib/import-again";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The opened page's code starts downloading with the shell, not after it
 *  (#4945). Every section is a lazy chunk, so a first load used to fetch the
 *  shell, run it, and only then ask for the page: one more round trip, which
 *  on a slow phone link is half a second or more. This writes a few lines into
 *  index.html that read the address and preload that section's chunk and the
 *  chunks it imports, beside the shell. The sections are the table in
 *  src/lib/route-prefetch.ts, read here so the two cannot disagree. Each link
 *  says it is a hint (data-route-hint): one that fails is not the app failing
 *  to start, so the boot guard does not reload for it (#7676). */
function routePreload(): Plugin {
  const table = readFileSync(resolve(HERE, "src/lib/route-prefetch.ts"), "utf8");
  const rows = [...table.matchAll(/\["(\/[^"]*)", \(\) => ([^\n]+)\],/g)].map((m) => ({
    prefix: m[1]!,
    specs: [...m[2]!.matchAll(/import\("([^"]+)"\)/g)].map((i) => i[1]!),
  }));
  const instanceSpec = /const instanceChunk: Loader = \(\) => import\("([^"]+)"\)/.exec(table)?.[1];
  const toFile = (spec: string): string | null => {
    let base: string;
    if (spec.startsWith(".")) base = resolve(HERE, "src/lib", spec);
    else {
      const m = /^@cobblr\/([a-z0-9-]+)\/ui$/.exec(spec);
      if (!m) return null;
      base = resolve(HERE, "..", "modules", m[1]!, "src/ui/index");
    }
    for (const ext of [".tsx", ".ts", ""]) if (existsSync(base + ext)) return base + ext;
    return null;
  };
  return {
    name: "cobblr-route-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        // A section's chunk by the module it starts from, else by any chunk
        // that holds that module: a module another chunk also imports has no
        // facade of its own, and the dashboard's row was empty for it, so
        // its code was fetched only once the shell had run, and the shell
        // went blank while it came (#6635).
        const chunkOf = new Map<string, string>();
        for (const f of Object.values(bundle)) if (f.type === "chunk" && f.facadeModuleId) chunkOf.set(f.facadeModuleId, f.fileName);
        for (const f of Object.values(bundle)) if (f.type === "chunk") for (const id of f.moduleIds) if (!chunkOf.has(id)) chunkOf.set(id, f.fileName);
        const entry = Object.values(bundle).find((f) => f.type === "chunk" && f.isEntry);
        const eager = new Set<string>();
        const walk = (name: string, into: Set<string>) => {
          const c = bundle[name];
          if (!c || into.has(name) || c.type !== "chunk") return;
          into.add(name);
          c.imports.forEach((i) => walk(i, into));
        };
        if (entry) walk(entry.fileName, eager);
        const unfound: string[] = [];
        const filesFor = (specs: string[]) => {
          const out = new Set<string>();
          for (const spec of specs) {
            const file = toFile(spec);
            const chunk = file ? chunkOf.get(file) : undefined;
            if (chunk) walk(chunk, out);
            else unfound.push(spec);
          }
          // Only what the shell does not already bring.
          return [...out].filter((f) => !eager.has(f)).map((f) => `/${f}`);
        };
        // Each file once, rows by index: the sections share most of their chunks.
        const files: string[] = [];
        const ix = (list: string[]) => list.map((f) => (files.includes(f) ? files.indexOf(f) : files.push(f) - 1));
        const map: Array<[string, number[]]> = rows.map((r) => [r.prefix, ix(filesFor(r.specs))]);
        const instance = instanceSpec ? ix(filesFor([instanceSpec])) : [];
        // A section whose code cannot be found is a page that loads late
        // with nothing said: the build stops instead.
        if (unfound.length) throw new Error(`route preload: no chunk holds ${unfound.join(", ")} (src/lib/route-prefetch.ts)`);
        // A FILE, never an inline <script>: the shell's policy is script-src 'self', and an inline
        // script is refused the day that is enforced. This one was inline (2026-10-05) and every page
        // load on try reported it (#3300); its content changes with every build, so neither a hash
        // nor a nonce would hold. The csp-shell CI check loads the built shell under the enforced
        // policy, so the next inline script fails a pull request instead of a promotion.
        const source = `(function(){var m=/^\\/w\\/[^/]+(\\/[^?#]*)?/.exec(location.pathname);if(!m)return;var p=m[1]||"/";var F=${JSON.stringify(files)},T=${JSON.stringify(map)},I=${JSON.stringify(instance)},best=null;for(var i=0;i<T.length;i++){var x=T[i][0];var hit=x==="/"?p==="/"||p===""
:p===x||p.indexOf(x+"/")===0;if(hit&&(!best||x.length>best[0].length))best=T[i];}var files=best?best[1]:(/^\\/[^/]+\\/?$/.test(p)?I:[]);for(var j=0;j<files.length;j++){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.setAttribute("data-route-hint","");l.href=F[files[j]];document.head.appendChild(l);}})();`;
        const fileName = `static/route-preload-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.js`;
        bundle[fileName] = {
          type: "asset",
          fileName,
          name: "route-preload.js",
          names: ["route-preload.js"],
          originalFileName: null,
          originalFileNames: [],
          source,
          needsCodeReference: false,
        } as (typeof bundle)[string];
        return html.replace("</head>", `<script src="/${fileName}"></script>\n</head>`);
      },
    },
  };
}

/** Every import of the app's own chunks asks once more, under a new address,
 *  when the first try did not arrive (src/lib/import-again.ts, #7676). */
function importAgain(): Plugin {
  return {
    name: "cobblr-import-again",
    apply: "build",
    enforce: "post",
    renderChunk(code) {
      const out = withImportAgain(code);
      return out === null ? null : { code: out, map: null };
    },
  };
}

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
  plugins: [react(), serviceWorker(), routePreload(), importAgain()],
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
    // dist/.vite/manifest.json: what scripts/first-load-budget.mjs reads to
    // measure each route's first load.
    manifest: true,
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
          // Only the libraries every page runs get a named chunk of their
          // own, so they cache across deploys. Everything else is left to
          // Rollup, which puts a library in the chunk of the code that uses
          // it: a library reached only from a lazy screen stays lazy. A
          // catch-all "vendor" chunk was eager, so every library in it
          // (pdf.js, the CAD kernel, the scanner's decoder, the schema
          // validator) was downloaded on every first load, used or not
          // (#4945; scripts/first-load-budget.mjs holds the line).
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("/scheduler/")) {
            return "vendor-react";
          }
          if (id.includes("@tanstack/react-query") || id.includes("@tanstack/query-core")) return "vendor-react-query";
          if (id.includes("react-router")) return "vendor-react-router";
          if (id.includes("lucide-react")) return "vendor-icons";
          return undefined;
        },
      },
    },
  },
});
