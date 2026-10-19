// The registry's tool names, read from the tool files as text, for a lint that
// must not load the registry. One reader, so two lints cannot disagree on what
// is registered (#7388: the tools moved from one file to a folder of them).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TOOL_DIR = join("packages", "workspace-tools", "src", "tools");

/** Each tool file's own `name: "<tool>"`, at the top level of its object. */
export function registeredToolNames(root = "."): string[] {
  const dir = join(root, TOOL_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.includes(".test."))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^ {2}name:\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!));
}
