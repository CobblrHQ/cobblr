// The backlog is one file per entry (docs/backlog.d/<slug>.md) behind a fixed
// index (docs/BACKLOG.md). One file used to hold all of it, and feature pull
// requests struck or added entries in it, so unrelated ones collided in the
// merge queue (#7383). Everything that reads or renders the backlog goes through here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BACKLOG_INDEX = "docs/BACKLOG.md";
export const BACKLOG_DIR = "docs/backlog.d";
export const STATUSES = ["open", "parked", "shipped"];

export const INDEX_TEXT = `# Backlog

Deliberately deferred or known-missing functionality. Each entry is its own
file in [\`backlog.d/\`](./backlog.d/): what is missing, why it matters, and
what blocks it. Two pull requests that add or close unrelated entries never
edit one file (#7383), so this page is fixed and \`lint:backlog-index\`
refuses a change to it.

## Reading it

\`pnpm run backlog\` prints every open and parked entry as one page;
\`pnpm run backlog -- --all\` adds the shipped ones not yet archived. Shipped entries live in
[\`history/BACKLOG-archive.md\`](./history/BACKLOG-archive.md).

## Adding, shipping, parking

- **Add:** a new \`docs/backlog.d/<slug>.md\` with front matter
  \`status: open\` and \`title: "<one line>"\`, then \`# <the title>\` and the
  body. Work that surfaces a gap adds one; a demo that would have to hardcode
  something (\`demo-sites/\`) flags the gap here instead.
- **Ship:** set \`status: shipped\` in that file in the pull request that ships
  it, and move what is now true into the docs it belongs in. An archive pass
  moves shipped files into the archive.
- **Park:** \`status: parked\`, with the reason in the body.

## Deferred lists

Every "deferred", "later" or "not yet" list in \`docs/modules/\` and
\`docs/design-decisions/\` links its own \`backlog.d/deferred-<doc>.md\`, whose
\`deferred_from:\` names that doc (\`lint:deferred-names-backlog\`). When an item
ships, delete its line there and move it into its doc's main text. Each line
carries a probe, \`<!-- open-while-absent: <term> -->\`, naming what the item
will be built under: \`lint:deferred-has-a-probe\` fails the day that term
appears in shipping source, so a shipped item cannot stay listed. A line with
nothing to name says why in \`<!-- no-probe: <why> -->\`.
`;

const at = (root, p) => (root ? join(root, p) : p);

/** PURE. An entry's front matter ({} when it has none) and its body after it. */
export function parseEntry(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {}
    }
    front[kv[1]] = v;
  }
  return { front, body: text.slice(m[0].length) };
}

/** Every entry file, as { file, front, body }, in name order. */
export function entries(root = "") {
  if (!existsSync(at(root, BACKLOG_DIR))) return [];
  return readdirSync(at(root, BACKLOG_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const file = `${BACKLOG_DIR}/${f}`;
      return { file, ...parseEntry(readFileSync(at(root, file), "utf8")) };
    });
}

/** The docs (paths under docs/) a deferred-list entry belongs to. */
export const deferredFrom = (front) => String(front.deferred_from ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** PURE. The whole backlog as one page: each entry's title as a section, its own headings one level down,
 *  and its relative links rewritten for docs/ (the page is printed, so they read from where the index sits). */
export function render(list, { all = false } = {}) {
  const shown = list.filter((e) => all || e.front.status !== "shipped");
  const out = [INDEX_TEXT.split("\n## ")[0].trimEnd(), ""];
  for (const status of STATUSES) {
    const group = shown.filter((e) => (e.front.status ?? "open") === status);
    if (!group.length) continue;
    out.push(`## ${status[0].toUpperCase()}${status.slice(1)} (${group.length})`, "");
    for (const e of group) {
      const body = e.body
        .trimStart()
        .replace(/^# .*\n+/, "")
        .replace(/^(#{1,5}) /gm, "$1## ")
        .replace(/\]\(\.\.\//g, "](./")
        .replace(/\]\((?!\.\/|[a-z]+:|#|\/)([^)]+)\)/g, "](./backlog.d/$1)");
      out.push(`### ${e.front.title ?? e.file}`, "", `<sub>${e.file}</sub>`, "", body.trim(), "");
    }
  }
  return out.join("\n");
}
