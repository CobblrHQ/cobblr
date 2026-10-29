// Can a workflow step ever run in this workflow? Pure, from the workflow's own text (#8531). A pr-check job's step that
// names a shipping secret but is guarded to main's pushes (`github.event_name == 'push' && github.ref_name == 'main'`)
// never runs in ci.yml, which has no push trigger, nor in ci-recheck.yml, which pushes only `recheck/**`: the lane it
// runs in is ci-main.yml, generated from the same ci.yml. Only what the workflow's triggers and env can never make true
// counts as false; anything this cannot read counts as possibly true, so the answer errs towards "it can run".

/** The workflow's triggers: which events, and which branches a push may be on (null = any). */
export function triggersOf(src) {
  const on = (/^on:\n([\s\S]*?)(?=^\S)/m.exec(src)?.[1] ?? "").split("\n");
  const events = new Set();
  let pushBranches = null;
  let inPush = false;
  for (const l of on) {
    const ev = /^ {2}([a-z_]+):/.exec(l);
    if (ev) { events.add(ev[1]); inPush = ev[1] === "push"; continue; }
    const br = /^ {4}branches:\s*\[(.*)\]/.exec(l);
    if (inPush && br) pushBranches = br[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter((s) => s && !s.startsWith("!"));
  }
  return { events, pushBranches };
}

const globRx = (g) => new RegExp("^" + g.split("**").map((p) => p.split("*").map((q) => q.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");

/** Could this workflow run on a branch named `name`, or one starting with `prefix`? */
function mayBeOnBranch(t, { name, prefix }) {
  if (t.events.has("workflow_dispatch") || t.events.has("schedule") && name === "main") return true;
  if (!t.events.has("push")) return false;
  if (t.pushBranches === null) return true;
  return t.pushBranches.some((g) => (name ? globRx(g).test(name) : g.startsWith(prefix) || globRx(g).test(prefix + "x")));
}

/** One atom of an `if:`: false only when the workflow can never make it true. */
function atomFalse(atom, t, env) {
  const a = atom.trim();
  let m;
  if ((m = /^github\.event_name\s*==\s*'(\w+)'$/.exec(a))) return !t.events.has(m[1]);
  if (/^github\.ref_name\s*==\s*'main'$/.test(a) || /^github\.ref\s*==\s*'refs\/heads\/main'$/.test(a)) return !mayBeOnBranch(t, { name: "main" });
  if ((m = /^startsWith\(github\.ref,\s*'refs\/heads\/([^']+)'\)$/.exec(a))) return !mayBeOnBranch(t, { prefix: m[1] });
  if ((m = /^env\.(\w+)\s*==\s*'[^']+'$/.exec(a))) return !env.has(m[1]);
  return false;
}

/** Whether `expr` can be true in this workflow: `&&`, `||` and parentheses over atoms; anything else may be true. */
export function mayRun(expr, src) {
  if (!expr || !expr.trim()) return true;
  const t = triggersOf(src);
  const env = new Set([...src.matchAll(/^\s+(\w+):\s*\$\{\{/gm)].map((m) => m[1]).concat([...src.matchAll(/^\s+(\w+):\s*["']?[^$\n]/gm)].map((m) => m[1])));
  const s = expr.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  let i = 0;
  // Each parser returns whether its part may be true.
  const or = () => { let v = and(); while (s.startsWith("||", skip())) { i += 2; v = and() || v; } return v; };
  const and = () => { let v = unit(); while (s.startsWith("&&", skip())) { i += 2; v = unit() && v; } return v; };
  const skip = () => { while (s[i] === " ") i++; return i; };
  const unit = () => {
    skip();
    if (s[i] === "!") { i++; unit(); return true; }
    if (s[i] === "(") { i++; const v = or(); skip(); if (s[i] === ")") i++; return v; }
    let depth = 0, j = i;
    while (j < s.length) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") { if (depth === 0) break; depth--; }
      else if (depth === 0 && (s.startsWith("&&", j) || s.startsWith("||", j))) break;
      j++;
    }
    const atom = s.slice(i, j);
    i = j;
    return !atomFalse(atom, t, env);
  };
  return or();
}
