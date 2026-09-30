// Run a list of shell commands concurrently, buffering each one's output so the
// combined log stays readable.
//
// WHY THIS EXISTS: the typecheck CI job spent most of its wall clock starting
// processes, not checking anything. ~90 lint scripts were invoked one per CI
// step, each paying pnpm + tsx startup (~600ms) to do ~100ms of work. Serialised,
// that's ~70s of the job; run 8-at-a-time it's ~10s.
//
// Interleaved stdout from parallel children is unreadable, so nothing streams:
// each child's output is captured and printed as one block when it finishes, and
// a passing job prints a single line. That keeps a failure as greppable as it was
// when every lint had its own step.

import { spawn } from "node:child_process";
import { splitShare, width } from "./job-budget.mjs";

/** Default fan-out: from the box's cores and free memory, capped. The CI
 *  runner boxes are shared (scripts/lib/job-budget.mjs). */
export function defaultConcurrency(cap = 8) {
  return width("lint", { max: cap });
}

/**
 * @param {{name: string, cmd: string, cwd?: string}[]} jobs
 * @param {{concurrency?: number, failFast?: boolean, onDone?: (r: {name: string, code: number, ms: number, out: string}) => void}} opts
 * @returns {Promise<{name: string, code: number, ms: number, out: string}[]>} results in completion order
 *
 * failFast: the first job to fail stops the others (their whole process
 * groups) and starts no more; each stopped one reports code 130 and says
 * which failure stopped it. Opt-in, for a step whose parts are one verdict
 * (the typecheck job's lint suite, export gate and unit suites): there a
 * failed lint already makes the job red, and the unit suites running on for
 * minutes after it only spent a runner (#4303: 22% of PR typechecks fail).
 * Never for the lint suite itself, which must report every failing lint.
 */
export async function runParallel(jobs, { concurrency = defaultConcurrency(), failFast = false, onDone } = {}) {
  const queue = [...jobs];
  const results = [];
  const running = new Set();
  let stoppedBy = null;
  // The commands running together split this process's memory budget, so they
  // cannot each size themselves for the whole room (lib/job-budget.mjs).
  const share = splitShare(Math.min(concurrency, jobs.length));

  const runOne = (job) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(job.cmd, {
        shell: true,
        cwd: job.cwd,
        // Its own process group under failFast, so stopping it stops what it started.
        detached: failFast,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", ...share, ...(job.env ?? {}) },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      // A spawn failure (bad interpreter, ENOENT) must fail the job, not hang it.
      running.add(child);
      child.on("error", (err) => {
        running.delete(child);
        resolve({ name: job.name, code: 1, ms: Date.now() - started, out: out + String(err) });
      });
      child.on("close", (code) => {
        running.delete(child);
        if (child.stoppedBy) resolve({ name: job.name, code: 130, ms: Date.now() - started, out: `${out}\n(stopped: ${child.stoppedBy} failed first)` });
        else resolve({ name: job.name, code: code ?? 1, ms: Date.now() - started, out });
      });
    });

  const stopTheRest = (failed) => {
    stoppedBy = failed;
    for (const c of running) {
      c.stoppedBy = failed;
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        c.kill("SIGTERM");
      }
    }
  };

  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      if (stoppedBy) {
        const result = { name: job.name, code: 130, ms: 0, out: `(not started: ${stoppedBy} failed first)` };
        results.push(result);
        onDone?.(result);
        continue;
      }
      const result = await runOne(job);
      results.push(result);
      onDone?.(result);
      if (failFast && result.code !== 0 && !stoppedBy) stopTheRest(result.name);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}
