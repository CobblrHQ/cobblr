// A ticket's announcement goes back to the server the ticket came from.
//
// `announce()` routes on `originGuildId`, and without one it falls back to the
// operator's own ops server. Ingest has always passed it. The REOPEN notice in
// /feedback/append never did, so a follow-up on a self-hoster's ticket
// announced itself in the one place the people in that conversation cannot see
// it (reported 2026-09-04, on a ticket that should not have reopened at all).
//
// Nothing failed. The notice was posted, to the wrong audience, and only a
// person who happened to be in both servers could notice.
//
// So a feedback announcement must either route home or say why it cannot. A DM
// genuinely has no guild, which is the shape of the legitimate exemption:
//
//     // no-origin-guild: <reason>
//
// Deliberately narrow: only `feedback.*` categories, which are the ones tied to
// a reporter sitting in a particular server.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["api/src/routes/super-admin.ts", "api/src/routes/feedback.ts"];

const problems: Array<{ file: string; line: number; category: string }> = [];

for (const rel of FILES) {
  let src: string;
  try { src = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = src.split("\n");

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "announce") {
      const [cat, payload] = node.arguments;
      const category = cat?.getText(sf) ?? "";
      if (/feedback\./.test(category) && payload && ts.isObjectLiteralExpression(payload)) {
        const routes = payload.properties.some((p) => p.name?.getText(sf) === "originGuildId");
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        // The exemption sits inside the payload, where the reason is readable.
        const body = payload.getText(sf);
        if (!routes && !/no-origin-guild:/.test(body)) {
          problems.push({ file: rel, line: line + 1, category: category.replace(/["']/g, "") });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  void lines;
}

if (problems.length) {
  console.error("lint:announce-routes-home - a feedback announcement with nowhere to go but the ops server:\n");
  for (const p of problems) console.error(`  ${p.file}:${p.line}  announce(${p.category}, …)`);
  console.error(
    "\nWithout `originGuildId` this posts to the operator's own server, so a notice\n" +
      "about somebody's ticket lands where the people in that conversation cannot\n" +
      "see it — and nothing fails, it is simply the wrong audience.\n\n" +
      "Pass the ticket's guild:\n" +
      "  originGuildId: ((row.origin_ref ?? {}) as { guild_id?: string }).guild_id ?? null,\n" +
      "or say why there is none (a DM has no guild):\n" +
      "  // no-origin-guild: <reason>\n",
  );
  process.exit(1);
}
console.log("lint:announce-routes-home - feedback announcements route back to the server they came from.");
