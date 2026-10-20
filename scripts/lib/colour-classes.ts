// Which colour classes in a source file Tailwind cannot draw (#7058). Read by
// lint:colour-classes-exist and its test.
import { createRequire } from "node:module";
import { join } from "node:path";

/** A class that sets a colour: a colour utility, any variants before it. */
const COLOUR_CLASS = /^(?:[a-z0-9-]+:)*!?(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|from|via|to|fill|stroke|divide|outline|decoration|placeholder|caret|accent|shadow)-[a-z]+(?:-\d+)?(?:\/\d+)?$/;
/** A string's own quotes; a template literal may span lines. */
const STRING = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
const OPT_OUT = /colour-class-ok: \S/;

export interface DeadClass {
  line: number;
  cls: string;
}

/** Whether Tailwind, with the web app's own config, draws each class. */
export function tailwindDraws(root: string): (cls: string) => boolean {
  const web = join(root, "web");
  const req = createRequire(join(web, "package.json"));
  const resolveConfig = req("tailwindcss/resolveConfig");
  const { createContext } = req("tailwindcss/lib/lib/setupContextUtils");
  const config = req(join(web, "tailwind.config.js"));
  const ctx = createContext(resolveConfig(config.default ?? config));
  const seen = new Map<string, boolean>();
  return (cls) => {
    let drawn = seen.get(cls);
    if (drawn === undefined) {
      drawn = ctx.getClassOrder([cls])[0][1] !== null;
      seen.set(cls, drawn);
    }
    return drawn;
  };
}

/**
 * Every colour class in `src` that Tailwind does not draw. Only a string that
 * also holds a class Tailwind draws is a class list: "text-delta" (a stream's
 * event name) and "fill-known" (an action's id) stand alone, and are not.
 * `prose-*` variants belong to lint:prose-is-styled.
 */
export function deadColourClasses(src: string, draws: (cls: string) => boolean): DeadClass[] {
  const out: DeadClass[] = [];
  const lines = src.split("\n");
  for (const m of src.matchAll(STRING)) {
    const tokens = [...m[0].slice(1, -1).matchAll(/\S+/g)];
    if (!tokens.some((t) => draws(t[0]))) continue;
    for (const t of tokens) {
      const cls = t[0];
      if (!COLOUR_CLASS.test(cls) || /(^|:)prose-/.test(cls) || draws(cls)) continue;
      const line = src.slice(0, (m.index ?? 0) + 1 + (t.index ?? 0)).split("\n").length;
      if (!OPT_OUT.test(lines[line - 1] ?? "")) out.push({ line, cls });
    }
  }
  return out;
}
