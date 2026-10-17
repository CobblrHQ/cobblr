// The lint suite's verdict cache (#4303): a lint whose every observation is as it was when it last
// passed is not run again.
//
// A lint's inputs cannot be read from its source the way a test's imports can (it globs, lists, asks
// git), so they are RECORDED: lib/lint-inputs.cjs, preloaded into every lint process, writes what it
// read, listed, globbed, probed, asked git and loaded. Compacted to ROOTS (v2 below), that is stored with
// the pass; the next run keys the same roots by their object ids in its own tree, with the variables the
// loaded modules read and a salt. The same key: nothing it looked at changed, and the pass is reused.
//
// A lint that ran anything but node and git ls-files / rev-parse, read outside the repo, or is a shell
// script, is never reused: what it saw cannot be replayed. The release still runs every lint uncached,
// and an uncached run reports any lint it would have reused that failed (a shadow miss).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** The files whose change alters how every lint runs or is judged. */
export const LINT_RUNNER = ["scripts/run-lints.mjs", "scripts/lib/lint-command.mjs", "scripts/lib/ts-resolve.mjs", "scripts/lib/lint-inputs.cjs", "scripts/lib/lint-reads.cjs", "scripts/lib/lint-verdicts.mjs", "scripts/lib/verdict-cache.mjs", "pnpm-lock.yaml", "package.json", "tsconfig.json", "tsconfig.base.json"];

/** PURE. Whether this run reuses lint verdicts. A pull request reuses ("on", #5761, 2026-10-12: 105 shadow
 *  runs, 0 misses, median 128 of 487 lints reusable); so does a re-check (a push to recheck/ or recheck-first/,
 *  lib/direct-merge.mjs: one pull request on current main, #7182: run 51567 found 457 of 521 reusable in shadow
 *  and ran all 521). A push to main runs every lint and keys them in shadow, so main stays the backstop and
 *  keeps looking for misses; outside CI nothing. COBBLR_LINT_VERDICTS overrides; a scheduled or dispatched
 *  run (COBBLR_VERDICT_CACHE=off, the release's) is shadow whatever is set. */
export function verdictMode(env) {
  const recheck = env.GITHUB_EVENT_NAME === "push" && /^recheck(-first)?\//.test(env.GITHUB_REF_NAME ?? "");
  const mode = env.COBBLR_LINT_VERDICTS || (env.CI ? (env.GITHUB_EVENT_NAME === "pull_request" || recheck ? "on" : "shadow") : "off");
  return { mode, shadow: mode === "shadow" || env.COBBLR_VERDICT_CACHE === "off" };
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

/** Manifests by hash, from a cache directory when there, else the sink (and kept). */
export async function fetchManifests(hashes, { url = process.env.CI_SINK_URL || "http://workshop:8767", dir, deadline = Infinity }) {
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
  let todo = [];
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
  const keep = (h, text) => {
    if (sha(text) !== h) return;
    try {
      out.set(h, JSON.parse(text));
      if (cacheDir) writeFileSync(join(cacheDir, `${h}.json`), text);
    } catch {}
  };
  const left = () => Math.max(1, Math.min(20_000, deadline - Date.now()));
  // One request for all of them (#5761: one by one, 1,400 took 832 s from a box with a 4 s round trip).
  for (let i = 0; i < todo.length && Date.now() < deadline; i += 5000) {
    try {
      const r = await fetch(`${url}/verdicts/manifests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: todo.slice(i, i + 5000) }), signal: AbortSignal.timeout(left()) });
      if (!r.ok) break; // a store from before the bulk route: one by one below
      for (const [h, text] of Object.entries((await r.json()).manifests ?? {})) keep(h, text);
    } catch {
      break;
    }
  }
  todo = todo.filter((h) => !out.has(h));
  // One by one only for what the bulk answer could not give, and never past the deadline.
  for (let i = 0; i < todo.length && Date.now() < deadline; i += 16) {
    await Promise.all(todo.slice(i, i + 16).map(async (h) => {
      try {
        const r = await fetch(`${url}/verdicts/manifest/${h}`, { signal: AbortSignal.timeout(Math.min(15_000, left())) });
        if (r.ok) keep(h, await r.text());
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

// ── v2: ROOTS, keyed by git object ids (2026-10-11, #5761) ───────────────────────────────────────────
// The replay above re-ran every listing, glob and git call and read every source file in the repo to
// key the suite: 644 s on main's lane for 10 reuses of 475, with manifests near 256 KB each. A lint's
// observations are now compacted to ROOTS: the files it read, loaded or probed, and the directories it
// listed, globbed or asked git about, with any root under a listed directory dropped (the directory's
// tree id covers it). The key is each root's object id in HEAD, all of them for all lints from one
// `git cat-file --batch-check`, plus the values of the variables its loaded modules read. A directory
// root is coarser than a replay (any change under it is a change), so it can only reuse less, never
// wrongly.

/** The roots of a merged manifest: { files, dirs, ancestors, hidden } with nothing under a dir root. */
export function lintRoots(m) {
  const hidden = [...(m.hidden ?? [])];
  if (!m.loadsRecorded) hidden.push("its loaded modules were not recorded");
  const dirs = new Set();
  const norm = (p) => String(p ?? "").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
  for (const [d] of m.lists ?? []) dirs.add(norm(d));
  // The static part of a pattern: its segments up to the first one with a wildcard.
  const head = (pat) => {
    const out = [];
    for (const seg of String(pat).split("/")) {
      if (/[*?[{]/.test(seg) || seg.includes(":")) break;
      out.push(seg);
    }
    return out;
  };
  for (const [cwd, pat] of m.globs ?? []) dirs.add(norm([norm(cwd) === "." ? "" : norm(cwd), ...head(pat)].filter(Boolean).join("/")));
  for (const args of m.gits ?? []) {
    // `rev-parse --show-toplevel` reads nothing; a shell command or a listing with no pathspec reads the tree.
    if (args[0] !== "--shell" && args.includes("rev-parse")) continue;
    const at = args.indexOf("--");
    const spec = args[0] === "--shell" ? [] : (at >= 0 ? args.slice(at + 1) : args.slice(1).filter((a) => !a.startsWith("-") && a !== "ls-files" && a !== "grep"));
    if (args[0] === "--shell" || !spec.length) dirs.add(".");
    for (const sp of spec) dirs.add(norm(head(sp).join("/")));
  }
  const under = (p, d) => d === "." || p === d || p.startsWith(`${d}/`);
  const dirList = [...dirs].sort();
  const keptDirs = dirList.filter((d) => !dirList.some((o) => o !== d && under(d, o)));
  const files = new Set();
  for (const p of [...(m.reads ?? []), ...(m.loads ?? [])]) {
    const f = norm(p);
    if (f !== "." && !keptDirs.some((d) => under(f, d))) files.add(f);
  }
  // A probe asks only whether a path is there and what kind it is: keyed by that, never its content.
  const probes = new Set();
  for (const p of m.probes ?? []) {
    const f = norm(p);
    if (f !== "." && !files.has(f) && !keptDirs.some((d) => under(f, d))) probes.add(f);
  }
  return { files: [...files].sort(), dirs: keptDirs, probes: [...probes].sort(), ancestors: [...(m.ancestors ?? [])].sort(), loads: [...(m.loads ?? [])].sort(), hidden: [...new Set(hidden)].sort() };
}

/**
 * Each path's object id in HEAD, in one `git cat-file --batch-check`; a path not in HEAD is read from
 * the working tree (u:<sha> of a file, "absent"), so an untracked input still keys.
 * @param {string} root @param {Iterable<string>} paths
 * @returns {Map<string, string>}
 */
export function rootIds(root, paths) {
  const list = [...new Set(paths)];
  const out = new Map();
  if (!list.length) return out;
  const res = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: root, input: list.map((p) => `HEAD:${p === "." ? "" : p}`).join("\n") + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = res.split("\n");
  list.forEach((p, i) => {
    const line = lines[i] ?? "";
    const m = /^([0-9a-f]{40,64}) (blob|tree|commit)$/.exec(line);
    if (m) {
      out.set(p, `${m[1]} ${m[2] === "tree" ? "d" : "f"}`);
      return;
    }
    try {
      out.set(p, `u:${sha(readFileSync(join(root, p)))} f`);
    } catch (e) {
      out.set(p, e?.code === "EISDIR" ? "udir d" : "absent -");
    }
  });
  return out;
}

/** The salt every lint key shares: the runner's own files and the runtime. Light: one batch read. */
export function lintSalt(root) {
  const ids = rootIds(root, LINT_RUNNER);
  let os = "";
  try {
    os = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME=(.*)$/m)?.[1] ?? "";
  } catch {}
  return sha(`v2\n${LINT_RUNNER.map((f) => `${f} ${ids.get(f)}`).join("\n")}\nnode ${process.version} ${process.platform} ${process.arch} ${os}`);
}

/**
 * One lint's v2 key from its roots, or why it has none.
 * @param {{ name: string, cmd: string, roots: ReturnType<typeof lintRoots>, salt: string, ids: Map<string, string>, root: string, sources?: Map<string, string> }} a
 * @returns {{ key: string | null, hidden: string | null }}
 */
export function lintRootsKey({ name, cmd, roots, salt, ids, root, sources = new Map() }) {
  if (roots.hidden.length) return { key: null, hidden: roots.hidden[0] };
  for (const f of roots.loads) {
    if (sources.has(f)) continue;
    try {
      sources.set(f, readFileSync(join(root, f), "utf8"));
    } catch {}
  }
  const e = envOf(roots.loads, sources);
  if (e.hidden) return { key: null, hidden: e.hidden };
  const anc = roots.ancestors.map((n) => {
    const seen = [];
    for (let d = dirname(root); ; d = dirname(d)) {
      try {
        seen.push(`${d.split("/").length}:${sha(readFileSync(join(d, n)))}`);
      } catch {}
      if (d === dirname(d)) break;
    }
    return `${n} ${seen.join(",") || "absent"}`;
  });
  const kind = (p) => (ids.get(p) ?? "? ?").split(" ")[1];
  const lines = [...roots.dirs.map((d) => `d ${d} ${ids.get(d) ?? "?"}`), ...roots.files.map((f) => `f ${f} ${ids.get(f) ?? "?"}`), ...(roots.probes ?? []).map((p) => `p ${p} ${kind(p)}`), ...anc.map((a) => `a ${a}`)];
  return { key: sha(`lint2\n${name}\n${cmd}\n${salt}\n${lines.join("\n")}\n${e.env}`), hidden: null };
}

/**
 * PURE. The pre-push reuse rule (run-lints --reuse-ci): a CI pass whose every root still has the object
 * id it had then. A pass that recorded no ids, a hidden lint, or any root moved: not reused.
 * @param {{ ids?: Record<string, string>, hidden?: string[] }} m @param {Map<string, string>} now
 */
export function rootsUnchanged(m, now) {
  if (!m?.ids || m.hidden?.length) return false;
  const roots = Object.entries(m.ids);
  return roots.length > 0 && roots.every(([r, id]) => id != null && now.get(r) === id);
}
