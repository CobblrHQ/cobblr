// How wide may this job run, on the box it landed on?
//
// CI job containers on a shared runner box have no memory limit of their own:
// they share the box's cap. On 2026-09-29 the A6 CI container sat at its 12 GB
// cap with seven jobs in it (typecheck jobs peaking 1.7-3.3 GB, test jobs
// 2.6-3.3 GB) and the thrash watchdog restarted the whole container, taking
// the dev rig down with it, the second time in two days. Every job sized its
// fan-out from a constant (tsc 4-8 workspaces, vitest a fork per core, lints
// 4-8) as if it had the box to itself.
//
// So a width is read from the box at the moment the job starts:
//   width = min(max, cores, floor(available memory * SHARE / per-unit cost))
// never below 1. Available memory is the smaller of MemAvailable and the room
// left under this cgroup's own limit, when it has one. SHARE leaves the rest
// for jobs that start after this one on the same box. Load is not a bound: it
// is memory that restarts the box, and narrowing on load made a job crawl on
// exactly the busy box where it most needs to finish and leave.
//
// ONE BUDGET PER JOB, SPLIT AMONG ITS FAN-OUTS. The typecheck job starts the
// lint suite and the unit suites together (scripts/run-parallel.mjs), and each
// read the same room and took SHARE of it: two halves of one room is all of
// it, before the lints' own children. runParallel now hands each of the N
// commands it starts together 1/N of its own share (COBBLR_JOB_BUDGET_SHARE),
// so fan-outs started together never promise more than the room between them.
// A job under its OWN cgroup limit shares that room with no other job, so its
// share is CAPPED_SHARE; on a box without one it leaves half for the jobs that
// arrive after it.
//
// Per-unit costs are measured peaks, rounded up (docs/operations/CI_DEPLOY.md,
// "Job width follows the box"). COBBLR_<KIND>_CONCURRENCY still pins a width
// when set (a person's decision beats the estimate).
import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { getHeapStatistics } from "node:v8";
import { fileURLToPath } from "node:url";

/** Peak resident memory of one unit of each kind, MiB. */
// tsgo (the Go compiler, TypeScript 7) has no node heap to set: its peak is
// its own. 3072 MiB since 2026-10-22: api's tsconfig.tests.json peaks at 2508-2611
// alone and its src at 1244 (measured at 1bdd0fa4, one at a time), with room for
// a run's own wobble so the check below is never a false red. Counted at
// 900 (its 2026-09-30 peak), main's typecheck ran two side by side at 2.46 and
// 2.19 GiB under a 4.5 GiB cap and sat at it for 20 minutes (#7741). A run
// reads each compiler's peak and fails by name when one outgrows this
// (typecheck-tsgo.mjs, outgrewUnit), so it cannot go stale silently again.
export const UNIT_MIB = { tsc: 900, tsgo: 3072, vitest: 350, lint: 150 };
export const SHARE = 0.5;
// The heap a node process of a kind needs, MiB: measured, not estimated. node
// sets its default heap to HALF the cgroup's limit (920 MiB under 1792m, 1048
// under 2048m), and web's `tsc -b` aborts with "heap out of memory" at a 1024
// MiB heap and passes at 1280, peaking at 1.3 GiB resident (2026-09-30: every
// capped typecheck died in V8 with 700 MiB of its cap unused, and main went
// red). So the heap is set, never left to the default, and a cap that cannot
// hold it fails by name.
// 3072 since 2026-10-30 (#8950): api's `tsc --noEmit -p tsconfig.tests.json`
// uses 2155 MiB of heap (--extendedDiagnostics "Memory used", main at 2f7779597)
// and dies at node's 2048 MiB default, which the old 1536 never raised: the
// tracker's typecheck-tsc was red on 13 runs of main in a row.
export const HEAP_NEED_MIB = { tsc: 3072 };
const HEAP_OVERHEAD_MIB = 256;
export const CAPPED_SHARE = 0.8;
const SHARE_ENV = "COBBLR_JOB_BUDGET_SHARE";
const PIN = { tsc: "COBBLR_TSC_CONCURRENCY", tsgo: "COBBLR_TSGO_CONCURRENCY", vitest: "COBBLR_VITEST_WORKERS", lint: "COBBLR_LINT_CONCURRENCY" };
// A ceiling a workflow sets for CPU reasons (the shared CI box), which memory
// can only lower: COBBLR_TSC_MAX / COBBLR_VITEST_MAX / COBBLR_LINT_MAX.
const CAP = { tsc: "COBBLR_TSC_MAX", tsgo: "COBBLR_TSGO_MAX", vitest: "COBBLR_VITEST_MAX", lint: "COBBLR_LINT_MAX" };

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** This process's own cgroup memory limit, MiB, or null when it has none. */
export function cgroupLimitMib() {
  const cg = /^0::(.*)$/m.exec(read("/proc/self/cgroup") ?? "")?.[1]?.trim();
  if (cg == null) return null;
  const raw = read(`/sys/fs/cgroup${cg === "/" ? "" : cg}/memory.max`)?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) / 1048576 : null;
}

/**
 * The node flag that gives a process of `kind` the heap it needs, or why this
 * job cannot. Never LOWERS node's own default: on a big uncapped box the
 * default is already larger, and the flag is empty.
 * @param {"tsc"} kind
 * @param {{ limitMib?: number | null, defaultHeapMib?: number }} [o]
 */
export function heapFor(kind, o = {}) {
  const need = HEAP_NEED_MIB[kind];
  const limit = o.limitMib === undefined ? cgroupLimitMib() : o.limitMib;
  if (limit != null && limit < need + HEAP_OVERHEAD_MIB) {
    const total = need + HEAP_OVERHEAD_MIB;
    return {
      ok: false,
      need: total,
      limit: Math.floor(limit),
      message: `cap too small for ${kind}: needs ${total} MiB (a ${need} MiB heap and ${HEAP_OVERHEAD_MIB} for the rest of node), this job's memory limit is ${Math.floor(limit)} MiB. Raise the runner's cap for this job.`,
    };
  }
  const defaultHeap = o.defaultHeapMib ?? getHeapStatistics().heap_size_limit / 1048576;
  return { ok: true, flag: defaultHeap >= need ? "" : `--max-old-space-size=${need}` };
}

/**
 * What one process of `kind` may grow to, MiB. A kind whose heap is set
 * (HEAP_NEED_MIB) is counted at that heap and node's overhead, not at its
 * typical peak: two tsc runs each allowed 1536 MiB were started side by side
 * under a 2048 MiB job limit because each was counted at 900, and the job was
 * OOM-killed on a pull request that touched one test file (2026-09-30).
 */
export function unitMib(kind) {
  const heap = HEAP_NEED_MIB[kind];
  return heap ? Math.max(UNIT_MIB[kind], heap + HEAP_OVERHEAD_MIB) : UNIT_MIB[kind];
}

/** The kind a shell command is, when it is one whose width is budgeted, else null. */
export function kindOfCommand(cmd) {
  const m = /(^|[\s/])(tsc|tsgo)(\s|$)/.exec(cmd);
  return m ? /** @type {"tsc" | "tsgo"} */ (m[2]) : null;
}

/** The fewest forks the api integration suite may run on. One fork runs a
 *  full suite in 25 to 58 minutes, past the job's own limits; two finish. */
export const SUITE_MIN_FORKS = 2;
/** What the integration suite's job needs for its full width, MiB: the api
 *  and postgres (about 1.6 GiB) plus six forks at ~320 each. Measured from the
 *  job memory peaks, 2026-09-30: 3.3 to 4.0 GiB at six forks, the 2 GiB cap at one. */
export const SUITE_FULL_WIDTH_MIB = 4096;

/**
 * The forks the api integration suite runs on, or why it must not run: under a
 * job limit that leaves room for fewer than SUITE_MIN_FORKS, the suite went
 * serial without a word and timed out 40 minutes later (runs 33220 and 33254,
 * 0.8 effective forks under 2048 MiB).
 * @param {{ max?: number, cores?: number, memMib?: number | null, capped?: boolean, limitMib?: number | null, env?: Record<string, string | undefined> }} [o]
 */
export function suiteForks(o = {}) {
  const forks = width("vitest", o);
  const env = o.env ?? process.env;
  const pinned = Number(env[PIN.vitest]);
  const capped = o.capped ?? memoryRoom().capped;
  if (!capped || forks >= SUITE_MIN_FORKS || (Number.isInteger(pinned) && pinned > 0)) return { ok: true, forks };
  const limit = o.limitMib === undefined ? cgroupLimitMib() : o.limitMib;
  return {
    ok: false,
    forks,
    message:
      `cap too small for the integration suite: ${forks} fork(s) under a ${limit == null ? "?" : Math.floor(limit)} MiB job limit, ` +
      `and one fork runs a full suite past the job's own time limit. It needs ${SUITE_FULL_WIDTH_MIB} MiB for its full width. ` +
      `Raise the runner's cap for this job (or pin ${PIN.vitest} to run narrow on purpose).`,
  };
}

/** Memory this process can still use, MiB: MemAvailable, and the room under its cgroup's limit. */
export function availableMib() {
  return memoryRoom().mib;
}

/**
 * MiB a capped cgroup can still grow by: its limit minus what is NOT reclaimable. memory.current counts the
 * page cache, which the kernel gives back under pressure and which therefore never OOMs a job; counting it as
 * used made a job that had just installed and built its tree see no room under its cap. On 2026-10-06 the
 * full-suite job under a 6656 MiB cap read ~0.5 GiB of room (the rest was cache from the install), picked ONE
 * vitest fork, and the config refused to start the suite ("cap too small for the integration suite"), main red.
 * @param {{ limit: number, current: number, file?: number }} v   bytes; file is memory.stat's page cache
 */
export function roomUnderLimitMib({ limit, current, file = 0 }) {
  const working = Math.max(0, current - Math.max(0, file));
  return (limit - working) / 1048576;
}

/** The room (as availableMib) and whether it is this job's own cgroup limit. */
export function memoryRoom() {
  const meminfo = read("/proc/meminfo");
  const avail = meminfo ? Number(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1]) / 1024 : NaN;
  // This process's own cgroup (cgroup v2), not the root: in a job container
  // with its own cgroup namespace the path is "/", on a host it is a slice.
  const cg = /^0::(.*)$/m.exec(read("/proc/self/cgroup") ?? "")?.[1]?.trim();
  const dir = cg == null ? null : `/sys/fs/cgroup${cg === "/" ? "" : cg}`;
  const num = (f) => {
    const raw = dir ? read(`${dir}/${f}`)?.trim() : undefined;
    return raw && /^\d+$/.test(raw) ? Number(raw) : null; // "max" or absent: no limit
  };
  const limit = num("memory.max");
  const used = num("memory.current");
  const stat = dir ? read(`${dir}/memory.stat`) : undefined;
  const file = stat ? Number(/^file\s+(\d+)/m.exec(stat)?.[1]) : NaN;
  const room = limit != null && used != null ? roomUnderLimitMib({ limit, current: used, file: Number.isFinite(file) ? file : 0 }) : Infinity;
  const v = Math.min(Number.isFinite(avail) ? avail : Infinity, room);
  return { mib: Number.isFinite(v) ? v : null, capped: limit != null };
}

/** The fraction of the room this process may promise: what its parent handed
 *  it, else CAPPED_SHARE under its own limit, else SHARE. */
export function shareOf(env = process.env, capped = memoryRoom().capped) {
  const handed = Number(env[SHARE_ENV]);
  if (Number.isFinite(handed) && handed > 0 && handed <= 1) return handed;
  return capped ? CAPPED_SHARE : SHARE;
}

/** The env a fan-out gives each of `n` commands it runs together: 1/n of its share. */
export function splitShare(n, env = process.env, capped) {
  const share = shareOf(env, capped ?? memoryRoom().capped);
  return { [SHARE_ENV]: String(share / Math.max(1, n)) };
}

/**
 * PURE. The peak resident memory of every process named `comm` that descends from `root`, from a /proc reading
 * ({pid, ppid, comm, hwmKib: VmHWM, args}). Only descendants: on a workstation other worktrees' compilers run too.
 * @param {{ pid: number, ppid: number, comm: string, hwmKib: number, args?: string }[]} procs
 */
export function descendantPeaks(procs, root, comm) {
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out = [];
  const walk = (pid) => {
    for (const k of kids.get(pid) ?? []) {
      if (k.comm === comm) out.push({ pid: k.pid, mib: Math.round(k.hwmKib / 1024), args: k.args ?? k.comm });
      walk(k.pid);
    }
  };
  walk(root);
  return out;
}

/** PURE. The peaks over `unitMib`: a per-unit cost that went stale, which narrows nothing and lets a job thrash. */
export function outgrewUnit(peaks, unitMib) {
  return peaks.filter((p) => p.mib > unitMib).map(({ pid, mib, args }) => ({ pid, mib, args }));
}

/** Every process's pid, parent, name, peak resident memory and command line, from /proc; [] where there is none. */
export function readProcs() {
  let ids = [];
  try {
    ids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const status = read(`/proc/${id}/status`);
    if (!status) continue;
    const field = (k) => new RegExp(`^${k}:\\s+(.+)$`, "m").exec(status)?.[1]?.trim();
    out.push({
      pid: Number(id),
      ppid: Number(field("PPid")),
      comm: field("Name") ?? "",
      hwmKib: Number(/^(\d+)/.exec(field("VmHWM") ?? "0")?.[1] ?? 0),
      args: (read(`/proc/${id}/cmdline`) ?? "").split("\0").filter(Boolean).join(" ").slice(0, 160),
    });
  }
  return out;
}

/** The cores one heavy slot may use (#7202): inside scripts/heavy-slot.sh, the box's cores over its slot count.
 *  A slot was sized as if it had the box: typecheck-tsgo fanned out to ~10 compilers in each of 4 slots, and the
 *  fleet VM's 12 cores ran at load 87 with the slots "holding". Outside a slot (CI's own containers), all of them. */
export function slotCores(cores, env = process.env) {
  const slots = Number(env.HEAVY_SLOT_COUNT);
  if (!env.HEAVY_SLOT_HELD || !Number.isInteger(slots) || slots < 1) return cores;
  return Math.max(1, Math.floor(cores / slots));
}

/**
 * @param {"tsc"|"vitest"|"lint"} kind
 * @param {{ max?: number, cores?: number, memMib?: number | null, capped?: boolean, env?: Record<string, string | undefined> }} [o]
 */
export function width(kind, o = {}) {
  const env = o.env ?? process.env;
  const pinned = Number(env[PIN[kind]]);
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  const cap = Number(env[CAP[kind]]);
  const max = Math.min(o.max ?? 8, Number.isInteger(cap) && cap > 0 ? cap : Infinity);
  const cores = slotCores(Math.floor(o.cores ?? availableParallelism()), env);
  const room = o.memMib === undefined ? memoryRoom() : { mib: o.memMib, capped: o.capped ?? false };
  const mem = room.mib;
  const byMem = mem == null ? max : Math.floor((mem * shareOf(env, room.capped)) / unitMib(kind));
  return Math.max(1, Math.min(max, cores, byMem));
}

// node scripts/lib/job-budget.mjs <kind> [max]   prints the width
// node scripts/lib/job-budget.mjs report          one line of what it read
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [kind, max] = process.argv.slice(2);
  if (kind === "report") {
    const mem = availableMib();
    console.log(
      `job budget: ${availableParallelism()} cores, ${mem == null ? "unknown" : Math.round(mem)} MiB available, share ${shareOf()}; ` +
        `tsc ${width("tsc")}, tsgo ${width("tsgo")}, vitest ${width("vitest")}, lint ${width("lint")}`,
    );
  } else if (kind === "share") {
    // node scripts/lib/job-budget.mjs share <n>   each of n commands' slice of this process's share
    process.stdout.write(`${splitShare(Number(max) || 1).COBBLR_JOB_BUDGET_SHARE}\n`);
  } else if (kind === "heap") {
    // node scripts/lib/job-budget.mjs heap tsc   the flag (or nothing), else exit 3 naming the cap
    const h = heapFor(max);
    if (!h.ok) {
      console.error(`::error::${h.message}`);
      process.exit(3);
    }
    console.log(h.flag);
  } else if (kind in UNIT_MIB) {
    console.log(width(kind, max ? { max: Number(max) } : {}));
  } else {
    console.error("usage: job-budget.mjs <tsc|vitest|lint> [max] | heap <tsc> | share <n> | report");
    process.exit(2);
  }
}
