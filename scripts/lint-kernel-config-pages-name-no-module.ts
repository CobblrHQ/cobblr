#!/usr/bin/env tsx
// A kernel Configuration page (one with no owning module in configuration-nav.ts) imports no module's feature code; a module's setting reaches it as a contributed configuration section.
//
// THE BUG THIS PREVENTS. The overdue-reminder default was built into Configuration → Notifications by importing core-maintenance's component, so a kernel page named a module and drew it without dark-mode styling (2026-10-06).
//
// THE RULE. A Configuration destination with no `module:` in
// web/src/lib/configuration-nav.ts is the kernel's: it exists in every
// workspace. Its page (the component its /configuration route renders in
// web/src/App.tsx) must not import from web/src/features/<module>/. A module's
// setting arrives as a section the module declares (contributes.panels,
// surface "configuration-section", host in CONFIGURATION_SECTION_HOSTS) and the
// page renders with <ContributedConfigSections>. A genuine exception marks the
// import line `// ALLOW-MODULE-IN-CONFIG: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A destination that names its
// module (Print manager, `module: "digifab"`) is that module's own page and
// may import its features: it is hidden when the module is off. Only the
// kernel's pages are judged. Nothing else has tested the boundary yet.
//
// It reads the route table rather than trusting a list, so it fails (never
// passes) when it resolves too few kernel pages to be reading the real files.
//
//   npx tsx scripts/lint-kernel-config-pages-name-no-module.ts   (pnpm lint kernel-config-pages-name-no-module)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The kernel's /configuration routes and the page file each renders. */
function kernelConfigPages(): Array<{ route: string; file: string }> {
  const nav = readFileSync("web/src/lib/configuration-nav.ts", "utf8");
  const kernelRoutes = new Set<string>();
  for (const m of nav.matchAll(/\{[^{}]*?\bto:\s*"(\/configuration\/[^"?#]+)"[^{}]*?\}/g)) {
    if (!/\bmodule:\s*"/.test(m[0])) kernelRoutes.add(m[1]!);
  }
  const app = readFileSync("web/src/App.tsx", "utf8");
  const fileOf = new Map<string, string>();
  for (const m of app.matchAll(/const (\w+) = lazy\(\(\) => import\("(\.\/pages\/[^"]+)"\)/g)) fileOf.set(m[1]!, m[2]!);
  for (const m of app.matchAll(/import \{([^}]+)\} from "(\.\/pages\/[^"]+)"/g)) for (const n of m[1]!.split(",")) fileOf.set(n.trim(), m[2]!);
  const out: Array<{ route: string; file: string }> = [];
  for (const m of app.matchAll(/<Route path="(\/configuration\/[^"]+)" element=\{<(\w+)/g)) {
    const route = m[1]!;
    const rel = fileOf.get(m[2]!);
    if (!kernelRoutes.has(route) || !rel) continue;
    for (const ext of [".tsx", ".ts"]) {
      const file = join("web/src", rel.replace(/^\.\//, "") + ext);
      try {
        statSync(file);
        out.push({ route, file });
        break;
      } catch {
        /* the other extension */
      }
    }
  }
  return out;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*import\b.*from\s+"[^"]*\/features\/[^"]+"/.test(line) && !/\/\/ ALLOW-MODULE-IN-CONFIG: \S/.test(line)) {
      out.push({ file, line: i + 1, what: "a kernel Configuration page imports a module's feature code" });
    }
  }
  return out;
}

const pages = kernelConfigPages();
// A handful of kernel settings pages exist (Notifications, Permissions, AI,
// Labels...). Fewer than this means the route table or the nav changed shape
// and this lint is reading nothing: say so instead of passing.
const FLOOR = 5;
if (pages.length < FLOOR) {
  console.error(`lint:kernel-config-pages-name-no-module - resolved only ${pages.length} kernel Configuration page(s) from configuration-nav.ts and App.tsx; expected at least ${FLOOR}. The parse below no longer matches their shape.`);
  process.exit(1);
}
const violations: Violation[] = [];
for (const { file } of pages) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:kernel-config-pages-name-no-module - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Declare the setting in the module manifest as contributes.panels with surface configuration-section, register its component in web/src/panels/registry.tsx, and render <ContributedConfigSections> on the page.");
  process.exit(1);
}
console.log(`lint:kernel-config-pages-name-no-module OK (${pages.length} kernel Configuration pages, none imports a module's features)`);
