// Lets plain `node` run a lint written in TypeScript: Node strips the types
// itself, but it resolves imports literally, and this repo's TypeScript
// imports its siblings as `./x.js` (the compiled name) or without an
// extension. When the literal specifier is missing, try the .ts/.tsx source.
// Only relative and absolute specifiers; a package resolves as it always did.
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      const code = e?.code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw e;
      if (!/^(\.|\/|file:)/.test(spec)) throw e;
      const alts = /\.[cm]?js$/.test(spec)
        ? [spec.replace(/\.([cm]?)js$/, ".$1ts"), spec.replace(/\.js$/, ".tsx")]
        : [`${spec}.ts`, `${spec}.tsx`, `${spec}/index.ts`, `${spec}.js`];
      for (const alt of alts) {
        try {
          return next(alt, ctx);
        } catch {}
      }
      throw e;
    }
  },
});
