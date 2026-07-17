// Guard: the GitHub-registry header logic exists twice ON PURPOSE — the
// canonical api/src/lib/github-registry.ts, and a copy inside
// scripts/install-registry-modules.mjs (which runs standalone at image-build
// time, before/without the compiled api, so it cannot import the canonical
// one). A "keep the two in sync" comment guarded that for a while; comments
// don't fail builds. This lint does: it imports BOTH implementations and
// compares their outputs across the url × token matrix, so any semantic drift
// (the class: the no-token public-repo fetch quietly losing its Accept
// header) turns CI red at the commit that introduced it.
//
// Run: npx tsx scripts/lint-registry-headers-sync.ts
import { githubRegistryHeaders } from "../api/src/lib/github-registry.js";
import { authHeaders } from "./install-registry-modules.mjs";

const URLS = [
  "https://api.github.com/repos/x/y/contents/index.json",
  "https://raw.githubusercontent.com/x/y/main/index.json",
  "https://objects.githubusercontent.com/asset/123",
  "https://example.com/not-github.json",
];
const TOKENS: Array<string | undefined> = [undefined, "test-token-123"];

const failures: string[] = [];
for (const token of TOKENS) {
  const prevA = process.env.COBBLR_REGISTRY_TOKEN;
  const prevB = process.env.GITHUB_TOKEN;
  if (token === undefined) {
    delete process.env.COBBLR_REGISTRY_TOKEN;
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.COBBLR_REGISTRY_TOKEN = token;
    delete process.env.GITHUB_TOKEN;
  }
  for (const url of URLS) {
    const canonical = JSON.stringify(githubRegistryHeaders(url));
    const scripted = JSON.stringify(authHeaders(url));
    if (canonical !== scripted) {
      failures.push(
        `token=${token ? "set" : "unset"} url=${url}\n    api:    ${canonical}\n    script: ${scripted}`,
      );
    }
  }
  if (prevA === undefined) delete process.env.COBBLR_REGISTRY_TOKEN;
  else process.env.COBBLR_REGISTRY_TOKEN = prevA;
  if (prevB === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = prevB;
}

if (failures.length) {
  console.error(`[lint:registry-headers-sync] ${failures.length} divergence(s) between api/src/lib/github-registry.ts and scripts/install-registry-modules.mjs:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:registry-headers-sync] OK — both header implementations agree across the url × token matrix");
