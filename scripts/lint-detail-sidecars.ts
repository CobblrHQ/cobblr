// Guard: a record you can OPEN is a record you can tag and talk about.
//
// There are two ways a detail view gets tags and discussion, and which one
// applies is decided by who owns the route:
//
//   web-app page   — routed explicitly in App.tsx (`<Route path="/machines/:id"
//                    element={<MachinesPage />} />`). It imports
//                    EntityAttachments directly.
//   module page    — routed by wildcard (`path="/projects/*"`) into the module's
//                    own UI, which may NOT import from web/src. It renders
//                    <ContributedDetailPanels>, and core-tags / core-discussion
//                    declare panels at every kind.
//
// Either is fine. NEITHER is silent: the module works, the page renders, and
// the record simply cannot be tagged or discussed. That is not hypothetical.
// Discussion shipped across several PRs and reached only the four web-app
// pages; every module-owned detail view had no way in, inventory parts among
// them. It was found by driving the feature in a browser, not by a check.
//
// EXEMPTION, for a kind whose "detail view" is a row in a list rather than
// something you open. Put it in the kind's block in the manifest:
//
//   // sidecar-exempt: a list item is a line in its list, never opened alone
//
// Run: npx tsx scripts/lint-detail-sidecars.ts

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULES = "modules";
const APP = "web/src/App.tsx";
const WEB_SRC = "web/src";

interface Kind {
  module: string;
  kind: string;
  route: string;
  exempt: string | null;
}

function declaredKinds(): Kind[] {
  const out: Kind[] = [];
  for (const mod of readdirSync(MODULES)) {
    const dir = join(MODULES, mod);
    const manifest = join(dir, "src", "module.ts");
    if (!statSync(dir).isDirectory() || !existsSync(manifest)) continue;
    const src = readFileSync(manifest, "utf8");
    for (const m of src.matchAll(/detailRoute:\s*"([^"]+)"/g)) {
      const before = src.slice(0, m.index);
      const ids = [...before.matchAll(/id:\s*"([a-z0-9-]+:[a-z0-9-]+)"/g)];
      const kind = ids.length ? ids[ids.length - 1]![1]! : "?";
      // The exemption may sit anywhere in this kind's block, and a comment
      // ABOUT a kind is normally written just above its `id:` line — so the
      // window starts a little before the id and runs to the detailRoute just
      // matched. Read as TEXT, because a comment does not survive an import.
      const idAt = ids.length ? ids[ids.length - 1]!.index! : 0;
      const block = before.slice(Math.max(0, idAt - 400));
      const ex = /\/\/\s*sidecar-exempt:\s*(.+)/.exec(block);
      out.push({ module: mod, kind, route: m[1]!, exempt: ex ? ex[1]!.trim() : null });
    }
  }
  return out;
}

const app = readFileSync(APP, "utf8");

/** The web page component routed at this exact path, if any. */
function webPageFor(route: string): string | null {
  // "/machines/{id}" → "/machines/:id"
  const asRoute = route.replace(/\{[^}]+\}/g, ":id");
  const re = new RegExp(
    `path="${asRoute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*element=\\{<(\\w+)`,
  );
  return re.exec(app)?.[1] ?? null;
}

/** Is this path handed wholesale to a module's own UI? */
function moduleOwned(route: string): boolean {
  const prefix = route.split("/")[1];
  return !!prefix && new RegExp(`path="/${prefix}/\\*"`).test(app);
}

function readAll(dir: string): string {
  if (!existsSync(dir)) return "";
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return parts.join("\n");
}

function findWebFile(component: string): string | null {
  const stack = [WEB_SRC];
  while (stack.length) {
    const d = stack.pop()!;
    for (const name of readdirSync(d)) {
      if (name === "node_modules") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (name === `${component}.tsx`) return p;
    }
  }
  return null;
}

const problems: string[] = [];
const exempt: Kind[] = [];
const uiCache = new Map<string, string>();

for (const k of declaredKinds()) {
  if (k.exempt) {
    exempt.push(k);
    continue;
  }

  if (moduleOwned(k.route)) {
    if (!uiCache.has(k.module)) uiCache.set(k.module, readAll(join(MODULES, k.module, "src", "ui")));
    const ui = uiCache.get(k.module)!;
    const literal = new RegExp(`target=["']${k.kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
    // An instanceable kind resolves its target at runtime — a Designs
    // instance's conversation is about a design, not about "a project".
    const dynamic = /<ContributedDetailPanels[\s\S]{0,200}?target=\{/;
    if (!literal.test(ui) && !dynamic.test(ui)) {
      problems.push(
        `${k.module}: "${k.kind}" opens at ${k.route} in the MODULE's own UI, which never renders\n` +
          `      <ContributedDetailPanels target="${k.kind}" …>, so it cannot be tagged or discussed.`,
      );
    }
    continue;
  }

  const page = webPageFor(k.route);
  if (!page) {
    // Nothing in App.tsx claims it. Not this lint's business to guess.
    continue;
  }
  const file = findWebFile(page);
  if (!file) continue;
  const src = readFileSync(file, "utf8");
  if (!/<EntityAttachments\b/.test(src) && !/<ContributedDetailPanels\b/.test(src)) {
    problems.push(
      `${k.module}: "${k.kind}" opens at ${k.route}, rendered by ${page}, which renders neither\n` +
        `      <EntityAttachments> nor <ContributedDetailPanels>, so it cannot be tagged or discussed.`,
    );
  }
}

if (problems.length > 0) {
  console.error("lint:detail-sidecars — a record you can open is a record you can talk about:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(
    "  In a MODULE's own detail view:\n" +
      '    <ContributedDetailPanels target="<kind>" ctx={{ slug: orgSlug, entityId, entityTitle }} />\n\n' +
      "  In a web-app page:\n" +
      "    <EntityAttachments kind={<kind>} entityId={…} />\n\n" +
      "  Or, if the kind is a row rather than something you open, say so on the kind:\n" +
      "    // sidecar-exempt: <why>\n",
  );
  process.exit(1);
}

const note = exempt.length ? ` (${exempt.length} exempt: ${exempt.map((e) => e.kind).join(", ")})` : "";
console.log(`lint:detail-sidecars — every openable record can be tagged and discussed${note}.`);
