#!/usr/bin/env tsx
// Shipped nesting dependencies have pinned versions, reviewed licences and source notices in both images.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const inventory = JSON.parse(readFileSync("docs/third-party/nesting-inventory.json","utf8")) as Array<{name:string;version:string;license:string;source:string}>;
const lock = readFileSync("modules/digifab/nesting/Cargo.lock","utf8");
const manifest = readFileSync("modules/digifab/nesting/Cargo.toml","utf8");
const errors: string[]=[];
const allowed = new Set(["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC","MPL-2.0"]);
const transitive = new Set(["Zlib","Unicode-3.0","Unlicense"]);
// The DIRECT dependencies take only the permitted licences: the transitive-only set (Zlib, Unicode-3.0,
// Unlicense) was reviewed for what the closure already held, not as a choice for something we add.
const direct = new Set([...manifest.slice(manifest.indexOf("[dependencies]")).split(/\n\[/)[0]!.matchAll(/^([\w-]+)\s*=/gm)].map((m) => m[1]!).concat(["polygon-clipping"]));
const licensed = (license: string, ok: (l: string) => boolean) =>
 license.split(/\bAND\b/).every((g) => g.replace(/[()]/g, "").split(/\bOR\b|\//).some((l) => ok(l.trim())));
for (const block of lock.split("[[package]]").slice(1)) {
 const name = /name = "([^"]+)"/.exec(block)?.[1], version=/version = "([^"]+)"/.exec(block)?.[1];
 if(name === "cobblr-nesting")continue;
 const row=inventory.find(p=>p.name===name&&p.version===version);
 if(!row?.license || !row.source) {errors.push(`${name}@${version} has no reviewed licence or source`);continue;}
 const groups=row.license.split(/\bAND\b/);
 if(groups.some(g=>!g.replace(/[()]/g,"").split(/\bOR\b|\//).some(l=>allowed.has(l.trim())||transitive.has(l.trim())))) errors.push(`${name} has an unreviewed licence: ${row.license}`);
}
for (const name of direct) {
 const row = inventory.find((p) => p.name === name);
 if (row && !licensed(row.license, (l) => allowed.has(l))) errors.push(`${name} is a direct dependency, and ${row.license} is not a licence a direct dependency may take (${[...allowed].join(", ")})`);
}
// The npm half: polygon-clipping, the polygon union, and its whole locked closure. Each row's version
// is the one pnpm-lock resolves, and its licence is the one the installed package declares; until
// 2026-10-07 the lint walked only Cargo.lock and these rows were never checked.
const pnpmLock = readFileSync("pnpm-lock.yaml", "utf8");
const snapshots = pnpmLock.slice(pnpmLock.indexOf("\nsnapshots:"));
const npmDeps = (name: string, version: string): Array<[string, string]> => {
 const at = snapshots.indexOf(`\n  ${name}@${version}:`);
 if (at < 0) return [];
 const block = snapshots.slice(at + 1).split(/\n {2}\S/)[0]!;
 const deps = /\n {4}dependencies:\n((?: {6}.*\n?)*)/.exec(block)?.[1] ?? "";
 return [...deps.matchAll(/^ {6}'?([^':\s]+)'?: '?([^'\s(]+)/gm)].map((m) => [m[1]!, m[2]!]);
};
const rootVersion = /"polygon-clipping": "([^"]+)"/.exec(readFileSync("modules/digifab/package.json", "utf8"))?.[1];
if (!rootVersion) errors.push("modules/digifab/package.json no longer pins polygon-clipping: update the npm half of this lint");
const notChecked: string[] = [];
const resolvedAt = new Map<string, string>();
/** A package's package.json path. Its `exports` may not expose ./package.json, so fall back to its entry and walk up. */
function packageJsonOf(req: NodeJS.Require, name: string): string {
 try { return req.resolve(`${name}/package.json`); } catch { /* not exported: find it from the entry */ }
 let dir = dirname(req.resolve(name));
 for (;;) {
  const pj = join(dir, "package.json");
  if (existsSync(pj) && (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return pj;
  const up = dirname(dir);
  if (up === dir) throw new Error(`no package.json for ${name}`);
  dir = up;
 }
}
/** The licence the installed package declares, or null when it is not installed at that version here. A
 *  dependency is resolved from the package that depends on it (pnpm nests it there), a root from its workspace. */
function declaredLicence(name: string, version: string, from: string[]): string | null {
 for (const base of from) {
  try {
   const pj = packageJsonOf(createRequire(base), name);
   const j = JSON.parse(readFileSync(pj, "utf8")) as { version?: string; license?: string };
   if (j.version === version) { resolvedAt.set(`${name}@${version}`, pj); return j.license ?? ""; }
  } catch { /* not resolvable from there */ }
 }
 return null;
}
const ROOTS = ["modules/digifab", "modules/inventory", "."].map((ws) => join(process.cwd(), ws, "package.json"));
const seen = new Set<string>();
const queue: Array<[string, string, string[]]> = rootVersion ? [["polygon-clipping", rootVersion, ROOTS]] : [];
while (queue.length) {
 const [name, version, from] = queue.shift()!;
 if (seen.has(`${name}@${version}`)) continue;
 seen.add(`${name}@${version}`);
 if (!snapshots.includes(`\n  ${name}@${version}:`)) { errors.push(`${name}@${version} is not in pnpm-lock.yaml`); continue; }
 const row = inventory.find((p) => p.name === name && p.version === version);
 if (!row?.license || !row.source) { errors.push(`${name}@${version} (npm) has no reviewed licence or source`); continue; }
 if (!licensed(row.license, (l) => allowed.has(l) || transitive.has(l))) errors.push(`${name} has an unreviewed licence: ${row.license}`);
 // Resolved the way node would from the workspace that depends on it, whatever the install's layout; a
 // package that is not installed here is said, not failed (the typecheck job installs only what it needs).
 const installed = declaredLicence(name, version, from);
 if (installed === null) notChecked.push(`${name}@${version}`);
 else if (installed !== row.license) errors.push(`${name}@${version} declares ${installed || "no licence"}, the inventory says ${row.license}`);
 const here = resolvedAt.get(`${name}@${version}`);
 queue.push(...npmDeps(name, version).map(([n, v]): [string, string, string[]] => [n, v, here ? [here, ...ROOTS] : ROOTS]));
}
const jagua=inventory.find(p=>p.name==="jagua-rs"),sparrow=inventory.find(p=>p.name==="sparrow");
if(jagua?.license!=="MPL-2.0"||jagua.version!=="1.0.0"||!jagua.source.endsWith("23e3f2737065cbb4dbc8f400b622976490b2d8cd")) errors.push("jagua-rs must retain its MPL licence and pinned source link");
if(sparrow?.license!=="MIT"||!sparrow.source.endsWith("5901a79b6c5a74d8b9c356ee2916736567308108")) errors.push("sparrow must retain its MIT licence and pinned source link");
if(!manifest.includes('jagua-rs = "=1.0.0"')||!manifest.includes('rev = "5901a79b6c5a74d8b9c356ee2916736567308108"')) errors.push("solver dependencies must be exactly pinned");
for(const file of ["MPL-2.0.txt","sparrow-MIT.txt","nesting-licenses.txt"]) if(!existsSync(`docs/third-party/${file}`))errors.push(`missing licence text ${file}`);
for(const file of ["docker/api.Dockerfile","docker/web.Dockerfile"]) if(!readFileSync(file,"utf8").includes("COPY docs/third-party "))errors.push(`${file} does not ship third-party notices`);
if(notChecked.length) console.log(`lint:shipped-nesting-licenses: not installed here, declared licence not compared: ${notChecked.join(", ")}`);
if(errors.length) {console.error(errors.join("\n"));process.exit(1);}
console.log("lint:shipped-nesting-licenses OK");
