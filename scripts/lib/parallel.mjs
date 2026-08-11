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
import os from "node:os";

/** Default fan-out: one per core, capped — the CI runners are shared. */
export function defaultConcurrency(cap = 8) {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(cap, cores));
}

/**
 * @param {{name: string, cmd: string, cwd?: string}[]} jobs
 * @param {{concurrency?: number, onDone?: (r: {name: string, code: number, ms: number, out: string}) => void}} opts
 * @returns {Promise<{name: string, code: number, ms: number, out: string}[]>} results in completion order
 */
export async function runParallel(jobs, { concurrency = defaultConcurrency(), onDone } = {}) {
  const queue = [...jobs];
  const results = [];

  const runOne = (job) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(job.cmd, {
        shell: true,
        cwd: job.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      // A spawn failure (bad interpreter, ENOENT) must fail the job, not hang it.
      child.on("error", (err) => resolve({ name: job.name, code: 1, ms: Date.now() - started, out: out + String(err) }));
      child.on("close", (code) => resolve({ name: job.name, code: code ?? 1, ms: Date.now() - started, out }));
    });

  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const result = await runOne(job);
      results.push(result);
      onDone?.(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}
