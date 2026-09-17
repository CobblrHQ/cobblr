// A vitest reporter that names an assertion for what it is when it followed a
// timed-out attempt (#3150).
//
// vitest's `retry` re-runs a test that timed out, and the retry runs on
// whatever the first attempt left behind: rows it inserted before the clock
// ran out, a session it opened. So the retry fails an ASSERTION ("expected 3
// but got 4"), the reporter prints both errors, and a reader takes the last
// one as the finding. On 2026-09-17 that sent two sessions hunting a
// scan-review regression that did not exist; the box was at 63 load on
// twelve cores and the test had timed out. One line next to the failure
// would have cost a minute instead of an evening. This prints that line, from
// the task results themselves (every attempt's error is kept on
// result.errors), so it is true wherever vitest runs: the CI job, the
// tracker, a dev box.
//
//   npx vitest run --reporter dot --reporter ../scripts/lib/vitest-timeout-aftermath-reporter.mjs
//
// The pure half, aftermathFromTasks, is what the test proves.

import { relative } from "node:path";

const TIMEOUT_RE = /\b(Test|Hook) timed out in \d+ms/;

/**
 * @param {Array<{ name?: string, filepath?: string, type?: string, tasks?: any[], result?: { state?: string, errors?: Array<{ message?: string }> } }>} files
 * @returns {string[]}
 */
export function aftermathFromTasks(files) {
  const out = [];
  const walk = (task, path, file) => {
    const name = task.name ? [...path, task.name] : path;
    if (task.type === "test" || task.type === "custom") {
      const errors = task.result?.errors ?? [];
      if (task.result?.state === "fail" && errors.length > 1) {
        const timeout = errors.some((e) => TIMEOUT_RE.test(String(e?.message ?? "")));
        const other = errors.some((e) => !TIMEOUT_RE.test(String(e?.message ?? "")));
        if (timeout && other) out.push(`${file} > ${name.join(" > ")}: the assertion followed a timed-out attempt; the retry ran on the first attempt's leftovers, so it is not a finding (#3150)`);
      }
      return;
    }
    for (const t of task.tasks ?? []) walk(t, name, file);
  };
  for (const f of files ?? []) {
    const raw = String(f.filepath ?? f.name ?? "");
    const file = raw.startsWith("/") ? relative(process.cwd(), raw) : raw;
    for (const t of f.tasks ?? []) walk(t, [], file);
  }
  return out;
}

export default class TimeoutAftermathReporter {
  onFinished(files = []) {
    const lines = aftermathFromTasks(files);
    if (!lines.length) return;
    process.stdout.write(`\n!! ${lines.length} assertion(s) followed a timed-out attempt (the box's load, not the code; #3150):\n`);
    for (const l of lines) process.stdout.write(`!!   ${l}\n`);
  }
}
