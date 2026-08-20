/**
 * A hidden file input must have something that opens it.
 *
 * `<input type="file" className="hidden" ref={x} />` is invisible by design: the
 * only way a user reaches it is `x.current.click()` from a button or menu row.
 * Delete that call, or never write it, and the whole feature ships as dead
 * markup. Nothing fails. TypeScript is happy, the ref is "used" (it is passed to
 * the element), the handler is fully written and tested, and the capability
 * simply does not exist for anyone.
 *
 * Reported 2026-08-19: photographing a paper receipt gave back an inventory item
 * named after whatever the vision pass read off it. The receipt parser had
 * accepted images the whole time and `receiptRef` was sitting there with
 * `accept="image/*"` and an upload handler behind it, rendered on every visit to
 * the scan inbox, with no caller anywhere in the file.
 *
 * The check is deliberately literal - a ref attached to `type="file"` needs a
 * `.click()` on it somewhere in the same file - because that is exactly the
 * shape that failed, and a file input opened from another module would be an
 * odd thing to write.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".tsx")) yield p;
  }
}

const failures: string[] = [];

for (const file of [...walk(join(ROOT, "web/src")), ...walk(join(ROOT, "packages"))]) {
  const src = readFileSync(file, "utf8");
  if (!src.includes('type="file"')) continue;
  for (const ref of new Set([...src.matchAll(/ref=\{(\w+)\}/g)].map((m) => m[1]!))) {
    const onFileInput = new RegExp(
      `<input\\b[^>]*ref=\\{${ref}\\}[^>]*type="file"|<input\\b[^>]*type="file"[^>]*ref=\\{${ref}\\}`,
      "s",
    );
    if (!onFileInput.test(src)) continue;
    if (new RegExp(`${ref}\\.current\\??\\.click\\(\\)`).test(src)) continue;
    const line = src.slice(0, src.search(onFileInput)).split("\n").length;
    failures.push(
      `${file.replace(ROOT, "")}:${line} — the file input on \`${ref}\` is never opened.\n` +
        `    Nothing calls ${ref}.current?.click(), so it is hidden markup a user cannot reach.\n` +
        `    Give it a button or menu row, or delete the input and its handler.`,
    );
  }
}

if (failures.length) {
  console.error("lint:unreachable-file-input — a hidden file input with no way in:\n");
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log("lint:unreachable-file-input — ok");
