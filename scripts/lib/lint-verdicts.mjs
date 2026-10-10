// The lint suite's verdict cache (#4303): a lint whose every observation is as it was when it last
// passed is not run again.
//
// A lint's inputs cannot be read from its source the way a test's imports can (it globs, lists, asks
// git), so they are RECORDED: lib/lint-inputs.cjs, preloaded into every lint process, writes what it
// read, listed, globbed, probed, asked git and read from the environment. That manifest is stored with
// the pass. The next run REPLAYS it against its own tree (the same reads, listings, globs, probes and
// git listings, and the same variables' values now) and hashes the result with the lint's own import
// closure and a salt. The same hash: nothing it looked at changed, and the pass is reused.
//
// A lint that ran anything but node and git ls-files / rev-parse, read outside the repo, or is a shell
// script, is never reused: what it saw cannot be replayed. The release still runs every lint uncached,
// and an uncached run reports any lint it would have reused that failed (a shadow miss).

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, globSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODE_EXT } from "./unit-affected-lib.mjs";
import { isBuildOutput } from "./glob-exclude.mjs";
import { importClosure, treeIndex } from "./verdict-cache.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** The files whose change alters how every lint runs or is judged. */
export const LINT_RUNNER = ["scripts/run-lints.mjs", "scripts/lib/lint-command.mjs", "scripts/lib/ts-resolve.mjs", "scripts/lib/lint-inputs.cjs", "scripts/lib/lint-reads.cjs", "scripts/lib/lint-verdicts.mjs", "scripts/lib/verdict-cache.mjs", "pnpm-lock.yaml", "package.json", "tsconfig.json", "tsconfig.base.json"];

/** The script a recorded lint command runs, or null (a shell lint, or no script). */
export function scriptOf(cmd) {
  const m = /(?:^|\s)(?:node|tsx|bash|sh)\s+(?:--\S+\s+)*(scripts\/[\w./-]+\.(ts|mts|mjs|js|cjs|sh))\b/.exec(cmd ?? "");
  return m ? { path: m[1], shell: m[2] === "sh" } : null;
}

/**
 * One manifest from the lines every process of a lint wrote: the union, sorted, so the same
 * observations always make the same manifest.
 * @param {string} text the inputs file
 */
export function mergeManifest(text) {
  const reads = new Set(), probes = new Set(), hidden = new Set(), ancestors = new Set();
  const lists = new Map(), globs = new Map(), gits = new Map(), loads = new Set();
  let lines = 0;
  let loadsRecorded = true;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      hidden.add("a torn inputs line");
      continue;
    }
    lines++;
    for (const r of o.reads ?? []) reads.add(r);
    for (const p of o.probes ?? []) probes.add(p);
    for (const h of o.hidden ?? []) hidden.add(h);
    for (const [d, opt] of o.lists ?? []) lists.set(`${d}\0${!!opt?.recursive}\0${!!opt?.withFileTypes}`, [d, { recursive: !!opt?.recursive, withFileTypes: !!opt?.withFileTypes }]);
    for (const [cwd, pat, exclude = null] of o.globs ?? []) globs.set(`${cwd}\0${pat}\0${JSON.stringify(exclude)}`, [cwd, pat, exclude]);
    for (const args of o.gits ?? []) gits.set(args.join(" "), args);
    for (const l of o.loads ?? []) loads.add(l);
    if (!o.loadsRecorded) loadsRecorded = false;
    for (const a of o.ancestors ?? []) ancestors.add(a);
  }
  if (lines === 0) hidden.add("recorded nothing (the preload did not run)");
  const sorted = (m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
  return {
    reads: [...reads].sort(), probes: [...probes].sort(), lists: sorted(lists), globs: sorted(globs),
    gits: sorted(gits), loads: [...loads].sort(), loadsRecorded: lines > 0 && loadsRecorded, ancestors: [...ancestors].sort(), hidden: [...hidden].sort(),
  };
}

/**
 * What the tree shows a manifest now: each read's content id, each listing, glob, probe and git
 * listing as it is, each variable's value. Its hash is the replay.
 * @param {ReturnType<typeof mergeManifest>} m
 * @param {{ root: string, blobs: Map<string, string>, gitCache?: Map<string, string> }} ctx
 */
export function replay(m, { root, blobs, gitCache = new Map() }) {
  const h = createHash("sha256");
  const at = (p) => (p === "." ? root : join(root, p));
  for (const p of m.reads) {
    let id = blobs.get(p);
    if (!id) {
      try {
        id = `u:${sha(readFileSync(at(p)))}`;
      } catch (e) {
        id = e?.code === "EISDIR" ? "dir" : "absent";
      }
    }
    h.update(`r ${p} ${id}\n`);
  }
  for (const [d, o] of m.lists) {
    let v;
    try {
      v = readdirSync(at(d), { recursive: o.recursive, withFileTypes: true }).map((e) => `${e.parentPath && e.parentPath !== at(d) ? `${e.parentPath.slice(at(d).length + 1)}/` : ""}${e.name}:${e.isDirectory() ? "d" : e.isSymbolicLink() ? "l" : "f"}`).sort().join(",");
    } catch {
      v = "absent";
    }
    h.update(`l ${d} ${o.recursive} ${sha(v)}\n`);
  }
  for (const [cwd, pat, exclude = null] of m.globs) {
    let v;
    try {
      v = (exclude === "isBuildOutput" ? globSync(pat, { cwd: at(cwd), exclude: isBuildOutput }) : globSync(pat, { cwd: at(cwd) })).sort().join(",");
    } catch {
      v = "error";
    }
    h.update(`g ${cwd} ${pat} ${JSON.stringify(exclude)} ${sha(v)}\n`);
  }
  for (const p of m.probes) {
    let v;
    try {
      const st = lstatSync(at(p));
      v = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
    } catch {
      v = "absent";
    }
    h.update(`p ${p} ${v}\n`);
  }
  for (const args of m.gits) {
    const k = args.join("\0");
    if (!gitCache.has(k)) {
      let v;
      try {
        const o = { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };
        // A command the lint gave as a shell string (`git grep … '*.sh'`) is replayed through a shell.
        v = sha(args[0] === "--shell" ? execSync(args[1], o) : execFileSync("git", args, o));
      } catch {
        v = "error";
      }
      gitCache.set(k, v);
    }
    h.update(`git ${args.join(" ")} ${gitCache.get(k)}\n`);
  }
  for (const p of m.loads ?? []) h.update(`m ${p} ${blobs.get(p) ?? "untracked"}\n`);
  for (const name of m.ancestors ?? []) {
    const seen = [];
    for (let d = dirname(root); ; d = dirname(d)) {
      try {
        seen.push(`${d.split("/").length}:${sha(readFileSync(join(d, name)))}`);
      } catch {}
      if (d === dirname(d)) break;
    }
    h.update(`a ${name} ${seen.join(",") || "absent"}\n`);
  }
  return h.digest("hex");
}

const ENV_NOISE = /^(PATH|HOME|PWD|OLDPWD|SHLVL|TMPDIR|TEMP|TMP|TERM|COLUMNS|LINES|FORCE_COLOR|NO_COLOR|NODE_OPTIONS|NODE_ENV|COBBLR_LINT_\w+|npm_\w+|LANG|LC_\w+|TZ|USER|LOGNAME|HOSTNAME|SHELL)$/;

/**
 * The environment variables a lint can read, from the source of every module it loaded, and their
 * values now. A variable read by a computed name cannot be listed: the lint is never reused.
 * @returns {{ env: string, hidden: string | null }}
 */
export function envOf(files, sources) {
  const names = new Set();
  for (const f of files) {
    const s = sources.get(f);
    if (s == null) continue;
    for (const m of s.matchAll(/process\.env\.([A-Za-z_]\w*)|process\.env\[\s*["'`]([A-Za-z_]\w*)["'`]\s*\]|\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1] ?? m[2] ?? m[3]);
    // A computed name the file vouches for, on the line: `// verdict-env: <why it reads no other input>`.
    for (const line of s.split("\n")) {
      if (/process\.env\[\s*(?!["'`])/.test(line) && !/verdict-env: \S/.test(line)) return { env: "", hidden: `${f} reads the environment by a computed name` };
    }
  }
  const list = [...names].filter((n) => !ENV_NOISE.test(n)).sort();
  return { env: list.map((n) => `${n}=${process.env[n] ?? "<unset>"}`).join("\n"), hidden: null }; // verdict-env: the names are the ones listed above, each part of the key
}

/**
 * The key of one lint: its name and command, the salt, its script's import closure, the replay.
 * @param {{ name: string, cmd: string, salt: string, closure: Iterable<string>, blobs: Map<string, string>, replayed: string }} a
 */
export function lintKey({ name, cmd, salt, closure, blobs, replayed }) {
  const lines = [...closure].sort().map((p) => `${p}\0${blobs.get(p) ?? "absent"}`);
  return sha(`lint\n${name}\n${cmd}\n${salt}\n${lines.join("\n")}\n${replayed}`);
}

/**
 * Everything one run needs to key its lints: the tree's blob ids, sources, packages, the salt.
 * Null when the tree differs from HEAD (its ids would not be what runs).
 * @param {string} root
 */
export function lintContext(root) {
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root, stdio: "ignore" });
  } catch {
    return null;
  }
  const blobs = new Map();
  for (const line of execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\0")) {
    const m = /^\d+ ([0-9a-f]{40,64}) \d\t(.+)$/.exec(line);
    if (m) blobs.set(m[2], m[1]);
  }
  const files = [...blobs.keys()];
  const sources = new Map();
  for (const f of files) {
    if (!CODE_EXT.test(f) || /(^|\/)(node_modules|dist)\//.test(f)) continue;
    try {
      sources.set(f, readFileSync(join(root, f), "utf8"));
    } catch {}
  }
  const packages = new Map();
  for (const f of files.filter((p) => /^(packages|modules)\/[^/]+\/package\.json$|^(web|api|scripts)\/package\.json$/.test(p))) {
    try {
      packages.set(JSON.parse(readFileSync(join(root, f), "utf8")).name, f.slice(0, f.lastIndexOf("/")));
    } catch {}
  }
  let os = "";
  try {
    os = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME=(.*)$/m)?.[1] ?? "";
  } catch {}
  const salt = sha(`${LINT_RUNNER.map((f) => `${f} ${blobs.get(f) ?? "absent"}`).join("\n")}\nnode ${process.version} ${process.platform} ${process.arch} ${os}`);
  return { root, blobs, sources, packages, tree: treeIndex(files), salt, gitCache: new Map() };
}

/**
 * One lint's key from a manifest, or why it has none. The modules it loaded are the recorded ones
 * plus its script's static closure; a static closure that cannot be told (a computed import) is fine
 * when the loads were recorded, since they are what actually ran.
 * @returns {{ key: string | null, hidden: string | null }}
 */
export function lintVerdictKey({ name, cmd, manifest, ctx, closure }) {
  if (manifest.hidden?.length) return { key: null, hidden: manifest.hidden[0] };
  if (closure.hidden && !manifest.loadsRecorded) return { key: null, hidden: closure.hidden };
  const files = new Set([...closure.files, ...(manifest.loads ?? [])]);
  const e = envOf(files, ctx.sources);
  if (e.hidden) return { key: null, hidden: e.hidden };
  const replayed = sha(`${replay(manifest, { root: ctx.root, blobs: ctx.blobs, gitCache: ctx.gitCache })}\n${e.env}`);
  return { key: lintKey({ name, cmd, salt: ctx.salt, closure: files, blobs: ctx.blobs, replayed }), hidden: null };
}

/** The lint's script closure, or why it cannot be keyed. */
export function lintClosure(cmd, ctx) {
  const s = scriptOf(cmd);
  if (!s) return { files: new Set(), hidden: "its command names no script" };
  if (s.shell) return { files: new Set([s.path]), hidden: "a shell script (its reads cannot be recorded)" };
  return importClosure({ start: s.path, sources: ctx.sources, packages: ctx.packages, tree: ctx.tree });
}

/** Manifests by hash, from a cache directory when there, else the sink (and kept). */
export async function fetchManifests(hashes, { url = process.env.CI_SINK_URL || "http://workshop:8767", dir }) {
  const out = new Map();
  const want = [...new Set(hashes)];
  const cacheDir = dir && (() => {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return null;
    }
  })();
  const todo = [];
  for (const h of want) {
    const f = cacheDir && join(cacheDir, `${h}.json`);
    if (f && existsSync(f)) {
      try {
        out.set(h, JSON.parse(readFileSync(f, "utf8")));
        continue;
      } catch {}
    }
    todo.push(h);
  }
  for (let i = 0; i < todo.length; i += 16) {
    await Promise.all(todo.slice(i, i + 16).map(async (h) => {
      try {
        const r = await fetch(`${url}/verdicts/manifest/${h}`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return;
        const text = await r.text();
        if (sha(text) !== h) return;
        out.set(h, JSON.parse(text));
        if (cacheDir) writeFileSync(join(cacheDir, `${h}.json`), text);
      } catch {}
    }));
  }
  return out;
}

/** Each lint's newest passes with manifests, from the sink. Fails open: {}. */
export async function latestPasses(names, { url = process.env.CI_SINK_URL || "http://workshop:8767" } = {}) {
  try {
    const r = await fetch(`${url}/verdicts/latest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suite: "lint", names }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return {};
    return (await r.json()).latest ?? {};
  } catch {
    return {};
  }
}
