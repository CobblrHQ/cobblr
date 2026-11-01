// An exemption from a capability row, written in the exempted file itself:
//
//   // capability-except activity:a-change-and-its-history-line-commit-together: why this file differs
//
// The registry's `except` table is one shared block, so every PR that moved a
// file off it edited the same lines as every other, and parallel PRs over
// different modules conflicted there again and again (#9042 needed three merges).
// A marker sits beside the code it excuses, so a PR touches only its own module.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reason a file gives for being exempt from capability `id`, or null. A
 *  marker with no reason is no exemption: a decision is written down or absent. */
export function inFileExemption(raw: string, id: string): string | null {
  const m = new RegExp(`capability-except ${escape(id)}:[ \\t]*(.*)$`, "m").exec(raw);
  const why = m?.[1]?.replace(/\*\/\s*$/, "").trim();
  return why ? why : null;
}
