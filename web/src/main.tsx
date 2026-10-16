import { configureProductName, productName } from "@cobblr/platform-web/product-name";
import { listenForInstallPrompt } from "./lib/install-app";
import { registerServiceWorker } from "./lib/offline";

listenForInstallPrompt();
registerServiceWorker();

async function boot() {
  try {
    const res = await fetch("/api/v1/auth/config", { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error("The server configuration is unavailable");
    const cfg = (await res.json()) as { product_name?: string };
    configureProductName(cfg.product_name);
  } catch {
    configureProductName("Workspace");
  }
  document.title = productName();
  for (const meta of document.querySelectorAll('meta[name="apple-mobile-web-app-title"], meta[name="application-name"]')) {
    meta.setAttribute("content", productName());
  }
  await import("./mount");
}

void boot();
