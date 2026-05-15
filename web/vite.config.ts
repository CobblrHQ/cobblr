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
  },
});
