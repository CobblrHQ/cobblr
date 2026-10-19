// The boot passes, read the way boot() runs them: every `T("<label>", fn(...))`
// in api/src/index.ts, and every descriptor in api/src/platform/boot/ (a
// bootPass({ name, phase, run: () => fn(...) }), #7387). Each is resolved to
// the file its function is imported from, so a lint that judges a pass reads
// the registry rather than a list in index.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface BootPassRef {
  /** The [bootphase] label. */
  label: string;
  /** The function the pass calls. */
  fn: string;
  /** The file that function is imported from, absolute; null when it is not a relative import. */
  file: string | null;
  /** The descriptor under api/src/platform/boot/, or null for a pass index.ts times itself. */
  descriptor: string | null;
  phase: string | null;
}

/** Local name -> the .ts file it is imported from, for a file's relative imports. Pure. */
export function relativeImports(src: string, fromFile: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)\.js"/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) out.set(name, resolve(dirname(fromFile), `${m[2]}.ts`));
    }
  }
  return out;
}

/** The passes index.ts times itself. Pure. */
export function indexPasses(src: string, indexPath: string): BootPassRef[] {
  const imports = relativeImports(src, indexPath);
  return [...src.matchAll(/T\("([A-Za-z0-9_]+)",\s*([A-Za-z0-9_]+)\(/g)].map((m) => ({
    label: m[1]!,
    fn: m[2]!,
    file: imports.get(m[2]!) ?? null,
    descriptor: null,
    phase: null,
  }));
}

/** One descriptor's pass. Pure. */
export function descriptorPass(src: string, descriptorPath: string): BootPassRef | null {
  const label = src.match(/\bname:\s*"([^"]+)"/)?.[1];
  const phase = src.match(/\bphase:\s*"([^"]+)"/)?.[1] ?? null;
  const fn = src.match(/\brun:\s*(?:async\s*)?\(\)\s*=>\s*(?:await\s+)?([A-Za-z0-9_]+)\(/)?.[1] ?? src.match(/\brun:\s*([A-Za-z0-9_]+)\s*[,}\n]/)?.[1];
  if (!label || !fn) return null;
  return { label, fn, file: relativeImports(src, descriptorPath).get(fn) ?? null, descriptor: descriptorPath, phase };
}

/** Every boot pass under a repo root: index.ts's own, then the registry's. */
export function bootPassRefs(root = "."): BootPassRef[] {
  const index = join(root, "api/src/index.ts");
  const out: BootPassRef[] = existsSync(index) ? indexPasses(readFileSync(index, "utf8"), index) : [];
  const dir = join(root, "api/src/platform/boot");
  if (existsSync(dir))
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !/\.(test|d)\.ts$/.test(n)).sort()) {
      const p = join(dir, f);
      const ref = descriptorPass(readFileSync(p, "utf8"), p);
      if (ref) out.push(ref);
    }
  return out;
}
