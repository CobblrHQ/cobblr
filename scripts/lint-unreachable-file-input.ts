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
 * shape that failed.
 *
 * The one file input that IS opened from another file is a shared picker: a
 * `forwardRef` component whose forwarded `ref` lands on the input (the scan
 * inbox and the dashboard's Photos tile render one `ScanPickerInput`). The
 * component file cannot open it, so the rule moves to the doors: every render
 * of such a component must pass a `ref={x}` and call `x.current?.click()` in
 * that same file. A render with no ref, or a ref nobody clicks, is the same
 * dead markup one hop away.
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
const files = [...walk(join(ROOT, "web/src")), ...walk(join(ROOT, "packages"))];

// A forwardRef component whose forwarded ref is the file input: its doors are
// its renders, checked below. `const Name = forwardRef<HTMLInputElement, …>(
// function Name(props, ref) { … <input type="file" ref={ref} /> … })`.
const pickerComponents = new Map<string, string>();
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!src.includes('type="file"') || !src.includes("forwardRef")) continue;
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*forwardRef<\s*HTMLInputElement\b[\s\S]*?\(\s*function\s+\w*\s*\(([\s\S]*?)\)\s*\{/g)) {
    const name = m[1]!;
    // The forwarded ref is the second parameter; the first is usually a
    // destructured props object, so strip braces before splitting on commas.
    const ref = (m[2] ?? "").replace(/\{[^}]*\}/g, "props").split(",").map((p) => p.trim()).filter(Boolean)[1];
    if (!ref) continue;
    const onFileInput = new RegExp(
      `<input\\b[^>]*ref=\\{${ref}\\}[^>]*type="file"|<input\\b[^>]*type="file"[^>]*ref=\\{${ref}\\}`,
      "s",
    );
    if (onFileInput.test(src)) pickerComponents.set(name, file);
  }
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const [name, home] of pickerComponents) {
    // A test renders the picker to press it; it is not a door.
    if (file === home || /\.test\.tsx$/.test(file)) continue;
    for (const m of src.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gs"))) {
      const attrs = m[1] ?? "";
      const ref = attrs.match(/\bref=\{(\w+)\}/)?.[1];
      const line = src.slice(0, m.index ?? 0).split("\n").length;
      if (!ref) {
        failures.push(
          `${file.replace(ROOT, "")}:${line} — <${name}> is rendered with no ref.\n` +
            `    Its file input opens only through a forwarded ref; pass ref={x} and call x.current?.click() from a button.`,
        );
      } else if (!new RegExp(`${ref}\\.current\\??\\.click\\(\\)`).test(src)) {
        failures.push(
          `${file.replace(ROOT, "")}:${line} — <${name} ref={${ref}}> is never opened.\n` +
            `    Nothing calls ${ref}.current?.click(), so the picker is hidden markup a user cannot reach.`,
        );
      }
    }
  }
  if (!src.includes('type="file"')) continue;
  const forwarded = new Set([...pickerComponents].filter(([, home]) => home === file).map(() => "ref"));
  for (const ref of new Set([...src.matchAll(/ref=\{(\w+)\}/g)].map((m) => m[1]!))) {
    if (forwarded.has(ref)) continue;
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
