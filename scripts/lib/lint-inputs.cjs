// Preloaded into every lint by run-lints.mjs when the verdict cache is on (NODE_OPTIONS --require,
// beside lint-reads.cjs): records WHAT a lint observes, so a pass can be reused while all of it is
// unchanged (#4303, lib/lint-verdicts.mjs). One JSON line per node process to
// $COBBLR_LINT_INPUTS_FILE at exit; every node process the lint starts inherits this preload, so the
// lint's manifest is the union of its lines.
//
//   reads   repo files read (readFileSync, readFile, promises.readFile, createReadStream, openSync)
//   lists   directories listed (readdirSync, readdir, promises.readdir, opendirSync), with options
//   globs   glob patterns walked (globSync, promises.glob), with cwd and options
//   probes  existence and kind of a path (existsSync, statSync, lstatSync, accessSync, realpathSync, promises.stat/access)
//   gits    `git ls-files` / `git grep` / `git rev-parse --show-toplevel` calls: their output is replayed
//   loads   repo modules loaded (ESM and CommonJS), through module.registerHooks; the environment
//           variables a lint reads are read from these modules' sources (lib/lint-verdicts.mjs)
//   ancestors  names looked for in the directories above the repo (a tsconfig.json), replayed by name
//   hidden  why this lint may never be reused: any other subprocess, a read outside the repo
//
// node_modules is not an input (the lockfile is in the salt); the OS temp directory is the lint's own
// scratch. Anything this cannot see makes the lint `hidden`, never a quiet miss.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");

const out = process.env.COBBLR_LINT_INPUTS_FILE;
const ROOT = process.env.COBBLR_LINT_ROOT || process.cwd();
if (out) {
  const reads = new Set();
  const lists = new Map();
  const globs = new Map();
  const probes = new Set();
  const gits = new Map();
  const loads = new Set();
  const hidden = new Set();
  const ancestors = new Set();
  const TMP = fs.realpathSync(os.tmpdir());

  /** A repo-relative path, or null for a path that is not an input (node_modules, tmp, /dev, /proc). */
  const rel = (p) => {
    if (p == null) return null;
    let s = p instanceof URL ? p.pathname : typeof p === "string" ? p : Buffer.isBuffer(p) ? p.toString() : null;
    if (s == null) return null;
    const abs = path.resolve(s);
    // TypeScript probes paths in both cases; node_modules in any case is a dependency, not an input.
    if (/[\\/]node_modules([\\/]|$)/i.test(abs)) return null;
    const r = path.relative(ROOT, abs);
    const inside = !(r.startsWith("..") || path.isAbsolute(r));
    // The temp directory is the lint's own scratch, unless the repo itself lives there.
    if (!inside && (abs.startsWith(TMP) || abs.startsWith("/tmp/") || abs.startsWith("/dev/") || abs.startsWith("/proc/"))) return null;
    if (!inside) {
      // A config looked for in the directories above the repo (tsconfig.json, .npmrc): replayed by name.
      const dir = path.dirname(abs);
      if (ROOT === dir || ROOT.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) ancestors.add(path.basename(abs));
      else hidden.add(`reads ${abs}, outside the repo`);
      return null;
    }
    return r === "" ? "." : r.split(path.sep).join("/");
  };
  const wrap = (obj, name, before) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    const wrapped = function (...a) {
      try {
        before(...a);
      } catch {}
      return orig.apply(this, a);
    };
    // Keep what hangs off the original (fs.realpath.native, promisify's custom symbol), or a
    // dependency that reaches for it breaks: fs-extra did, "fs.realpath.native is not a function".
    for (const k of Reflect.ownKeys(orig)) {
      if (k === "length" || k === "name" || k === "prototype") continue;
      try {
        Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(orig, k));
      } catch {}
    }
    obj[name] = wrapped;
  };
  const read = (p) => {
    const r = rel(p);
    if (r) reads.add(r);
  };
  const list = (p, opts) => {
    const r = rel(p);
    if (!r) return;
    const o = opts && typeof opts === "object" ? { recursive: !!opts.recursive, withFileTypes: !!opts.withFileTypes } : { recursive: false, withFileTypes: false };
    lists.set(`${r}\0${o.recursive}\0${o.withFileTypes}`, [r, o]);
  };
  const glob = (pattern, opts) => {
    const cwd = rel(opts?.cwd ?? process.cwd());
    if (!cwd) return;
    // An exclude is replayed only when it is the shared isBuildOutput, by its name (lint:glob-exclude
    // allows no other); anything else cannot be, and the lint is not reused.
    let exclude = null;
    if (opts?.exclude != null && typeof opts.exclude !== "function") hidden.add("a glob excluded by a list (not replayed)");
    else if (typeof opts?.exclude === "function") {
      if (opts.exclude.name === "isBuildOutput") exclude = "isBuildOutput";
      else hidden.add(`a glob excluded by a function (${opts.exclude.name || "anonymous"}) that cannot be replayed`);
    }
    for (const pat of Array.isArray(pattern) ? pattern : [pattern]) globs.set(`${cwd}\0${pat}\0${JSON.stringify(exclude)}`, [cwd, String(pat), exclude]);
  };
  const probe = (p) => {
    const r = rel(p);
    if (r) probes.add(r);
  };

  for (const n of ["readFileSync", "readFile", "createReadStream", "openSync", "open"]) wrap(fs, n, (p) => typeof p !== "number" && read(p));
  wrap(fs.promises, "readFile", (p) => typeof p !== "number" && read(p));
  wrap(fs.promises, "open", (p) => read(p));
  for (const n of ["readdirSync", "readdir", "opendirSync", "opendir"]) wrap(fs, n, (p, o) => list(p, o));
  for (const n of ["readdir", "opendir"]) wrap(fs.promises, n, (p, o) => list(p, o));
  wrap(fs, "globSync", (p, o) => glob(p, o));
  wrap(fs, "glob", (p, o) => glob(p, typeof o === "function" ? undefined : o));
  wrap(fs.promises, "glob", (p, o) => glob(p, o));
  for (const n of ["existsSync", "statSync", "lstatSync", "accessSync", "realpathSync", "stat", "lstat", "access", "exists", "realpath"]) wrap(fs, n, (p) => probe(p));
  for (const n of ["stat", "lstat", "access", "realpath"]) wrap(fs.promises, n, (p) => probe(p));

  // Subprocesses: node inherits this preload (its reads are recorded by its own copy); git ls-files and
  // rev-parse are replayed by their output; anything else is a hidden input.
  const seeSpawn = (file, args, shell) => {
    const f = String(file ?? "");
    const base = path.basename(f.split(/\s+/)[0] ?? "");
    if (shell || /\s/.test(f)) {
      const line = shell ? `${f} ${(args ?? []).join(" ")}` : f;
      const m = /^\s*git\s+(ls-files|rev-parse|grep)\b([^|;&<>`$()]*)$/.exec(line);
      if (m) gits.set(line.trim(), ["--shell", line.trim()]);
      else if (!/^\s*(node|tsx)\s/.test(line)) hidden.add(`runs \`${line.slice(0, 80)}\``);
      return;
    }
    if (base === "node" || base === "tsx" || f === process.execPath) return;
    // git ls-files, git grep and rev-parse --show-toplevel answer from the tree alone: replayed by output.
    if (base === "git" && Array.isArray(args) && (args[0] === "ls-files" || args[0] === "grep" || (args[0] === "rev-parse" && args[1] === "--show-toplevel"))) {
      gits.set(["git", ...args].join(" "), args.map(String));
      return;
    }
    hidden.add(`runs ${base}${Array.isArray(args) && args[0] ? ` ${args[0]}` : ""}`);
  };
  for (const n of ["execFileSync", "execFile", "spawnSync", "spawn"]) wrap(cp, n, (file, args, o) => seeSpawn(file, Array.isArray(args) ? args : [], (Array.isArray(args) ? o : args)?.shell));
  for (const n of ["execSync", "exec"]) wrap(cp, n, (cmd) => seeSpawn(cmd, [], true));
  wrap(cp, "fork", () => {});

  // Every module this process loads from the repo, ESM and CommonJS, through node's own resolve hook:
  // a lint that imports by a computed name (node-resolves loads every package) is still seen whole.
  // Without the hook (node older than 22.15) the lint cannot be reused.
  // Not under tsx: its asynchronous loader and a synchronous resolve hook cannot share a process
  // ("resolveSync() is not implemented", lint:bundle-schema). There the lint is keyed by its script's
  // static closure alone, which must then be complete (no computed import).
  let loadsRecorded = false;
  try {
    const { registerHooks } = require("node:module");
    const { fileURLToPath } = require("node:url");
    if (typeof registerHooks !== "function") throw new Error("no registerHooks");
    if (/tsx|--loader|--experimental-loader/.test(`${process.execArgv.join(" ")} ${process.env.NODE_OPTIONS ?? ""}`)) throw new Error("an asynchronous loader");
    // `load`, not `resolve`: import.meta.resolve and require.resolve name a module without running it.
    registerHooks({
      load(url, context, next) {
        try {
          if (url.startsWith("file:")) {
            const p = rel(fileURLToPath(url));
            if (p) loads.add(p);
          }
        } catch {}
        return next(url, context);
      },
    });
    loadsRecorded = true;
  } catch {}

  process.on("exit", () => {
    try {
      fs.appendFileSync(out, JSON.stringify({
        reads: [...reads], lists: [...lists.values()], globs: [...globs.values()], probes: [...probes],
        gits: [...gits.values()], loads: [...loads], loadsRecorded, ancestors: [...ancestors], hidden: [...hidden],
      }) + "\n");
    } catch {}
  });
}
