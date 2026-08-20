#!/usr/bin/env tsx
/**
 * lint:notification-deep-links — a notification about ONE thing links to that
 * thing, not to the page it lives on.
 *
 * A notification names a specific record: this parcel, this order, this item.
 * Landing someone on a list of thirty makes them do the finding a second time,
 * having already been told the answer. The id is always in hand at dispatch —
 * that is what makes the notification possible at all.
 *
 * It shipped twice. The arrival sweep dispatched with no `link_url` at all, so
 * the row went nowhere; then the receipt sweep sent a bare "/scan" while the
 * batch id sat in the same scope.
 *
 * The rule: a `link_url` that is a bare top-level route literal is a smell.
 * Deep-link it (`/scan?batch=${id}`, `/purchases#order-${id}`) or say why it
 * cannot be with `// PAGE-LINK: <reason>` directly above.
 *
 * Run: npx tsx scripts/lint-notification-deep-links.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["modules", "api/src"];
/** `link_url: "/scan"` — a literal with no id, query or fragment in it. */
const BARE = /link_url\s*:\s*["'`](\/[a-z0-9-]+(?:\/[a-z0-9-]+)?)["'`]/i;

function walk(dir: string, out: string[] = []): string[] {
  let es: string[];
  try {
    es = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const e of es) {
    const rel = `${dir}/${e}`;
    if (e === "node_modules" || e === "dist") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".ts") && !rel.endsWith(".d.ts") && !rel.includes(".test.")) out.push(rel);
  }
  return out;
}

/** Predates the rule. Each is a settings/list surface where there may be no
 *  single record to point at — left alone rather than guessed at from outside
 *  the module that owns it. New code does not get this.
 *
 *  Keyed by file + the route itself, NOT by line number: a line-keyed baseline
 *  silently un-exempts its own entries the moment anyone inserts code above
 *  them, and then fails a PR that never touched the notification (it did,
 *  2026-08-21, on a 20-line insertion two hundred lines higher). A route that
 *  is genuinely new in one of these files still gets caught, because the key
 *  carries the route. */
const BASELINE = new Set([
  "modules/digifab/src/notify.ts:/configuration/farm",
  "api/src/platform/notifications.ts:/me/notification-channels",
  "api/src/routes/me.ts:/configuration/links",
  "api/src/routes/super-admin.ts:/me/feedback",
]);

const findings: string[] = [];
for (const file of walk(".") .concat(DIRS.flatMap((d) => walk(d)))) {
  if (!DIRS.some((d) => file.startsWith(d))) continue;
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = BARE.exec(line);
    if (!m) return;
    // An explicit, reasoned exemption on the line above.
    const prev = (lines[i - 1] ?? "") + (lines[i - 2] ?? "");
    if (prev.includes("PAGE-LINK:")) return;
    if (BASELINE.has(`${file}:${m[1]}`)) return;
    findings.push(`  ${file}:${i + 1}  links to the page "${m[1]}", not to the record`);
  });
}

if (findings.length) {
  console.error(`❌ ${findings.length} notification(s) linking to a page rather than a record:\n`);
  console.error(findings.join("\n"));
  console.error(
    "\nThe id is in scope wherever you are dispatching — use it:\n" +
      "  /scan?batch=${batchId}        one receipt session\n" +
      "  /purchases#order-${orderId}   one order (PurchasesPage renders the anchor)\n" +
      "If it genuinely has no single record, say so: // PAGE-LINK: <reason>",
  );
  process.exit(1);
}
console.log("notification-deep-links lint: clean");
